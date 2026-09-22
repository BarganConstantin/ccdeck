// Reported (#1172): the installed hook died on its first line for anyone with
// an ESM package.json above their Claude config dir.
//
// installHookScript writes the CommonJS forwarder to <config dir>/agent-dag/
// hook.js, and Node does not read a `.js` file and guess — it walks up for the
// nearest package.json and takes that file's `"type"` as the answer. With
// nothing in agent-dag/, the nearest one is whatever the user has further up:
// `{"type":"module"}` in ~/package.json, or in the repo a relocated
// CLAUDE_CONFIG_DIR was put inside. The hook then loads as an ES module and
// throws on `require` before main() has installed a single handler — exit 1,
// `require is not defined in ES module scope` on stderr, which Claude Code puts
// in front of the user as `<event> hook error` on every tool call, and no deck
// receives anything at all.
//
// Nothing in the suite could see it. Every hook spawn test copies the script to
// `hook.cjs` — the extension answers the question outright, which is why those
// copies exist at all, the package itself being `"type": "module"` — and the one
// test that runs the installed hook.js (claude-config-dir.test.ts) runs it under
// an os.tmpdir() tree with no package.json anywhere above it.
//
// So these two run the REAL INSTALL under each of the two trees that broke it,
// and the assertion is the deck receiving the event, not the shape of whatever
// the installer writes to shield the file.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rmTempDir } from "./rm-temp-dir";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const INSTALLER = pathToFileURL(join(REPO, "src", "server", "installer.mjs")).href;

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-esm-parent-"));
afterAll(() => rmTempDir(ROOT));

// The hook's own challenge derivation, out of a .cjs copy, so the listener can
// answer like a deck without importing the server. Whether the hook's copy and
// the deck's agree is hook-handshake.test.ts's question.
const HOOK_COPY = join(ROOT, "challenge.cjs");
copyFileSync(join(REPO, "hook", "hook.js"), HOOK_COPY);
const { challengeProof } = createRequire(import.meta.url)(HOOK_COPY) as {
  challengeProof: (token: string, nonce: string) => string;
};

/** A listener that proves itself the way a deck does, and records what it was told. */
async function honestDeck() {
  const token = randomBytes(32).toString("hex");
  const seen: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/hook-challenge") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ proof: challengeProof(token, url.searchParams.get("nonce") ?? "") }));
    }
    seen.push(url.pathname);
    req.resume();
    req.on("end", () => res.writeHead(200).end());
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return {
    seen,
    token,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(done => {
      server.closeAllConnections?.();
      server.close(() => done());
    }),
  };
}

/**
 * Run the real installer in a child, under `env`.
 *
 * A child rather than an import, because installer.mjs resolves the config dir
 * once at module load — so the two trees below would otherwise need two test
 * files to be installed honestly, and the second of them would be testing a
 * module the first had already pinned to a directory.
 */
function install(env: Record<string, string | undefined>): string {
  const code = `
    const { installHooks } = await import(${JSON.stringify(INSTALLER)});
    const res = await installHooks({ provider: "claude" });
    process.stdout.write(JSON.stringify(res.hookPath));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`installHooks failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as string;
}

/** Run the INSTALLED hook.js — not a .cjs copy — the way the host CLI runs it. */
async function runInstalledHook(hookPath: string, env: Record<string, string | undefined>, cwd: string) {
  const child = spawn(process.execPath, [hookPath, "--provider", "claude"], {
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", c => { stdout += c; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", c => { stderr += c; });
  child.stdin.end(JSON.stringify({ cwd, hook_event_name: "SessionStart", session_id: "s1" }));
  const code = await new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("exit", c => done(c));
  });
  return { code, stdout, stderr };
}

/**
 * Build a tree with `{"type":"module"}` at its root, install into `configDir`
 * under it, register an honest deck there and run the installed hook once.
 */
async function underEsmParent(name: string, envFor: (home: string) => Record<string, string | undefined>) {
  const home = join(ROOT, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "package.json"), '{ "type": "module", "name": "whatever" }\n', "utf8");

  const env = { ...envFor(home), HOME: home, USERPROFILE: home, CODEX_HOME: undefined };
  const hookPath = install(env);
  expect(hookPath.startsWith(home), `the install escaped its temp tree: ${hookPath}`).toBe(true);

  const deck = await honestDeck();
  try {
    // Our own pid, so the liveness check keeps the record instead of sweeping
    // it; an empty workspace matches any cwd.
    writeFileSync(join(dirname(hookPath), `${process.pid}.json`), JSON.stringify({
      pid: process.pid, port: deck.port, workspace: "", token: deck.token,
      startedAt: new Date().toISOString(),
    }), "utf8");
    const run = await runInstalledHook(hookPath, env, home);
    return { ...run, seen: deck.seen, hookPath };
  } finally {
    await deck.close();
  }
}

describe("the installed hook under a parent package.json that says `\"type\": \"module\"`", () => {
  it("runs, and reports the event, with the config dir inside such a project", async () => {
    // The relocated case: CLAUDE_CONFIG_DIR pointed at a directory inside a
    // repo — which is how people keep their Claude setup in version control —
    // and that repo is an ESM package.
    const r = await underEsmParent("proj", home => ({ CLAUDE_CONFIG_DIR: join(home, ".claude") }));
    expect(r.stderr, "the hook put a Node error in the host CLI's transcript").toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.seen).toEqual(["/api/event"]);
  }, 60_000);

  it("runs, and reports the event, with the default config dir under such a home", async () => {
    // The commoner case and the one with no repo in it: a ~/package.json, left
    // by anything at all, with `"type": "module"` in it. ~/.claude/agent-dag/
    // sits under it just the same.
    const r = await underEsmParent("home", () => ({ CLAUDE_CONFIG_DIR: undefined }));
    expect(r.stderr, "the hook put a Node error in the host CLI's transcript").toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.seen).toEqual(["/api/event"]);
  }, 60_000);
});
