// `ay lanes` — address agents by a stable lane name that survives wrapper restarts.
//
// A lane is a name bound to a working directory (and optionally a host). The lane's
// agent is the newest live agent whose cwd is exactly that directory. When several
// lanes share one cwd, the agent whose prompt says "You are the [<name>" wins.
//
// Registry: $AY_LANES_FILE, else ~/.config/agent-yes/lanes.tsv. One lane per line:
//   name<TAB>cwd relative to $HOME<TAB>[host ssh alias; empty = this machine]
// Lines starting with # are comments.
import { spawn, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir, hostname } from "os";
import path from "path";

export interface Lane {
  name: string;
  rel: string;
  host: string;
}

export interface LiveAgent {
  started_at: number;
  pid: number;
  agent_id: string;
  cwd: string;
  /** "x" of "You are the [x" in the agent's prompt, or null */
  tag: string | null;
}

export type Resolution =
  | { ok: true; agent: LiveAgent }
  | { ok: false; code: 2 | 3 | 4; error: string };

export const HELP = `Usage: ay lanes <command>

Address agents by a stable lane name (survives wrapper restarts).

  ay lanes ls                       table: lane -> live pid / agent_id / cwd (/host)
  ay lanes id <name>                print the lane's live agent_id (exit 3 if none)
  ay lanes pid <name>               print the lane's live pid
  ay lanes send <name> <msg...> [-- <ay send flags>]
                                    ay send to the lane (e.g. -- --force)
  ay lanes resume <name>|--all [--dry-run] [--max-age 48h]
                                    restart a lane with no live agent from its newest
                                    Claude session: ay --detach claude -- --resume <id>

Registry: $AY_LANES_FILE, else ~/.config/agent-yes/lanes.tsv. Format, one lane per line:
  name<TAB>cwd relative to $HOME<TAB>[host ssh alias; empty = this machine]
A lane is the newest live agent whose cwd is exactly ~/<cwd>; when lanes share a cwd,
the agent whose prompt says "You are the [<name>" wins. Lanes on another host are
resolved there over ssh (ay lanes runs on that host with AY_LANES_LOCAL=1).
`;

export function lanesFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.AY_LANES_FILE || path.join(homedir(), ".config", "agent-yes", "lanes.tsv");
}

export function parseLanes(text: string): Lane[] {
  const out: Lane[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const f = line.replace(/\r$/, "").split("\t");
    if (f.length < 2 || !f[0] || !f[1]) continue;
    out.push({ name: f[0], rel: f[1], host: f[2] ?? "" });
  }
  return out;
}

/** "[shr@x]" / "shr@x" / "shr" -> "shr" */
export function normalizeName(name: string): string {
  return name.replace(/^\[/, "").replace(/\]$/, "").replace(/@.*$/, "");
}

