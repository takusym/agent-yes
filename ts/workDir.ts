import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import path from "path";
import { agentYesHome } from "./agentYesHome.ts";
import { buildChildIndex, descendantsOf, snapshotProcs, type ProcSample } from "./procStats.ts";

/**
 * Where an agent actually WORKS, as opposed to where it was spawned.
 *
 * A lane is often launched in one (trusted) dir and told to `cd` into its own
 * worktree. The wrapped CLI's process cwd never changes after spawn, and
 * claude's Bash tool resets to the project dir between calls, so lanes run
 * `cd <worktree> && …` per call — the registry's `cwd` keeps pointing at the
 * spawn dir and `ay ls` can't tell seven such lanes apart.
 *
 * Three signals, in precedence order:
 *   1. self   — the agent ran `ay cwd [path]` (explicit, timestamped).
 *   2. observed — the git roots its recent tool calls targeted, read from the
 *      claude transcript (`cd X && …`, `git -C X`, Edit/Write file paths).
 *      OS-neutral: no /proc needed, works on macOS too.
 *   3. spawn  — the registry's `cwd`.
 * A self-report loses only to an observed root that is NEWER than it and lies
 * outside the reported tree (the lane moved on and didn't re-report).
 */

export type WorkDirSource = "self" | "observed" | "spawn";

export interface WorkDir {
  workdir: string;
  workdir_source: WorkDirSource;
  /** epoch ms of the signal that won; null for spawn. */
  workdir_at: number | null;
}

export interface TimedPath {
  path: string;
  at: number;
}

// ---------------------------------------------------------------------------
// self-report store: <agentYesHome>/workdir/<pid>.json — one file per agent so
// concurrent `ay cwd` calls from different lanes never race on a shared file.
// The report is bound to the agent's registration time (`started_at`), so a
// later agent that reuses the pid never inherits a dead agent's work dir.
// ---------------------------------------------------------------------------

/** The registry identity a self-report belongs to. */
export interface AgentKey {
  pid: number;
  started_at: number;
}

function selfReportPath(pid: number): string {
  return path.join(agentYesHome(), "workdir", `${pid}.json`);
}

export async function readSelfReport(agent: AgentKey): Promise<TimedPath | null> {
  try {
    const j = JSON.parse(await readFile(selfReportPath(agent.pid), "utf-8"));
    if (
      typeof j?.path === "string" &&
      typeof j?.at === "number" &&
      j?.started_at === agent.started_at
    )
      return { path: j.path, at: j.at };
  } catch {
    /* none */
  }
  return null;
}

export async function writeSelfReport(
  agent: AgentKey,
  dir: string,
  now = Date.now(),
): Promise<void> {
  const p = selfReportPath(agent.pid);
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ path: dir, at: now, started_at: agent.started_at }) + "\n");
  await rename(tmp, p);
}

export async function clearSelfReport(pid: number): Promise<void> {
  await rm(selfReportPath(pid), { force: true });
}

// ---------------------------------------------------------------------------
// transcript → path signals (pure)
// ---------------------------------------------------------------------------

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

function unquote(tok: string): string {
  const m = /^"(.*)"$|^'(.*)'$/.exec(tok);
  return m ? (m[1] ?? m[2] ?? "") : tok;
}

/**
 * Directories a shell command steps into: `cd X`, `pushd X`, `git -C X` at a
 * command boundary. Relative targets resolve against `base` (the dir claude's
 * Bash tool starts every call in — the spawn cwd). `cd -` / `cd` alone / paths
 * with unexpanded `$VAR`s are skipped: we can't know where they land.
 */
