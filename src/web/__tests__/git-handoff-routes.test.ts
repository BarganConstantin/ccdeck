// The hand-off routes through the real server: which apps the page is told
// about, and opening one on a session's folder — a folder found from the
// session, never named by the request, a file only inside its repository, and
// never for a browser that is not on this machine or while git is switched off.
// The launcher is replaced, so nothing opens on the machine running the suite.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { repoWith, sh, tempDir, write } from "./git-fixture";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-git-handoff-"));
const KEYS = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"] as const;
const prevEnv = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");

// @ts-expect-error — plain .mjs server module, no types
const { startServer, hookToken } = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { GUARDED_READS } = await import("../../server/request-gates.mjs");
// @ts-expect-error — plain .mjs server module, no types
const routes = await import("../../server/git-handoff-routes.mjs");

type Launch = { file: string; args: string[]; opts: { cwd: string; env: Record<string, string>; ownGroup: boolean } };
const launched: Launch[] = [];
const made: string[] = [];
const track = (d: string) => { made.push(d); return d; };

let server: Server;
let port = 0;
let repo = "";
let sub = "";
let plain = "";
let bin = "";
let apps: { id: string; slot: string; name: string; target: { kind: string; path: string } }[] = [];

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "Content-Type": "application/json", ...headers } }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        let parsed: any = null;
        try { parsed = JSON.parse(out); } catch { /* status is enough */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const auth = { "x-ccdeck-token": "" };
const event = (payload: Record<string, unknown>) => call("POST", "/api/event", payload);
const handoffs = (headers: Record<string, string> = {}) => call("GET", "/api/git/handoffs", undefined, { ...auth, ...headers });
const open = (body: Record<string, unknown>, headers: Record<string, string> = {}) => call("POST", "/api/git/open", body, { ...auth, ...headers });
const prefs = (body: Record<string, unknown>) => call("POST", "/api/prefs", body, auth);

// A browser on this machine, as the deck's own page sends it.
const page = () => ({
  origin: `http://127.0.0.1:${port}`,
  "sec-fetch-site": "same-origin",
  "user-agent": process.platform === "darwin"
    ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    : process.platform === "win32"
      ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
      : "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
});
const OTHER_OS_UA = process.platform === "darwin"
  ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
  : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

// A terminal each OS's launch knows, and the arguments it is opened with.
const TERMINAL = process.platform === "darwin"
  ? { id: "terminal", app: (path: string) => ({ id: "terminal", slot: "terminal", name: "Terminal", target: { kind: "app", path } }), args: (f: string, path: string) => ["-a", path, f] }
  : process.platform === "win32"
    ? { id: "windows-terminal", app: (path: string) => ({ id: "windows-terminal", slot: "terminal", name: "Windows Terminal", target: { kind: "exe", path } }), args: (f: string) => ["-d", f] }
    : { id: "kitty", app: (path: string) => ({ id: "kitty", slot: "terminal", name: "kitty", target: { kind: "exe", path } }), args: (f: string) => ["--directory", f] };

/** A program file the faked detection points at, so the "still there" check holds. */
function program(name: string): string {
  const p = join(bin, name);
  writeFileSync(p, "");
  return p;
}

/** Every file under `dir`, with its modification time — what a launch must not change. */
function snapshot(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else out[full] = st.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

beforeAll(async () => {
  repo = track(repoWith({ "a.txt": "one\n", "src/app.ts": "export {};\n" }));
  sub = join(repo, "src");
  write(repo, { "a.txt": "two\n" });
  plain = track(tempDir("ccdeck-git-handoff-plain-"));
  bin = track(tempDir("ccdeck-git-handoff-bin-"));
  const outside = track(tempDir("ccdeck-git-handoff-outside-"));
  writeFileSync(join(outside, "secret.txt"), "not yours\n");
  if (process.platform !== "win32") symlinkSync(join(outside, "secret.txt"), join(repo, "escape.txt"));
  apps = [
    { id: "fork", slot: "git", name: "Fork", target: { kind: "exe", path: program("fork") } },
    { id: "vscode", slot: "editor", name: "VS Code", target: { kind: "exe", path: program("code") } },
    { id: "zed", slot: "editor", name: "Zed", target: { kind: "exe", path: program("zed") } },
    TERMINAL.app(program(TERMINAL.id)),
  ];
  routes.setHandoffDetector(async () => apps);
  routes.setHandoffLauncher((file: string, args: string[], opts: Launch["opts"]) => { launched.push({ file, args, opts }); });

  server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
  port = (server.address() as AddressInfo).port;
  auth["x-ccdeck-token"] = hookToken();
  await event({ hook_event_name: "SessionStart", session_id: "H-repo", cwd: repo });
  await event({ hook_event_name: "SessionStart", session_id: "H-sub", cwd: sub });
  await event({ hook_event_name: "SessionStart", session_id: "H-plain", cwd: plain });
  await event({ hook_event_name: "PreToolUse", session_id: "H-repo", cwd: plain, agent_id: "ag-1", tool_name: "Read" });
});

beforeEach(() => { launched.length = 0; });

afterAll(async () => {
  routes.setHandoffDetector(null);
  routes.setHandoffLauncher(null);
  await new Promise<void>(done => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
  for (const k of KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  for (const d of made) rmTempDir(d);
  rmTempDir(DIR);
});

describe("who may ask", () => {
  it("guards the read like the git view's other reads", async () => {
    expect(GUARDED_READS.has("/api/git/handoffs")).toBe(true);
    expect((await call("GET", "/api/git/handoffs")).status).toBe(401);
  });

  it("refuses a launch that presents nothing, before it is even read", async () => {
    expect((await call("POST", "/api/git/open", { session: "H-repo", slot: "editor" })).status).toBe(401);
    expect(launched).toEqual([]);
  });
});

describe("GET /api/git/handoffs", () => {
  it("lists each slot's apps, the default chosen, and says the page is on this machine", async () => {
    const r = await handoffs(page());
    expect(r.status).toBe(200);
    expect(r.body.local).toBe(true);
    expect(typeof r.body.machine).toBe("string");
    expect(r.body.slots).toEqual({
      git: { apps: [{ id: "fork", name: "Fork" }], chosen: "fork" },
      editor: { apps: [{ id: "vscode", name: "VS Code" }, { id: "zed", name: "Zed" }], chosen: "vscode" },
      terminal: { apps: [{ id: TERMINAL.id, name: apps[3].name }], chosen: TERMINAL.id },
    });
    // Where the apps live is the server's business.
    expect(JSON.stringify(r.body)).not.toContain(bin);
  });

  it("tells a page that came through a proxy, or from another OS, that it is not", async () => {
    expect((await handoffs({ ...page(), "x-forwarded-for": "192.168.1.20" })).body.local).toBe(false);
    expect((await handoffs({ ...page(), "user-agent": OTHER_OS_UA })).body.local).toBe(false);
  });

  it("follows the pick made in Settings, and falls back when that app is gone", async () => {
    expect((await prefs({ gitApps: { editor: "zed" } })).status).toBe(200);
    expect((await handoffs()).body.slots.editor.chosen).toBe("zed");
    // A pick for one slot leaves the others as they were.
    await prefs({ gitApps: { terminal: TERMINAL.id } });
    const p = (await call("GET", "/api/prefs", undefined, auth)).body.prefs.gitApps;
    expect(p).toEqual({ git: "", editor: "zed", terminal: TERMINAL.id });
    await prefs({ gitApps: { editor: "cursor" } });
    expect((await handoffs()).body.slots.editor.chosen).toBe("vscode");
    await prefs({ gitApps: { editor: "", terminal: "" } });
  });
});

describe("POST /api/git/open", () => {
  it("opens the git client on the repository's top, from a session in a subfolder", async () => {
    const r = await open({ session: "H-sub", slot: "git" }, page());
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, app: { id: "fork", name: "Fork" } });
    expect(launched).toHaveLength(1);
    expect(launched[0].file).toBe(apps[0].target.path);
    expect(launched[0].args).toEqual([repo]);
    expect(launched[0].opts.cwd).toBe(repo);
    expect(launched[0].opts.ownGroup).toBe(true);
  });

  it("opens the editor on the session's own folder, and a file of its repository with it", async () => {
    expect((await open({ session: "H-sub", slot: "editor" })).status).toBe(200);
    expect(launched[0].args).toEqual([sub]);
    expect((await open({ session: "H-sub", slot: "editor", file: "a.txt" })).status).toBe(200);
    expect(launched[1].args).toEqual([sub, join(repo, "a.txt")]);
  });

  it("opens the terminal on the folder, repository or not", async () => {
    expect((await open({ session: "H-plain", slot: "terminal" })).status).toBe(200);
    expect(launched[0].args).toEqual(TERMINAL.args(plain, apps[3].target.path));
    expect(launched[0].opts.cwd).toBe(plain);
  });

  it("uses a subagent's own folder when it has one", async () => {
    expect((await open({ session: "H-repo", agent: "ag-1", slot: "terminal" })).status).toBe(200);
    expect(launched[0].args).toEqual(TERMINAL.args(plain, apps[3].target.path));
  });

  it("hands the app an environment without the deck's own markers", async () => {
    const before = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      await open({ session: "H-repo", slot: "editor" });
      expect(launched[0].opts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(launched[0].opts.env.PATH ?? launched[0].opts.env.Path).toBeTruthy();
    } finally {
      if (before === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = before;
    }
  });

  it("refuses a browser that is not on this machine, and launches nothing", async () => {
    for (const extra of [{ "x-forwarded-for": "192.168.1.20" }, { forwarded: "for=10.0.0.4" }, { "user-agent": OTHER_OS_UA }]) {
      const r = await open({ session: "H-repo", slot: "editor" }, { ...page(), ...extra });
      expect(r.status, JSON.stringify(extra)).toBe(403);
    }
    expect(launched).toEqual([]);
  });

  it("refuses everything while git is switched off", async () => {
    expect((await prefs({ git: false })).status).toBe(200);
    try {
      expect((await handoffs()).status).toBe(409);
      expect((await open({ session: "H-repo", slot: "editor" })).status).toBe(409);
      expect(launched).toEqual([]);
    } finally {
      expect((await prefs({ git: true })).body.prefs.git).toBe(true);
    }
    expect((await open({ session: "H-repo", slot: "editor" })).status).toBe(200);
  });

  it("keeps a file inside the repository", async () => {
    for (const file of ["../outside.txt", "src/../../x", "/etc/passwd", "C:\\Windows\\win.ini", "missing.txt", "a.txt\0.png"]) {
      expect((await open({ session: "H-repo", slot: "editor", file })).status, file).toBe(404);
    }
    if (process.platform !== "win32") {
      expect((await open({ session: "H-repo", slot: "editor", file: "escape.txt" })).status).toBe(404);
    }
    expect(launched).toEqual([]);
  });

  it("answers what was asked wrongly", async () => {
    expect((await open({ slot: "editor" })).status).toBe(400);
    expect((await open({ session: "H-repo", slot: "browser" })).status).toBe(400);
    expect((await open({ session: "H-repo", slot: "terminal", file: "a.txt" })).status).toBe(400);
    expect((await open({ session: "H-nobody", slot: "editor" })).status).toBe(404);
    expect((await open({ session: "H-plain", slot: "git" })).status).toBe(409);
    expect((await call("POST", "/api/git/open", "not json", auth)).status).toBe(400);
    expect(launched).toEqual([]);
  });

  it("says so when the slot has no app, or the app has gone since the last look", async () => {
    const saved = apps;
    try {
      apps = saved.filter(a => a.slot !== "git");
      routes.forgetHandoffApps();
      expect((await open({ session: "H-repo", slot: "git" })).status).toBe(409);
      const gone = join(bin, "gone-editor");
      apps = [{ id: "vscode", slot: "editor", name: "VS Code", target: { kind: "exe", path: gone } }];
      routes.forgetHandoffApps();
      const r = await open({ session: "H-repo", slot: "editor" });
      expect(r.status).toBe(409);
      expect(r.body.error).toContain("no longer");
      expect(launched).toEqual([]);
    } finally {
      apps = saved;
      routes.forgetHandoffApps();
    }
  });

  it("writes nothing into the repository", async () => {
    // The fixture's own `git status` refreshes the index, so it runs outside
    // the two snapshots that bracket the deck's work.
    const status = sh(repo, ["status", "--porcelain=v1"]);
    const before = snapshot(repo);
    await open({ session: "H-repo", slot: "git" });
    await open({ session: "H-repo", slot: "editor", file: "src/app.ts" });
    await open({ session: "H-repo", slot: "terminal" });
    await handoffs();
    expect(launched).toHaveLength(3);
    expect(snapshot(repo)).toEqual(before);
    expect(sh(repo, ["status", "--porcelain=v1"])).toBe(status);
  });
});

describe("the look at the machine", () => {
  it("is made once and kept for a while, then made again", async () => {
    let looks = 0;
    let now = 1_000;
    routes.setHandoffClock(() => now);
    routes.setHandoffDetector(async () => { looks++; return apps; });
    try {
      await handoffs();
      await handoffs();
      await open({ session: "H-repo", slot: "editor" });
      expect(looks).toBe(1);
      now += routes.DETECT_TTL_MS + 1;
      await handoffs();
      expect(looks).toBe(2);
    } finally {
      routes.setHandoffClock(null);
      routes.setHandoffDetector(async () => apps);
    }
  });
});