export function promptTag(prompt: string | null | undefined): string | null {
  const m = /You are the \[([a-z0-9-]+)/.exec(prompt ?? "");
  return m ? m[1]! : null;
}

/** Live agents from `ay ls --json` records, newest first. */
export function parseLive(records: any[]): LiveAgent[] {
  return records
    .filter((r) => r && r.state !== "exited" && r.status !== "exited")
    .map((r) => ({
      started_at: Number(r.started_at) || 0,
      pid: Number(r.pid),
      agent_id: String(r.agent_id ?? ""),
      cwd: String(r.cwd ?? ""),
      tag: promptTag(r.prompt),
    }))
    .sort((a, b) => b.started_at - a.started_at);
}

/** The lane's agent among `live` (for `ls`: never refuses; picks tag match, else newest). */
export function pickForLs(lane: Lane, live: LiveAgent[], home: string): LiveAgent | null {
  const dir = path.join(home, lane.rel);
  const inDir = live.filter((a) => a.cwd === dir);
  return inDir.find((a) => a.tag === lane.name) ?? inDir[0] ?? null;
}

export function resolveLane(
  rawName: string,
  lanes: Lane[],
  live: LiveAgent[],
  home: string,
): Resolution {
  const name = normalizeName(rawName);
  const lane = lanes.find((l) => l.name === name);
  if (!lane) {
    // not registered: exactly one live agent tagged "[<name>" still resolves
    const tagged = live.filter((a) => a.tag === name);
    if (tagged.length === 1) return { ok: true, agent: tagged[0]! };
    if (tagged.length > 1)
      return {
        ok: false,
        code: 4,
        error:
          `several live agents are tagged [${name}]; refusing to pick one:\n` +
          tagged.map((a) => `  pid ${a.pid} id ${a.agent_id}`).join("\n"),
      };
    return {
      ok: false,
      code: 2,
      error: `unknown lane "${name}". Known: ${lanes.map((l) => l.name).join(" ")}`,
    };
  }
  const dir = path.join(home, lane.rel);
  const inDir = live.filter((a) => a.cwd === dir);
  const tagged = inDir.filter((a) => a.tag === name);
  const hits = tagged.length ? tagged : inDir;
  if (hits.length > 1)
    return {
      ok: false,
      code: 4,
      error:
        `${hits.length} live agents match "${name}" (cwd ~/${lane.rel}); refusing to pick one:\n` +
        hits.map((a) => `  pid ${a.pid} id ${a.agent_id}`).join("\n"),
    };
  if (hits.length === 0)
    return { ok: false, code: 3, error: `no live agent for "${name}" (cwd ~/${lane.rel}).` };
  return { ok: true, agent: hits[0]! };
}

/** Claude's project dir for a cwd: ~/.claude/projects/<cwd with / and . replaced by -> */
export function claudeProjectDir(cwd: string, home: string): string {
  return path.join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"));
}

export interface SessionPick {
  id: string;
  file: string;
  mtimeMs: number;
}

const TAIL_BYTES = 256 * 1024;

function tailText(file: string): string {
  try {
    const buf = readFileSync(file);
    return buf.subarray(Math.max(0, buf.length - TAIL_BYTES)).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * The session to resume for a lane: the newest *.jsonl in its Claude project dir.
 * When `shared` (several lanes use this cwd), prefer the session whose recent content
 * mentions "[<name>]" most; ties (and no mentions at all) fall back to newest.
 */
export function pickSession(projectDir: string, name: string, shared: boolean): SessionPick | null {
  let files: SessionPick[];
  try {
    files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const file = path.join(projectDir, f);
        return { id: f.slice(0, -".jsonl".length), file, mtimeMs: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return null;
  }
  if (!files.length) return null;
  if (!shared) return files[0]!;
  const needle = `[${name}]`;
  let best = files[0]!;
  let bestCount = 0;
  for (const f of files) {
    const count = tailText(f.file).split(needle).length - 1;
    if (count > bestCount) {
      best = f;
      bestCount = count;
    }
  }
  return best;
}

export function parseDuration(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) return null;
  const mult = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[(m[2] ?? "h") as "h"];
  return Number(m[1]) * mult;
}

export interface ResumePlan {
  lane: string;
  cwd: string;
  action: "resume" | "skip";
  reason?: string;
  session?: SessionPick;
}

/** What `resume` would do for each lane (pure apart from reading session files). */
export function planResume(
  targets: Lane[],
  allLanes: Lane[],
  live: LiveAgent[],
  home: string,
  maxAgeMs: number,
  now: number,
): ResumePlan[] {
  return targets.map((lane) => {
    const cwd = path.join(home, lane.rel);
    const r = resolveLane(lane.name, allLanes, live, home);
    // an agent tagged for ANOTHER lane in a shared cwd does not make this lane live
    if (r.ok && (r.agent.tag === null || r.agent.tag === lane.name))
      return { lane: lane.name, cwd, action: "skip", reason: `live (pid ${r.agent.pid})` };
    if (!r.ok && r.code === 4) return { lane: lane.name, cwd, action: "skip", reason: r.error };
    const shared = allLanes.filter((l) => l.rel === lane.rel).length > 1;
    const s = pickSession(claudeProjectDir(cwd, home), lane.name, shared);
    if (!s) return { lane: lane.name, cwd, action: "skip", reason: "no Claude session found" };
    const age = now - s.mtimeMs;
    if (age > maxAgeMs)
      return {
        lane: lane.name,
        cwd,
        action: "skip",
        reason: `newest session ${s.id} is ${Math.round(age / 3600e3)}h old (> --max-age)`,
        session: s,
      };
    return { lane: lane.name, cwd, action: "resume", session: s };
  });
}

export function resumeNote(name: string): string {
  return `[ay lanes resume] Lane [${name}] was restarted from its last session (the previous agent had exited). Continue where you left off.`;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function selfCmd(): string[] {
  const argv1 = process.argv[1];
  return argv1 && /\.(c|m)?[jt]s$/.test(argv1) ? [process.execPath, argv1] : [argv1 || "ay"];
}

function runSelf(args: string[], opts: { inherit?: boolean; cwd?: string } = {}) {
  const [cmd, ...pre] = selfCmd();
  return spawnSync(cmd!, [...pre, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readLive(): LiveAgent[] {
  const r = runSelf(["ls", "--json"]);
  try {
    return parseLive(JSON.parse(r.stdout || "[]"));
  } catch {
    return [];
  }
}

function lastKnown(rel: string, home: string): string {
  const r = runSelf(["ls", "--all", "--json"]);
  try {
    const recs = (JSON.parse(r.stdout || "[]") as any[])
      .filter((x) => x.cwd === path.join(home, rel))
      .sort((a, b) => Number(a.started_at) - Number(b.started_at));
    const l = recs.at(-1);
    return l ? `pid ${l.pid} id ${l.agent_id} (${l.exit_reason ?? l.status})` : "none";
  } catch {
    return "none";
  }
}

function isLocal(env = process.env): boolean {
  return !!(env.AY_LANES_LOCAL || env.LANE_LOCAL);
}

function remoteHost(lane: Lane | undefined): string | null {
  if (!lane || !lane.host || isLocal()) return null;
  return lane.host === hostname().split(".")[0] ? null : lane.host;
}

function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run `ay lanes ARGS` on HOST over ssh; lanes resolve there. */
function runRemote(host: string, args: string[], capture = false) {
  const cmd =
    `PATH=$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH ` +
    `AY_LANES_LOCAL=1 ay lanes ${args.map(shQuote).join(" ")}`;
  return spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, cmd], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function loadLanes(): Lane[] | null {
  const f = lanesFile();
  if (!existsSync(f)) {
    console.error(
      `ay lanes: no registry at ${f} (set AY_LANES_FILE or create it; see ay lanes help)`,
    );
    return null;
  }
  return parseLanes(readFileSync(f, "utf8"));
}

export async function cmdLanes(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }
  const lanes = loadLanes();
  if (!lanes) return 2;
  const home = homedir();
  const laneOf = (n: string) => lanes.find((l) => l.name === normalizeName(n));

  switch (sub) {
    case "ls": {
      const live = readLive();
      for (const l of lanes) {
        const h = remoteHost(l);
        if (h) {
          const r = runRemote(h, ["id", l.name], true);
          const id = r.status === 0 ? r.stdout.trim() : "-";
          console.log(`${l.name.padEnd(12)} ${id.padEnd(24)} ~/${l.rel} (${h})`);
          continue;
        }
        const a = pickForLs(l, live, home);
        console.log(
          `${l.name.padEnd(12)} ${(a ? `${a.pid} ${a.agent_id}` : "-").padEnd(24)} ~/${l.rel}`,
        );
      }
      return 0;
    }
    case "id":
    case "pid":
    case "send": {
      const name = rest[0];
      if (!name) {
        console.error(`ay lanes ${sub}: missing lane name`);
        return 1;
      }
      const h = remoteHost(laneOf(name));
      if (h) return runRemote(h, argv).status ?? 1;
      const r = resolveLane(name, lanes, readLive(), home);
      if (!r.ok) {
        const lane = laneOf(name);
        const extra =
          r.code === 3 && lane ? ` last known: ${lastKnown(lane.rel, home)}. Nothing sent.` : "";
        console.error(`ay lanes: ${r.error}${extra}`);
        return r.code;
      }
      if (sub === "id") console.log(r.agent.agent_id);
      else if (sub === "pid") console.log(r.agent.pid);
      else {
        const args = rest.slice(1);
        const dd = args.indexOf("--");
        const msg = (dd < 0 ? args : args.slice(0, dd)).join(" ");
        const flags = dd < 0 ? [] : args.slice(dd + 1);
        return runSelf(["send", r.agent.agent_id, msg, ...flags], { inherit: true }).status ?? 1;
      }
      return 0;
    }
    case "resume": {
      let all = false;
      let dryRun = false;
      let maxAgeMs = 48 * 3600e3;
      const names: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--all") all = true;
        else if (a === "--dry-run" || a === "-n") dryRun = true;
        else if (a === "--max-age" || a.startsWith("--max-age=")) {
          const v = a.includes("=") ? a.split("=")[1]! : rest[++i];
          const ms = v ? parseDuration(v) : null;
          if (ms == null) {
            console.error(`ay lanes resume: bad --max-age "${v}" (e.g. 48h, 2d, 90m)`);
            return 1;
          }
          maxAgeMs = ms;
        } else names.push(a);
      }
      if (!all && !names.length) {
        console.error("ay lanes resume: give a lane name or --all");
        return 1;
      }
      const passOn = [...(dryRun ? ["--dry-run"] : []), "--max-age", `${maxAgeMs}ms`];
      let rc = 0;
      // remote lanes: run there (named ones only; --all covers this host's lanes)
      const local: Lane[] = [];
      for (const n of names) {
        const lane = laneOf(n);
        if (!lane) {
          console.error(`ay lanes: unknown lane "${normalizeName(n)}"`);
          rc = 2;
          continue;
        }
        const h = remoteHost(lane);
        if (h) rc = runRemote(h, ["resume", lane.name, ...passOn]).status || rc;
        else local.push(lane);
      }
      if (all) local.push(...lanes.filter((l) => !remoteHost(l) && !local.includes(l)));
      const plans = planResume(local, lanes, readLive(), home, maxAgeMs, Date.now());
      for (const p of plans) {
        if (p.action === "skip") {
          console.log(`${p.lane}: skip — ${p.reason}`);
          continue;
        }
        const args = ["--detach", "claude", "--", "--resume", p.session!.id, resumeNote(p.lane)];
        console.log(
          `${p.lane}: ${dryRun ? "would run" : "run"} (cwd ${p.cwd}) ay ${args.map(shQuote).join(" ")}`,
        );
        if (dryRun) continue;
        const [cmd, ...pre] = selfCmd();
        const child = spawn(cmd!, [...pre, ...args], { cwd: p.cwd, stdio: "inherit" });
        const code = await new Promise<number>((res) => child.on("close", (c) => res(c ?? 1)));
        if (code !== 0) {
          console.error(`${p.lane}: ay --detach exited ${code}`);
          rc = code;
        }
      }
      return rc;
    }
    default:
      console.error(`ay lanes: unknown command "${sub}"\n`);
      process.stdout.write(HELP);
      return 1;
  }
}