export function commandDirs(command: string, base: string, home = homedir()): string[] {
  const out: string[] = [];
  const tok = String.raw`("[^"]*"|'[^']*'|[^\s;&|()]+)`;
  const re = new RegExp(
    String.raw`(?:^|[;&|(\n]|&&|\|\|)\s*(?:(?:cd|pushd)\s+${tok}|git\s+-C\s+${tok})`,
    "g",
  );
  for (const m of command.matchAll(re)) {
    const raw = unquote(m[1] ?? m[2] ?? "");
    if (!raw || raw === "-") continue;
    const p = expandHome(raw, home);
    if (p.includes("$")) continue;
    out.push(path.resolve(base, p));
  }
  return out;
}

/**
 * Pull timestamped directory signals out of claude transcript JSONL lines.
 * Bash commands contribute their `cd`/`git -C` targets; file-writing tools
 * contribute the file's directory. Read-only tools are ignored — a lane reads
 * briefs and other repos all the time without working there.
 */
export function transcriptSignals(lines: string[], base: string, home = homedir()): TimedPath[] {
  const out: TimedPath[] = [];
  for (const line of lines) {
    if (!line.includes('"tool_use"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(entry?.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (c?.type !== "tool_use") continue;
      const input = c.input ?? {};
      if (c.name === "Bash" && typeof input.command === "string") {
        for (const d of commandDirs(input.command, base, home)) out.push({ path: d, at });
      } else if (FILE_TOOLS.has(c.name)) {
        const fp = input.file_path ?? input.notebook_path;
        if (typeof fp === "string" && path.isAbsolute(fp)) out.push({ path: path.dirname(fp), at });
      }
    }
  }
  return out;
}

/**
 * Pick the root the agent is working in from its (already root-normalized)
 * signals, oldest→newest. Recency-weighted vote over the last `window`
 * signals, so one stray `git -C ~/other log` doesn't flip the answer but a
 * lane that has moved on wins after a handful of calls in the new place.
 */
export function pickObserved(signals: TimedPath[], window = 40, decay = 0.85): TimedPath | null {
  const recent = signals.slice(-window);
  if (recent.length === 0) return null;
  const score = new Map<string, number>();
  const last = new Map<string, number>();
  recent.forEach((s, i) => {
    const w = Math.pow(decay, recent.length - 1 - i);
    score.set(s.path, (score.get(s.path) ?? 0) + w);
    last.set(s.path, Math.max(last.get(s.path) ?? 0, s.at));
  });
  let best: string | null = null;
  for (const [p, sc] of score) {
    if (
      best === null ||
      sc > score.get(best)! ||
      (sc === score.get(best)! && last.get(p)! > last.get(best)!)
    )
      best = p;
  }
  return best === null ? null : { path: best, at: last.get(best)! };
}

export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Precedence: self > observed > spawn. A self-report is overridden only by an
 * observed root newer than it that lies outside the reported tree. An observed
 * root that merely contains the spawn dir (the lane works in the repo it was
 * spawned in) is not news — the spawn cwd is the more precise answer.
 */
export function resolveWorkDir(input: {
  spawn: string;
  self: TimedPath | null;
  observed: TimedPath | null;
}): WorkDir {
  const { spawn, self, observed } = input;
  const obs = observed && !isWithin(spawn, observed.path) ? observed : null;
  if (self) {
    if (obs && obs.at > self.at && !isWithin(obs.path, self.path))
      return {
        workdir: obs.path,
        workdir_source: "observed",
        workdir_at: obs.at,
      };
    return { workdir: self.path, workdir_source: "self", workdir_at: self.at };
  }
  if (obs)
    return {
      workdir: obs.path,
      workdir_source: "observed",
      workdir_at: obs.at,
    };
  return { workdir: spawn, workdir_source: "spawn", workdir_at: null };
}

// ---------------------------------------------------------------------------
// I/O: locate an agent's claude transcript and read its tail
// ---------------------------------------------------------------------------

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude");
}

interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
}

