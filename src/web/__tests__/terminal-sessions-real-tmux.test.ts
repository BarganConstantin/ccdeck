// Deck sessions on a real tmux server: launched, listed, left dead, closed.
//
// terminal-sessions.test.ts pins every decision with a fake tmux. What a fake
// cannot show is that real tmux agrees with them — that the escapes in
// tmux.mjs are the ones tmux honours, that options set in the same sequence as
// new-session really are in place before a pane that dies at once is reaped,
// and that a dead pane keeps the agent's last frame. Those were each measured
// on tmux 3.6 before the code was written; this is the measurement kept.
//
// NEVER THE PRODUCT'S SERVER, NEVER THE USER'S. Every call names a server of
// this file's own (`-L ccdeck-test-<pid>-<random>`) inside a socket directory
// of its own (TMUX_TMPDIR), and afterAll kills that server and nothing else.
// The panes run `cat` and `sh`, never an agent.
//
// ONE BRANCH INSIDE EACH CASE, NOT A SKIP. tmux is not installed everywhere
// the suite runs, and a skipped case and a passing one are the same green
// tick — which is why skip-gates.mjs registers every gate. So each case runs
// on every machine: where findTmux finds a usable tmux it drives it, and
// where it does not, the case asserts the answer the panel would show instead.
// CCDECK_TMUX points the run at a tmux that is not on PATH.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { findTmux, resetTmuxCache, runTmux } from "../../server/tmux.mjs";
import {
  findDeckSession, findLaunchedSession, killDeckSession, labelDeckSession, launchSession, listDeckSessions, pruneDeadDeckSessions,
} from "../../server/terminal-sessions.mjs";

type Found = { ok: boolean; path?: string; reason?: string; install?: string };
type Deck = { name: string; sessionId: string; agent: string; kind: string; launchKey: string; cwd: string; pane: string; panePid: number; dead: boolean; exitStatus: number | null; created: number; cols: number; rows: number };

let found: Found = { ok: false };
const SANDBOX = mkdtempSync(join(tmpdir(), "cct-"));
// A folder name with every character the escapes exist for: a format, a
// trailing semicolon, a space and a letter outside ASCII.
const PROJECT = join(SANDBOX, "proiect #{pane_id} ș;");
mkdirSync(PROJECT);
const socket = { name: `ccdeck-test-${process.pid}-${randomBytes(3).toString("hex")}` };
// The deck's environment as a launched agent must NOT see it, plus the socket
// directory that keeps this server out of /tmp/tmux-<uid> altogether.
const env = {
  ...process.env, TMUX_TMPDIR: SANDBOX,
  AGENTS_DECK_INTERNAL: "1", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1",
} as Record<string, string>;
const opts = () => ({ tmux: found, socket, env });

beforeAll(async () => {
  resetTmuxCache();
  found = await findTmux();
});

afterAll(async () => {
  if (found.ok) await runTmux(found, socket, ["kill-server"], { env });
  rmTempDir(SANDBOX);
});

/** What the panel says on a machine with no tmux it can use — asserted in
 *  place of the real run, so the case never silently does nothing. */
function expectNoTmux() {
  expect(["missing", "too-old", "unsupported-platform"], JSON.stringify(found)).toContain(found.reason);
  if (found.reason !== "unsupported-platform") expect(found.install, "the install line the panel shows").toBeTruthy();
}

/** The pane's screen as tmux holds it. */
async function screen(name: string): Promise<string> {
  const r = await runTmux(found, socket, ["capture-pane", "-p", "-t", `=${name}:`], { env });
  expect(r.ok, r.stderr).toBe(true);
  return r.stdout;
}

/** The listing, polled until `done` holds or two seconds pass: a pane's
 *  program runs on tmux's clock, not on this test's. */
async function listUntil(done: (list: Deck[]) => boolean): Promise<Deck[]> {
  const until = Date.now() + 2_000;
  for (;;) {
    const list: Deck[] = await listDeckSessions(opts());
    if (done(list) || Date.now() > until) return list;
    await new Promise(r => setTimeout(r, 50));
  }
}

