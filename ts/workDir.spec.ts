import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commandDirs,
  isWithin,
  pickObserved,
  readSelfReport,
  resolveWorkDir,
  resolveWorkDirs,
  transcriptSignals,
  writeSelfReport,
  clearSelfReport,
} from "./workDir.ts";

const HOME = "/home/alice";
const SPAWN = "/repo/alpha/tree/main";

describe("commandDirs", () => {
  it("picks up a leading cd / pushd / git -C", () => {
    expect(commandDirs("cd /repo/alpha/tree/feat-x && bun test", SPAWN, HOME)).toEqual([
      "/repo/alpha/tree/feat-x",
    ]);
    expect(commandDirs("pushd /repo/beta; ls", SPAWN, HOME)).toEqual(["/repo/beta"]);
    expect(commandDirs("git -C /repo/beta status", SPAWN, HOME)).toEqual(["/repo/beta"]);
  });

  it("expands ~ and $HOME, resolves relative targets against the spawn dir", () => {
    expect(commandDirs("cd ~/ws/x && ls", SPAWN, HOME)).toEqual(["/home/alice/ws/x"]);
    expect(commandDirs('cd "$HOME/ws/y" && ls', SPAWN, HOME)).toEqual(["/home/alice/ws/y"]);
    expect(commandDirs("cd ../feat-y && ls", SPAWN, HOME)).toEqual(["/repo/alpha/tree/feat-y"]);
  });

  it("handles quoting and finds a cd after a separator", () => {
    expect(commandDirs("echo hi && cd '/repo/with space' && ls", SPAWN, HOME)).toEqual([
      "/repo/with space",
    ]);
  });

  it("skips targets it can't place and cd mentioned mid-word / in args", () => {
    expect(commandDirs("cd - && ls", SPAWN, HOME)).toEqual([]);
    expect(commandDirs("cd $WT && ls", SPAWN, HOME)).toEqual([]);
    expect(commandDirs("echo abcd /tmp", SPAWN, HOME)).toEqual([]);
    expect(commandDirs("grep -n 'cd /x' file", SPAWN, HOME)).toEqual([]);
  });
});

function toolUse(at: string, name: string, input: object): string {
  return JSON.stringify({
    timestamp: at,
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, input }],
    },
  });
}

describe("transcriptSignals", () => {
  it("collects Bash cd targets and written files' dirs, with timestamps", () => {
    const lines = [
      toolUse("2026-01-01T00:00:00Z", "Bash", {
        command: "cd /repo/alpha/tree/feat-x && git status",
      }),
      toolUse("2026-01-01T00:01:00Z", "Edit", {
        file_path: "/repo/alpha/tree/feat-x/src/a.ts",
      }),
      toolUse("2026-01-01T00:02:00Z", "Read", {
        file_path: "/repo/other/README.md",
      }),
      '{"type":"user","message":{"content":"plain text"}}',
      "{not json",
    ];
    expect(transcriptSignals(lines, SPAWN, HOME)).toEqual([
      {
        path: "/repo/alpha/tree/feat-x",
        at: Date.parse("2026-01-01T00:00:00Z"),
      },
      {
        path: "/repo/alpha/tree/feat-x/src",
        at: Date.parse("2026-01-01T00:01:00Z"),
      },
    ]);
  });
});

describe("pickObserved", () => {
  it("returns null with no signals", () => {
    expect(pickObserved([])).toBeNull();
  });

  it("a single stray signal doesn't flip a lane that works elsewhere", () => {
    const s = [1, 2, 3, 4, 5].map((at) => ({ path: "/repo/a", at }));
    s.push({ path: "/repo/b", at: 6 });
    expect(pickObserved(s)).toEqual({ path: "/repo/a", at: 5 });
  });

  it("a lane that moved on wins after a few calls in the new place", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8].map((at) => ({ path: "/repo/a", at }));
    for (const at of [9, 10, 11, 12, 13]) s.push({ path: "/repo/b", at });
    expect(pickObserved(s)?.path).toBe("/repo/b");
  });
});

