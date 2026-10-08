// Which account the sign-in dialog says it registered.
//
// THE VERDICT. "Account N added" and "Credentials refreshed" were decided by
// `newSlot(before, after)` — the one slot that appeared during the sign-in —
// while the provenance note beside it (#1893) already asked the identity
// instead, for the reason its own comment gives: `before` is minutes old by
// then, and a share or a Local network round can land another account in the
// meantime. With one other account landing, newSlot named THAT slot: a
// re-sign-in of an account already here was announced as "Account 3 added"
// under the other account's number, and the provenance went to the wrong
// account. With two landing, newSlot answered null and a genuinely new account
// was announced as "Credentials refreshed".
//
// Driven against a fake child and a fixture store, as login-completes-itself-
// 708.test.ts is: the real CLI opens a browser and starts an OAuth flow.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnedArgv } from "./spawned-argv";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "ccdeck-steps-home-"));
const FAKE_STORE = mkdtempSync(join(tmpdir(), "ccdeck-steps-store-"));
const SEQ = join(FAKE_STORE, "sequence.json");
const prevEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  CLAUDE_SWAP_BACKUP: process.env.CLAUDE_SWAP_BACKUP,
  AGENTS_DECK_CLAUDE: process.env.AGENTS_DECK_CLAUDE,
  AGENTS_DECK_CSWAP: process.env.AGENTS_DECK_CSWAP,
};
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.CLAUDE_CONFIG_DIR = join(FAKE_HOME, ".claude");
process.env.CODEX_HOME = join(FAKE_HOME, ".codex");
process.env.XDG_CONFIG_HOME = join(FAKE_HOME, ".config");
process.env.CLAUDE_SWAP_BACKUP = FAKE_STORE;
process.env.AGENTS_DECK_CLAUDE = join(FAKE_HOME, "no-such-claude");
process.env.AGENTS_DECK_CSWAP = join(FAKE_HOME, "no-such-cswap");

const AUTHORIZE = "https://claude.com/cai/oauth/authorize?code=true&client_id=steps&state=s";
const GREETING =
  "Opening browser to sign in…\n" +
  `If the browser didn't open, visit: \x1b]8;;${AUTHORIZE}\x07${AUTHORIZE}\x1b]8;;\x07` +
  "\nPaste code here if prompted > ";

const fakeLogin = vi.hoisted(() => {
  type Sub = (line: string, partial: boolean) => void;
  const children: any[] = [];
  let waiting: ((c: any) => void) | null = null;
  function spawn() {
    let settle!: (r: any) => void;
    const subs: Sub[] = [];
    const lines = lineFeed(subs);
    const child = {
      done: new Promise((r) => { settle = r; }),
      written: [] as string[],
      onLine(cb: Sub) { subs.push(cb); },
      write(text: string) { child.written.push(text); },
      kill() {},
      out(text: string) { lines.push(text); },
      end(r: unknown) { settle(r); },
    };
    children.push(child);
    waiting?.(child);
    waiting = null;
    return child;
  }
  function child(i: number): Promise<any> {
    return children[i] ? Promise.resolve(children[i]) : new Promise((res) => { waiting = res; });
  }
  return { spawn, child, children };
});

/** Every command the module ran, with the step the polled state carried at
 *  the moment it ran — which is what the dialog would have read then. */
const seen = vi.hoisted(() => [] as Array<{ verb: string; state: string; step: string | null }>);
const probe = vi.hoisted(() => ({ read: null as null | (() => { state: string; step?: string | null }) }));
const cli = vi.hoisted(() => ({
  identity: null as null | { email: string },
  onAdd: (() => true) as () => boolean,
}));

vi.mock("../../server/exec.mjs", async (importOriginal) => {
  const real = await importOriginal<Record<string, any>>();
  const ok = (stdout = "") => ({ ok: true, code: 0, killed: false, timedOut: false, stdout, stderr: "" });
  return {
    ...real,
    runInteractive: (_cmd: string, args: string[]) => {
      if (args[0] === "auth" && args[1] === "login") return fakeLogin.spawn();
      throw new Error(`refusing to run \`${args.join(" ")}\` for real`);
    },
    run: async (cmd: string, args: string[]) => {
      const verb = spawnedArgv({ file: cmd, args }).slice(1);
      const now = probe.read?.() ?? { state: "idle" };
      seen.push({ verb: verb.slice(0, 2).join(" "), state: now.state, step: now.step ?? null });
      if (verb[0] === "auth" && verb[1] === "status") {
        return cli.identity
          ? ok(JSON.stringify({ loggedIn: true, email: cli.identity.email, orgId: "" }))
          : ok(JSON.stringify({ loggedIn: false }));
      }
      if (verb[0] === "add") {
        return cli.onAdd()
          ? ok("added")
          : { ok: false, code: 1, killed: false, timedOut: false, stdout: "", stderr: "cswap: could not read the credential\n" };
      }
      if (verb[0] === "switch") {
        store(current().accounts, Number(verb[1]));
        return ok("switched");
      }
      return ok("");
    },
    runDetached: () => {},
  };
});