describe("a deck session on a real tmux", () => {
  it("lists nothing, and no error, while its server is not running", async () => {
    if (!found.ok) return expectNoTmux();
    expect(await listDeckSessions(opts())).toEqual([]);
  });

  it("starts in the project folder, labelled, without the deck's or a parent agent's variables", async () => {
    if (!found.ok) return expectNoTmux();
    const id = randomUUID();
    const s = await launchSession({
      ...opts(), agent: "claude", cwd: PROJECT, cols: 90, rows: 25, sessionId: id,
      argv: ["sh", "-c", 'pwd; echo "[${AGENTS_DECK_INTERNAL-unset}][${CLAUDECODE-unset}][${CLAUDE_CODE_CHILD_SESSION-unset}][$COLORTERM]"; exec cat'],
    });
    expect(s).toMatchObject({ sessionId: id });
    expect(s.name).toMatch(/^ccdeck-claude-[0-9a-f]{8}$/);
    expect(s.pane).toMatch(/^%\d+$/);

    const list = await listUntil(l => l.some(x => x.name === s.name));
    const mine = list.find(x => x.name === s.name);
    expect(mine).toMatchObject({
      sessionId: id, agent: "claude", kind: "launch", cwd: PROJECT, pane: s.pane, dead: false, exitStatus: null, cols: 90, rows: 25,
    });
    expect(mine!.panePid).toBeGreaterThan(1);
    expect(Math.abs(mine!.created - Date.now()), "created is epoch milliseconds").toBeLessThan(60_000);
    expect(findDeckSession(list, id)?.name).toBe(s.name);

    let shown = "";
    const until = Date.now() + 2_000;
    while (!shown.includes("][") && Date.now() < until) shown = await screen(s.name);
    const [cwdLine, envLine] = shown.split("\n");
    expect(cwdLine, "the folder, with its # and ; and ș taken literally").toBe(PROJECT);
    expect(envLine, "no deck or parent-agent variable reaches the pane, and 24-bit colour is on").toBe("[unset][unset][unset][truecolor]");
  });

  it("runs a one-word command as that program, not through a shell left in between", async () => {
    if (!found.ok) return expectNoTmux();
    const s = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ["cat"] });
    expect(s.sessionId, "a new Codex has no id yet").toBe("");
    const list = await listUntil(l => l.some(x => x.name === s.name));
    const mine = list.find(x => x.name === s.name)!;
    expect(mine).toMatchObject({ agent: "codex", sessionId: "", dead: false });
    // sh exec'd cat, so the pane's own pid ends up as cat's. Polled, because
    // the pid is tmux's fork until the exec lands, and sh's in between; a sh
    // that stayed in between would be "sh" here for good.
    const comm = () => (process.platform === "linux"
      ? readFileSync(`/proc/${mine.panePid}/comm`, "utf8")
      : execFileSync("ps", ["-o", "comm=", "-p", String(mine.panePid)], { encoding: "utf8" })).trim().split("/").pop();
    let seen = comm();
    for (const until = Date.now() + 2_000; seen !== "cat" && Date.now() < until;) {
      await new Promise(r => setTimeout(r, 25));
      seen = comm();
    }
    expect(seen).toBe("cat");
  });

  it("answers a program that asks its background at its first instant with the deck's colours", async () => {
    if (!found.ok) return expectNoTmux();
    // sh asks before anything could have attached — the launch race a Codex
    // or a TUI with an auto theme runs — and writes the answer down, spelled
    // out by od so no escape reaches the screen.
    const ask = ["sh", "-c", 'stty raw -echo min 0 time 5; printf "\\033]11;?\\033\\\\"; r=$(dd bs=64 count=1 2>/dev/null); stty sane; printf "%s" "$r" | od -An -c | tr -d " \\n"; echo'];
    const lit = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ask, colours: { fg: "#1f2328", bg: "#fafaf8" } });
    const plain = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ask });
    await listUntil(l => [lit.name, plain.name].every(n => l.find(x => x.name === n)?.dead));
    expect(await screen(lit.name)).toContain("rgb:fafa/fafa/f8f8");
    expect(await screen(plain.name), "without them tmux has no light background to give").not.toContain("rgb:fafa/fafa/f8f8");
  });

  it("keeps a pane whose program ended, dead, with its exit status and its own last frame", async () => {
    if (!found.ok) return expectNoTmux();
    const s = await launchSession({
      ...opts(), agent: "claude", kind: "resume", sessionId: randomUUID(), cwd: PROJECT,
      argv: ["sh", "-c", 'printf "the last words\\n"; exit 3'],
    });
    const list = await listUntil(l => Boolean(l.find(x => x.name === s.name)?.dead));
    expect(list.find(x => x.name === s.name), "remain-on-exit keeps it listed").toMatchObject({ kind: "resume", dead: true, exitStatus: 3 });
    const shown = await screen(s.name);
    expect(shown).toContain("the last words");
    expect(shown, "tmux's caption would scroll the frame and is switched off").not.toContain("Pane is dead");
  });

  it("keeps a pane whose program could not start, labelled, so the failure is on the board", async () => {
    if (!found.ok) return expectNoTmux();
    const s = await launchSession({ ...opts(), agent: "claude", cwd: PROJECT, argv: [join(SANDBOX, "no-such-agent")] });
    const list = await listUntil(l => Boolean(l.find(x => x.name === s.name)?.dead));
    expect(list.find(x => x.name === s.name), "the labels arrived before the corpse was reaped")
      .toMatchObject({ agent: "claude", kind: "launch", cwd: PROJECT, dead: true });
  });

  it("refuses a second attach wrapper for one background session, and finds the first", async () => {
    if (!found.ok) return expectNoTmux();
    const id = randomUUID();
    const first = await launchSession({ ...opts(), agent: "claude", kind: "attach", sessionId: id, cwd: PROJECT, argv: ["cat"] });
    expect(first.name).toBe(`ccdeck-att-${id.slice(0, 8)}`);
    await expect(launchSession({ ...opts(), agent: "claude", kind: "attach", sessionId: id, cwd: PROJECT, argv: ["cat"] }))
      .rejects.toMatchObject({ code: "exists" });
    const list = await listDeckSessions(opts());
    expect(list.filter(x => x.sessionId === id)).toHaveLength(1);
    expect(findDeckSession(list, id, { kinds: ["attach"] })?.name).toBe(first.name);
    expect(findDeckSession(list, id, { kinds: ["launch", "resume"] }), "a wrapper is not the session itself").toBeNull();
  });

  it("takes the id a new Codex was later recognised by, so the listing alone finds it from then on", async () => {
    if (!found.ok) return expectNoTmux();
    const s = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ["cat"] });
    const id = randomUUID();
    expect(findDeckSession(await listDeckSessions(opts()), id), "nothing names the id before it is learned").toBeNull();
    expect(await labelDeckSession({ ...opts(), name: s.name, sessionId: id })).toBe(true);
    const mine = (await listDeckSessions(opts())).find(x => x.name === s.name);
    expect(mine, "the label, and the other three left as they were").toMatchObject({ sessionId: id, agent: "codex", kind: "launch", cwd: PROJECT });
    expect(findDeckSession(await listDeckSessions(opts()), id)?.name).toBe(s.name);
    await killDeckSession({ ...opts(), name: s.name });
    expect(await labelDeckSession({ ...opts(), name: s.name, sessionId: id }), "gone meanwhile is an answer, not an error").toBe(false);
  });

  it("keeps the page's name for a launch, so the listing finds that launch again", async () => {
    if (!found.ok) return expectNoTmux();
    const key = `launch-${randomBytes(4).toString("hex")}`;
    const s = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ["cat"], launchKey: key });
    const plain = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ["cat"] });
    const list = await listDeckSessions(opts());
    expect(findLaunchedSession(list, key)).toMatchObject({ name: s.name, pane: s.pane, launchKey: key, cwd: PROJECT });
    expect(list.find(x => x.name === plain.name)?.launchKey, "a launch no page named").toBe("");
    await killDeckSession({ ...opts(), name: s.name });
    await killDeckSession({ ...opts(), name: plain.name });
  });

  it("closes a session it started, and says so when it is already gone", async () => {
    if (!found.ok) return expectNoTmux();
    const s = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ["cat"] });
    expect(await killDeckSession({ ...opts(), name: s.name })).toBe(true);
    expect(await killDeckSession({ ...opts(), name: s.name })).toBe(false);
    expect((await listDeckSessions(opts())).some(x => x.name === s.name)).toBe(false);
    await expect(killDeckSession({ ...opts(), name: "main" })).rejects.toMatchObject({ code: "bad-name" });
  });

  it("leaves a session nobody else made on its server alone", async () => {
    if (!found.ok) return expectNoTmux();
    const r = await runTmux(found, socket, ["new-session", "-d", "-s", "made-by-hand", "--", "cat"], { env });
    expect(r.ok, r.stderr).toBe(true);
    const list = await listDeckSessions(opts());
    expect(list.some(x => x.name === "made-by-hand"), "not a deck session, so not listed as one").toBe(false);
    await expect(killDeckSession({ ...opts(), name: "made-by-hand" })).rejects.toMatchObject({ code: "bad-name" });
  });

  it("prunes dead deck sessions past the keep, and never a live one or one it did not make", async () => {
    if (!found.ok) return expectNoTmux();
    const dead = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ["true"] });
    const live = await launchSession({ ...opts(), agent: "codex", cwd: PROJECT, argv: ["cat"] });
    // One invocation, so remain-on-exit is set before tmux reaps the pane.
    const byHand = await runTmux(found, socket, ["new-session", "-d", "-s", "dead-by-hand", "--", "true",
      ";", "set-option", "-w", "-t", "=dead-by-hand:", "remain-on-exit", "on"], { env });
    expect(byHand.ok, byHand.stderr).toBe(true);
    await listUntil(list => list.find(x => x.name === dead.name)?.dead === true);
    // Just dead, so inside the week: kept.
    expect(await pruneDeadDeckSessions(opts())).toEqual([]);
    // A week and a minute later, as far as the prune can tell.
    const closed = await pruneDeadDeckSessions({ ...opts(), now: Date.now() + 7 * 24 * 60 * 60_000 + 60_000 });
    expect(closed).toContain(dead.name);
    expect(closed).not.toContain(live.name);
    const names = (await runTmux(found, socket, ["list-sessions", "-F", "#{session_name}"], { env })).stdout.split("\n");
    expect(names).not.toContain(dead.name);
    expect(names, "alive").toContain(live.name);
    expect(names, "not the deck's to close, dead or not").toContain("dead-by-hand");
  });
});