describe("resolveWorkDir precedence", () => {
  const self = { path: "/repo/alpha/tree/feat-x", at: 100 };

  it("falls back to the spawn dir with no signals", () => {
    expect(resolveWorkDir({ spawn: SPAWN, self: null, observed: null })).toEqual({
      workdir: SPAWN,
      workdir_source: "spawn",
      workdir_at: null,
    });
  });

  it("observed beats spawn", () => {
    const observed = { path: "/repo/beta", at: 50 };
    expect(resolveWorkDir({ spawn: SPAWN, self: null, observed }).workdir_source).toBe("observed");
  });

  it("observed root that contains the spawn dir is not news", () => {
    const observed = { path: "/repo/alpha/tree/main", at: 50 };
    expect(
      resolveWorkDir({
        spawn: "/repo/alpha/tree/main/lib/x",
        self: null,
        observed,
      }),
    ).toMatchObject({
      workdir: "/repo/alpha/tree/main/lib/x",
      workdir_source: "spawn",
    });
  });

  it("self beats older observed, and newer observed inside the reported tree", () => {
    expect(
      resolveWorkDir({
        spawn: SPAWN,
        self,
        observed: { path: "/repo/beta", at: 50 },
      }).workdir_source,
    ).toBe("self");
    expect(
      resolveWorkDir({
        spawn: SPAWN,
        self,
        observed: { path: "/repo/alpha/tree/feat-x/lib/y", at: 200 },
      }).workdir_source,
    ).toBe("self");
  });

  it("a newer observed root outside the reported tree wins (the lane moved on)", () => {
    expect(
      resolveWorkDir({
        spawn: SPAWN,
        self,
        observed: { path: "/repo/beta", at: 200 },
      }),
    ).toEqual({
      workdir: "/repo/beta",
      workdir_source: "observed",
      workdir_at: 200,
    });
  });

  it("isWithin is path-segment aware", () => {
    expect(isWithin("/repo/a/b", "/repo/a")).toBe(true);
    expect(isWithin("/repo/a", "/repo/a")).toBe(true);
    expect(isWithin("/repo/ab", "/repo/a")).toBe(false);
  });
});

describe("resolveWorkDirs (I/O)", () => {
  let root: string;
  const saved = {
    home: process.env.AGENT_YES_HOME,
    claude: process.env.CLAUDE_CONFIG_DIR,
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "ay-workdir-")));
    process.env.AGENT_YES_HOME = path.join(root, "ay");
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.AGENT_YES_HOME;
    else process.env.AGENT_YES_HOME = saved.home;
    if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.claude;
  });

  const gitRoot = async (dir: string) => {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: dir,
        stdio: "pipe",
      })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };

  it("self-report round-trips and clears", async () => {
    const agent = { pid: 1111, started_at: 7 };
    expect(await readSelfReport(agent)).toBeNull();
    await writeSelfReport(agent, "/repo/alpha", 42);
    expect(await readSelfReport(agent)).toEqual({ path: "/repo/alpha", at: 42 });
    // a later agent that reuses the pid doesn't inherit the report
    expect(await readSelfReport({ pid: 1111, started_at: 8 })).toBeNull();
    await clearSelfReport(1111);
    expect(await readSelfReport(agent)).toBeNull();
  });

  it("follows the claude transcript of the agent's process tree to the worked-in repo", async () => {
    const spawn = path.join(root, "spawn");
    const wt = path.join(root, "wt");
    mkdirSync(spawn);
    mkdirSync(path.join(wt, "src"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: wt });
    // This test process stands in for both the wrapper and its claude child
    // (descendantsOf is inclusive), so its own pid owns the session.
    const sid = "00000000-0000-4000-8000-000000000001";
    mkdirSync(path.join(root, "claude", "sessions"), { recursive: true });
    writeFileSync(
      path.join(root, "claude", "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: sid, cwd: spawn }),
    );
    const proj = path.join(root, "claude", "projects", spawn.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(proj, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      path.join(proj, `${sid}.jsonl`),
      [
        toolUse(now, "Bash", { command: `cd ${wt}/src && bun test` }),
        toolUse(now, "Edit", { file_path: path.join(wt, "src", "a.ts") }),
      ].join("\n") + "\n",
    );

    const rec = { pid: process.pid, started_at: 1, cli: "claude", cwd: spawn };
    const got = (await resolveWorkDirs([rec], gitRoot)).get(process.pid)!;
    expect(got.workdir).toBe(wt);
    expect(got.workdir_source).toBe("observed");

    // a self-report newer than the transcript wins
    const other = path.join(root, "other");
    mkdirSync(other);
    await writeSelfReport(rec, other, Date.now() + 60_000);
    const got2 = (await resolveWorkDirs([rec], gitRoot)).get(process.pid)!;
    expect(got2).toMatchObject({ workdir: other, workdir_source: "self" });
  });

  it("ignores a self-report whose dir is gone, and non-claude agents fall back to spawn", async () => {
    await writeSelfReport({ pid: 2222, started_at: 1 }, path.join(root, "deleted"));
    const got = (
      await resolveWorkDirs(
        [{ pid: 2222, started_at: 1, cli: "codex", cwd: "/repo/alpha" }],
        gitRoot,
      )
    ).get(2222)!;
    expect(got).toEqual({
      workdir: "/repo/alpha",
      workdir_source: "spawn",
      workdir_at: null,
    });
  });
});