async function readClaudeSessions(): Promise<Map<number, ClaudeSession>> {
  const dir = path.join(claudeConfigDir(), "sessions");
  const out = new Map<number, ClaudeSession>();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return out;
  }
  await Promise.all(
    names.map(async (n) => {
      try {
        const j = JSON.parse(await readFile(path.join(dir, n), "utf-8"));
        if (typeof j?.pid === "number" && typeof j?.sessionId === "string")
          out.set(j.pid, {
            pid: j.pid,
            sessionId: j.sessionId,
            cwd: String(j.cwd ?? ""),
          });
      } catch {
        /* torn / foreign file */
      }
    }),
  );
  return out;
}

async function findTranscript(s: ClaudeSession): Promise<string | null> {
  const projects = path.join(claudeConfigDir(), "projects");
  const direct = path.join(projects, s.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${s.sessionId}.jsonl`);
  if (
    await stat(direct).then(
      () => true,
      () => false,
    )
  )
    return direct;
  // Long cwds get a hashed dir name; fall back to scanning project dirs.
  try {
    for (const d of await readdir(projects)) {
      const p = path.join(projects, d, `${s.sessionId}.jsonl`);
      if (
        await stat(p).then(
          () => true,
          () => false,
        )
      )
        return p;
    }
  } catch {
    /* no projects dir */
  }
  return null;
}

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

async function readTailLines(file: string): Promise<string[]> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const lines = buf.toString("utf-8").split("\n");
    if (size > len) lines.shift(); // partial first line
    return lines;
  } finally {
    await fh.close();
  }
}

/** git toplevel of `dir`, or null when it isn't in a repo / doesn't exist. */
export type GitRootFn = (dir: string) => Promise<string | null>;

export interface WorkDirRecord extends AgentKey {
  cli: string;
  cwd: string;
}

/**
 * Resolve the effective work dir for each record. `gitRoot` is injected so
 * callers can share their per-invocation git cache. Never throws: any failure
 * degrades that record to its spawn cwd.
 */
export async function resolveWorkDirs(
  records: WorkDirRecord[],
  gitRoot: GitRootFn,
): Promise<Map<number, WorkDir>> {
  const out = new Map<number, WorkDir>();
  if (records.length === 0) return out;
  const needTranscript = records.some((r) => r.cli === "claude");
  const [sessions, procs] = needTranscript
    ? await Promise.all([
        readClaudeSessions(),
        snapshotProcs().catch(() => new Map<number, ProcSample>()),
      ])
    : [new Map<number, ClaudeSession>(), new Map<number, ProcSample>()];
  const kids = buildChildIndex(procs);

  await Promise.all(
    records.map(async (r) => {
      try {
        const selfRaw = await readSelfReport(r);
        const self =
          selfRaw &&
          (await stat(selfRaw.path).then(
            (s) => s.isDirectory(),
            () => false,
          ))
            ? selfRaw
            : null;
        let observed: TimedPath | null = null;
        if (r.cli === "claude" && sessions.size > 0) {
          const session = [...descendantsOf(r.pid, kids)].map((p) => sessions.get(p)).find(Boolean);
          const file = session ? await findTranscript(session) : null;
          if (file) {
            // Only the recent past votes (see pickObserved); bound the git calls.
            const raw = transcriptSignals(await readTailLines(file), r.cwd).slice(-80);
            // Signals repeat the same few dirs: one concurrent lookup per dir.
            const dirs = [...new Set(raw.map((s) => s.path))];
            const roots = new Map(
              await Promise.all(dirs.map(async (d) => [d, await gitRoot(d)] as const)),
            );
            const rooted: TimedPath[] = [];
            for (const s of raw) {
              const root = roots.get(s.path);
              if (root) rooted.push({ path: root, at: s.at });
            }
            observed = pickObserved(rooted);
          }
        }
        out.set(r.pid, resolveWorkDir({ spawn: r.cwd, self, observed }));
      } catch {
        out.set(r.pid, {
          workdir: r.cwd,
          workdir_source: "spawn",
          workdir_at: null,
        });
      }
    }),
  );
  return out;
}