// @ts-expect-error — plain JS module, no types
const { lineFeed } = await import("../../server/exec.mjs");
// @ts-expect-error — plain JS module, no types
const admin = await import("../../server/cswap-admin.mjs");
const { startLogin, cancelLogin, loginState, readStore, withStoreLock, accountOriginsWith } = admin;
probe.read = loginState;

type Accounts = Record<string, { email: string; organizationUuid?: string }>;
let held: { accounts: Accounts; active: number | null } = { accounts: {}, active: null };
const current = () => held;
function store(accounts: Accounts, active: number | null) {
  held = { accounts, active };
  writeFileSync(SEQ, JSON.stringify({ activeAccountNumber: active, accounts }));
}

store({ 1: { email: "sandbox@example.invalid" } }, 1);
if (!homedir().startsWith(FAKE_HOME)) throw new Error(`refusing to run: homedir() is ${homedir()}`);
{
  const s = await readStore();
  if (s.slots.join(",") !== "1") throw new Error(`refusing to run: the store resolved outside ${FAKE_STORE}`);
}

const WORK = "work@example.com";
const PERSONAL = "personal@example.com";
const SHARED = "shared@example.com";

async function waiting() {
  const nth = fakeLogin.children.length;
  const start = startLogin();
  const child = await fakeLogin.child(nth);
  child.out(GREETING);
  expect(await start).toMatchObject({ ok: true, state: "awaiting_code" });
  return child;
}

async function settled(timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = loginState();
    if (s.state === "done" || s.state === "failed" || s.state === "idle") break;
    if (Date.now() >= until) break;
    await new Promise(r => setTimeout(r, 10));
  }
  await withStoreLock(async () => {});
  return loginState();
}

const finish = (child: any) =>
  child.end({ ok: true, code: 0, killed: false, timedOut: false, stdout: GREETING + "Login successful.\n", stderr: "" });

/** The commands that ran while the flow was registering, and the step each saw. */
const registering = () => seen.filter(s => s.state === "registering").map(s => [s.verb, s.step]);

const told = [] as Array<{ email: string; added: boolean }>;
accountOriginsWith({ signedIn: (d: { email: string; added: boolean }) => { told.push({ email: d.email, added: d.added }); } });

vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(async () => {
  await cancelLogin();
  for (const c of fakeLogin.children) c.end({ ok: false, code: -1, killed: true, timedOut: false, stdout: "", stderr: "" });
  fakeLogin.children.length = 0;
  seen.length = 0;
  told.length = 0;
  cli.identity = null;
  cli.onAdd = () => true;
});

afterAll(() => {
  accountOriginsWith(null);
  for (const [key, was] of Object.entries(prevEnv)) {
    if (was === undefined) delete process.env[key];
    else process.env[key] = was;
  }
  rmTempDir(FAKE_HOME);
  rmTempDir(FAKE_STORE);
});

describe("which account the success card names", () => {
  it("calls a re-sign-in a refresh when a share lands another account meanwhile", async () => {
    store({ 1: { email: WORK }, 2: { email: PERSONAL } }, 1);
    cli.onAdd = () => {
      store({ 1: { email: WORK }, 2: { email: PERSONAL }, 3: { email: SHARED } }, 2);
      return true;
    };
    const child = await waiting();
    cli.identity = { email: PERSONAL };
    finish(child);

    const state = await settled();
    expect(state.state).toBe("done");
    expect(state.account).toEqual({ num: "2", email: PERSONAL, added: false });
    expect(told).toEqual([{ email: PERSONAL, added: false }]);
  });

  it("calls a new account added when another one lands beside it", async () => {
    store({ 1: { email: WORK } }, 1);
    cli.onAdd = () => {
      store({ 1: { email: WORK }, 2: { email: SHARED }, 3: { email: PERSONAL } }, 3);
      return true;
    };
    const child = await waiting();
    cli.identity = { email: PERSONAL };
    finish(child);

    const state = await settled();
    expect(state.account).toEqual({ num: "3", email: PERSONAL, added: true });
    expect(told).toEqual([{ email: PERSONAL, added: true }]);
  });

  it("calls a second organization of an address already here an added account", async () => {
    store({ 1: { email: WORK }, 2: { email: PERSONAL, organizationUuid: "org-a" } }, 1);
    cli.onAdd = () => {
      store({
        1: { email: WORK },
        2: { email: PERSONAL, organizationUuid: "org-a" },
        3: { email: PERSONAL, organizationUuid: "org-b" },
      }, 3);
      return true;
    };
    const child = await waiting();
    cli.identity = { email: PERSONAL };
    finish(child);

    const state = await settled();
    expect(state.account).toEqual({ num: "3", email: PERSONAL, added: true });
  });

  it("still finds the slot when the store keeps no address for it", async () => {
    store({ 1: { email: WORK } }, 1);
    cli.onAdd = () => { store({ 1: { email: WORK }, 2: { email: "" } }, 2); return true; };
    const child = await waiting();
    cli.identity = { email: PERSONAL };
    finish(child);

    const state = await settled();
    expect(state.account).toEqual({ num: "2", email: PERSONAL, added: true });
  });
});
