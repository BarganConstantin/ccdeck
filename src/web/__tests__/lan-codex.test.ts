// Codex accounts on Local network, end to end on one machine — the rules, two
// real engines over a real socket pair with Codex stores the case can read
// back, and the store itself against a real Codex registry in a temp directory.
//
// Fictional, nonfunctional logins only: no provider I/O happens anywhere here.
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error — plain .mjs server module, no types
import { createEngine } from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { accountKey, identityFrom } from "../../server/lan-sync.mjs";
import {
  codexLanKey, codexManifest, codexSyncAction, isCodexKey, LINEAGE_MAX, nextLineage, offeredCodex, planCodex, tokenHash,
// @ts-expect-error — plain .mjs server module, no types
} from "../../server/lan-codex.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { codexLoginOf, createCodexLan } from "../../server/lan-codex-store.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { CODEX_SHARE_PREFIX, createCodexShare, readCodexShare } from "../../server/codex-share.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { addCodexProfile, readCodexSelection } from "../../server/codex-selection.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { ensureWindowsPrivateDirectory } from "../../server/codex-windows-private.mjs";

const H = (n: number) => tokenHash(`fictional-refresh-${n}`) as string;
const ACME = "fictional-workspace-acme";
const CK = (email: string, account = ACME) => codexLanKey(email, account) as string;

interface CodexRow { key: string; email: string; alive: boolean; readable?: boolean; num: string; active?: boolean; rt?: string; was?: string[] }
const row = (email: string, num: string, over: Partial<CodexRow> = {}): CodexRow => ({
  key: CK(email), email, alive: true, readable: true, num, rt: H(1), was: [], ...over,
});

describe("the rules for a Codex login on Local network", () => {
  it("names an account by its email and hashed workspace, never by a token or a Claude key", () => {
    const key = CK("Ana@Example.net");
    expect(key).toBe(CK("ana@example.net"));
    expect(isCodexKey(key)).toBe(true);
    expect(key).not.toContain(ACME);
    expect(CK("ana@example.net", "fictional-workspace-other")).not.toBe(key);
    expect(codexLanKey("", ACME)).toBeNull();
    expect(isCodexKey(accountKey("ana@example.net", "org-1"))).toBe(false);
  });

  it("remembers the tokens a profile held before, newest first and bounded", () => {
    let entry: { rt: string | null; was: string[] } | undefined;
    for (let n = 1; n <= LINEAGE_MAX + 3; n++) entry = nextLineage(entry, H(n)).entry;
    expect(entry!.rt).toBe(H(LINEAGE_MAX + 3));
    expect(entry!.was[0]).toBe(H(LINEAGE_MAX + 2));
    expect(entry!.was).toHaveLength(LINEAGE_MAX);
    expect(nextLineage(entry, H(LINEAGE_MAX + 3)).changed).toBe(false);
    // Signed out and back in: the history stays, so a copy of the old login
    // elsewhere can still be proven dead.
    const out = nextLineage({ rt: H(1), was: [] }, null);
    expect(out.entry).toEqual({ rt: null, was: [] });
    expect(nextLineage(out.entry, H(2)).entry).toEqual({ rt: H(2), was: [] });
    expect(nextLineage({ rt: H(1), was: [] }, H(2)).entry).toEqual({ rt: H(2), was: [H(1)] });
  });

  it("adds what is missing, heals only a copy proven renewed past, and leaves every other login alone", () => {
    const theirs = { ...row("ana@example.net", "x"), rt: H(2), was: [H(1)] };
    expect(codexSyncAction(null, theirs)).toBe("add");
    expect(codexSyncAction(row("ana@example.net", "a", { rt: H(1) }), theirs)).toBe("heal");
    // Their current token, or one of my own sign-in: nothing to repair.
    expect(codexSyncAction(row("ana@example.net", "a", { rt: H(2) }), theirs)).toBeNull();
    expect(codexSyncAction(row("ana@example.net", "a", { rt: H(9) }), theirs)).toBeNull();
    expect(codexSyncAction(null, { ...theirs, shareable: false })).toBeNull();
    expect(codexSyncAction(null, { ...theirs, alive: false })).toBeNull();
    expect(planCodex([], [theirs])).toEqual([{ key: theirs.key, email: theirs.email, action: "add", provider: "codex" }]);
  });

  it("lists only ticked Codex logins, with the one this deck is on kept unless its owner sends it", () => {
    const rows = [
      row("ana@example.net", "a", { active: true, rt: H(1), was: [H(0)] }),
      row("bob@example.net", "b", { rt: H(5) }),
      row("cy@example.net", "c"),
    ];
    const shared = [CK("ana@example.net"), CK("bob@example.net"), accountKey("bob@example.net", "org-1")];
    const list = codexManifest(rows, shared, {});
    expect(list.map((r: { email: string }) => r.email)).toEqual(["ana@example.net", "bob@example.net"]);
    expect(list[0]).toMatchObject({ shareable: false, inUse: true, rt: H(1), was: [H(0)] });
    expect(list[1]).toEqual({ key: CK("bob@example.net"), email: "bob@example.net", alive: true, rt: H(5), was: [] });
    expect(codexManifest(rows, shared, { sendInUse: true })[0]).not.toHaveProperty("shareable");
    expect(codexManifest(rows, shared, { shareActive: false }).map((r: { email: string }) => r.email)).toEqual(["bob@example.net"]);
  });

  it("reads a paired deck's Codex list as data: Codex keys only, hashes that are hashes", () => {
    const got = offeredCodex([
      { key: CK("ana@example.net"), email: "ana@example.net", alive: true, rt: H(2), was: [H(1), "not-a-hash", 7] },
      { key: accountKey("bob@example.net", "org"), email: "bob@example.net", alive: true },
      { key: CK("cy@example.net"), email: "cy@example.net", alive: true, rt: "forged" },
      "junk",
    ]);
    expect(got).toEqual([
      { key: CK("ana@example.net"), email: "ana@example.net", alive: true, rt: H(2), was: [H(1)] },
      { key: CK("cy@example.net"), email: "cy@example.net", alive: true },
    ]);
  });
});

// ── two decks ──────────────────────────────────────────────────────────────

function deafSocket() {
  return {
    on() { /* nothing arrives */ }, bind(_p: number, _h: string, cb: () => void) { cb(); }, setBroadcast() { /* none */ },
    send(_m: unknown, _p: number, _a: string, cb?: (e: Error | null) => void) { cb?.(null); }, close() { /* none */ },
  };
}
const running: Array<{ stop: () => void }> = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

function codexStore(rows: CodexRow[]) {
  const imported: Array<{ blob: string; action: string; mine: string | null }> = [];
  const exported: string[] = [];
  return {
    rows, imported, exported,
    adapter: {
      readAccounts: async () => rows,
      exportAccount: async (id: string, key: string) => { exported.push(id); return `codex-share:${id}:${key}`; },
      importAccount: async (blob: string, step: { action: string }, mine: CodexRow | null) => {
        imported.push({ blob, action: step.action, mine: mine?.num ?? null });
        return { ok: true };
      },
    },
  };
}

async function deck(name: string, { claude = [], codex = null, shared = [], settings = {} }: {
  claude?: Array<{ num: number; email: string; orgUuid: string; alive: boolean; active?: boolean }>;
  codex?: ReturnType<typeof codexStore> | null; shared?: string[]; settings?: Record<string, unknown>;
}) {
  const id = identityFrom("");
  const trusted: unknown[] = [];
  const ticked: string[] = [];
  const claudeImported: string[] = [];
  const e = createEngine({
    readAccounts: async () => ({ accounts: claude }),
    exportAccount: async (num: number) => `ccdeck2:slot-${num}`,
    importAccount: async (blob: string) => { claudeImported.push(blob); return true; },
    ...(codex ? { codex: codex.adapter } : {}),
    onShared: async (key: string) => { ticked.push(key); },
    onTrust: (list: unknown[]) => { trusted.splice(0, trusted.length, ...list); },
    createSocket: () => deafSocket(),
    host: "127.0.0.1",
  });
  running.push(e);
  await e.apply({ enabled: true, name, secret: id.secret, shared, trusted, unpaired: [], autoAsk: false, autoAccept: false, ...settings });
  return { e, ticked, claudeImported, port: e.status().port as number };
}

/** A typed address there, and accept pressed here — both presses real. */
async function pair(from: Awaited<ReturnType<typeof deck>>, to: Awaited<ReturnType<typeof deck>>) {
  expect(from.e.addPeer("127.0.0.1", to.port)).toBe(true);
  await from.e.round();
  expect(to.e.accept(from.e.status().fp)).toBeTruthy();
}

describe("two decks sharing Codex logins", () => {
  it("adds a Codex login ticked on the other deck, and offers it onward", async () => {
    const ana = row("ana@example.net", "b1");
    const mine = codexStore([]);
    const theirs = codexStore([ana]);
    const a = await deck("Deck-A", { codex: mine });
    const b = await deck("Deck-B", { codex: theirs, shared: [ana.key] });
    await pair(a, b);
    expect(await a.e.round()).toEqual([{ key: ana.key, email: ana.email, action: "add", provider: "codex", ok: true, why: null }]);
    expect(theirs.exported).toEqual(["b1"]);
    expect(mine.imported).toEqual([{ blob: `codex-share:b1:${ana.key}`, action: "add", mine: null }]);
    expect(a.ticked).toEqual([ana.key]);
    // The panel hears what that deck offers, without the token history.
    const peer = a.e.status().peers.find((p: { name: string }) => p.name === "Deck-B");
    expect(peer?.offers?.codex).toEqual([{ key: ana.key, email: ana.email, alive: true }]);
  }, 20_000);

  it("leaves a working Codex login alone, however many rounds run", async () => {
    const mine = codexStore([row("ana@example.net", "a1", { rt: H(1) })]);
    const theirs = codexStore([row("ana@example.net", "b1", { rt: H(7), was: [H(6)] })]);
    const a = await deck("Deck-A", { codex: mine, shared: [CK("ana@example.net")] });
    const b = await deck("Deck-B", { codex: theirs, shared: [CK("ana@example.net")] });
    await pair(a, b);
    expect(await a.e.round()).toEqual([]);
    expect(await a.e.round()).toEqual([]);
    expect(theirs.exported).toEqual([]);
    expect(mine.imported).toEqual([]);
  }, 20_000);

  it("heals a copy the other deck renewed past, in place of that copy", async () => {
    const mine = codexStore([row("ana@example.net", "a1", { rt: H(1) })]);
    const theirs = codexStore([row("ana@example.net", "b1", { rt: H(2), was: [H(1)] })]);
    const a = await deck("Deck-A", { codex: mine });
    const b = await deck("Deck-B", { codex: theirs, shared: [CK("ana@example.net")] });
    await pair(a, b);
    expect(await a.e.round()).toEqual([
      { key: CK("ana@example.net"), email: "ana@example.net", action: "heal", provider: "codex", ok: true, why: null },
    ]);
    expect(mine.imported).toEqual([{ blob: `codex-share:b1:${CK("ana@example.net")}`, action: "heal", mine: "a1" }]);
    // Healed, not ticked: the profile was here already.
    expect(a.ticked).toEqual([]);
  }, 20_000);

  it("keeps the Codex login it is on unless its owner sends it, and refuses a deck that asks anyway", async () => {
    const on = row("ana@example.net", "b1", { active: true });
    const mine = codexStore([]);
    const theirs = codexStore([on]);
    const a = await deck("Deck-A", { codex: mine });
    const b = await deck("Deck-B", { codex: theirs, shared: [on.key], settings: { sendInUse: false } });
    await pair(a, b);
    expect(await a.e.round()).toEqual([]);
    expect(theirs.exported).toEqual([]);
    await b.e.apply({ sendInUse: true });
    expect((await a.e.round()).map((d: { action: string; ok: boolean }) => [d.action, d.ok])).toEqual([["add", true]]);
    expect(theirs.exported).toEqual(["b1"]);
  }, 20_000);

  it("never names or gives a Codex login nobody ticked", async () => {
    const mine = codexStore([]);
    const theirs = codexStore([row("ana@example.net", "b1")]);
    const a = await deck("Deck-A", { codex: mine });
    const b = await deck("Deck-B", { codex: theirs, shared: [accountKey("someone@example.net", "org")] });
    await pair(a, b);
    expect(await a.e.round()).toEqual([]);
    const peer = a.e.status().peers.find((p: { name: string }) => p.name === "Deck-B");
    expect(peer?.offers?.codex).toEqual([]);
    expect(theirs.exported).toEqual([]);
  }, 20_000);

  it("moves Claude logins first and unchanged when Codex logins move in the same round", async () => {
    const ana = row("ana@example.net", "b1");
    const mine = codexStore([]);
    const theirs = codexStore([ana]);
    const claudeKey = accountKey("bob@example.net", "org-1");
    const a = await deck("Deck-A", { codex: mine });
    const b = await deck("Deck-B", {
      codex: theirs, shared: [claudeKey, ana.key],
      claude: [{ num: 4, email: "bob@example.net", orgUuid: "org-1", alive: true }],
    });
    await pair(a, b);
    expect(await a.e.round()).toEqual([
      { key: claudeKey, email: "bob@example.net", action: "add", ok: true, why: null },
      { key: ana.key, email: ana.email, action: "add", provider: "codex", ok: true, why: null },
    ]);
    expect(a.claudeImported).toEqual(["ccdeck2:slot-4"]);
  }, 20_000);

  it("pairs with a deck that has no Codex logins to give or take, and Claude logins still move", async () => {
    const claudeKey = accountKey("bob@example.net", "org-1");
    const theirs = codexStore([row("ana@example.net", "b1")]);
    // An older deck: no `codex` list in what it sends, none read in what it hears.
    const a = await deck("Deck-A", {});
    const b = await deck("Deck-B", {
      codex: theirs, shared: [claudeKey, CK("ana@example.net")],
      claude: [{ num: 4, email: "bob@example.net", orgUuid: "org-1", alive: true }],
    });
    await pair(a, b);
    expect(await a.e.round()).toEqual([{ key: claudeKey, email: "bob@example.net", action: "add", ok: true, why: null }]);
    expect(theirs.exported).toEqual([]);
    // And the other way: the new deck asks the older one, which lists no Codex.
    const back = codexStore([]);
    const c = await deck("Deck-C", { codex: back });
    await pair(c, a);
    expect(await c.e.round()).toEqual([]);
    expect(back.imported).toEqual([]);
  }, 20_000);
});

// ── the store ──────────────────────────────────────────────────────────────

const jwt = (claims: Record<string, unknown>) =>
  `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fictional-signature`;
const login = (email: string, n: number, account = ACME) => ({
  auth_mode: "chatgpt", OPENAI_API_KEY: null,
  tokens: {
    id_token: jwt({ email, "https://api.openai.com/auth": { chatgpt_account_id: account } }),
    access_token: `fictional-access-${n}`, refresh_token: `fictional-refresh-${n}`, account_id: account,
  },
  last_refresh: "2026-01-01T00:00:00.000Z",
});
const share = (accounts: unknown[]) =>
  CODEX_SHARE_PREFIX + Buffer.from(JSON.stringify({ version: 1, provider: "codex", accounts })).toString("base64url");

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });

async function machine(auth: unknown) {
  const root = await mkdtemp(join(tmpdir(), "ccdeck-codex-lan-"));
  roots.push(root);
  const home = join(root, "original"), store = join(root, "deck");
  if (process.platform === "win32") await ensureWindowsPrivateDirectory(home);
  else await mkdir(home);
  if (auth) await writeFile(join(home, "auth.json"), JSON.stringify(auth), { mode: 0o600 });
  const options = { store, home: root, env: { CODEX_HOME: home }, platform: process.platform };
  return { home, store, options, lan: createCodexLan({ ...options, settle: async () => {} }) };
}

describe("this deck's Codex store, as Local network reads and writes it", () => {
  it("lists a signed-in home by who it is, and remembers the token it renewed past across a restart", async () => {
    const m = await machine(login("ana@example.net", 1));
    const [first] = await m.lan.readAccounts();
    expect(first).toMatchObject({ key: CK("ana@example.net"), email: "ana@example.net", active: true, rt: H(1), was: [] });
    await writeFile(join(m.home, "auth.json"), JSON.stringify(login("ana@example.net", 2)), { mode: 0o600 });
    expect((await m.lan.readAccounts())[0]).toMatchObject({ rt: H(2), was: [H(1)] });
    const restarted = createCodexLan(m.options);
    expect((await restarted.readAccounts())[0]).toMatchObject({ rt: H(2), was: [H(1)] });
    const kept = await readFile(join(m.store, "codex-lan-lineage.json"), "utf8");
    expect(kept).not.toContain("fictional-refresh");
  });

  it("gives exactly the asked-for login, and nothing for a key that is not it", async () => {
    const m = await machine(login("ana@example.net", 1));
    const { profileId } = await readCodexSelection(m.options);
    const blob = await m.lan.exportAccount(profileId, CK("ana@example.net"));
    expect(readCodexShare(blob).map((e: { auth: unknown }) => codexLoginOf(e.auth)?.key)).toEqual([CK("ana@example.net")]);
    expect(await m.lan.exportAccount(profileId, CK("bob@example.net"))).toBeNull();
  });

  it("adds an arrived login as a profile of its own, and refuses a share that is not exactly that login", async () => {
    const m = await machine(login("me@example.net", 1));
    const step = { key: CK("ana@example.net"), action: "add" };
    expect(await m.lan.importAccount(share([{ label: null, auth: login("ana@example.net", 3) }, { label: null, auth: login("eve@example.net", 4) }]), step, null))
      .toEqual({ ok: false, why: "import refused" });
    expect(await m.lan.importAccount(share([{ label: null, auth: login("eve@example.net", 4) }]), step, null))
      .toEqual({ ok: false, why: "import refused" });
    expect(await m.lan.importAccount(share([{ label: "Work", auth: login("ana@example.net", 3) }]), step, null)).toEqual({ ok: true });
    const rows = await m.lan.readAccounts();
    expect(rows.map((r: CodexRow) => r.email).sort()).toEqual(["ana@example.net", "me@example.net"]);
  });

  it("heals a dead copy in place, and never overwrites a login that changed since it was proven dead", async () => {
    const m = await machine(login("me@example.net", 1));
    const added = await addCodexProfile({ label: "Ana", operationId: "fictional-ana-profile" }, m.options);
    const anaHome = added.profiles.find((p: { id: string }) => p.id === added.id).home;
    await writeFile(join(anaHome, "auth.json"), JSON.stringify(login("ana@example.net", 1)), { mode: 0o600 });
    const mine = (await m.lan.readAccounts()).find((r: CodexRow) => r.email === "ana@example.net");
    const step = { key: CK("ana@example.net"), action: "heal" };
    const renewed = share([{ label: null, auth: login("ana@example.net", 2) }]);

    // Somebody signed in again meanwhile: that login stays.
    await writeFile(join(anaHome, "auth.json"), JSON.stringify(login("ana@example.net", 9)), { mode: 0o600 });
    expect(await m.lan.importAccount(renewed, step, mine)).toEqual({ ok: false, why: "import refused" });
    expect(JSON.parse(await readFile(join(anaHome, "auth.json"), "utf8")).tokens.refresh_token).toBe("fictional-refresh-9");

    // Still the dead copy: replaced in place, same profile, no new one.
    await writeFile(join(anaHome, "auth.json"), JSON.stringify(login("ana@example.net", 1)), { mode: 0o600 });
    const before = (await readCodexSelection(m.options)).profiles.length;
    expect(await m.lan.importAccount(renewed, step, mine)).toEqual({ ok: true });
    expect(JSON.parse(await readFile(join(anaHome, "auth.json"), "utf8")).tokens.refresh_token).toBe("fictional-refresh-2");
    expect((await readCodexSelection(m.options)).profiles.length).toBe(before);
  });

  it("moves, renews and heals a real Codex login between two real decks, and never touches a separate sign-in", async () => {
    // Two decks, two Codex registries on disk, the real store adapter on each
    // and a real socket between them. Ana is the other deck's own login.
    const here = await machine(login("me@example.net", 1));
    const there = await machine(login("ana@example.net", 1));
    const real = (m: Awaited<ReturnType<typeof machine>>) => ({ adapter: m.lan, imported: [], exported: [], rows: [] }) as unknown as ReturnType<typeof codexStore>;
    const a = await deck("Deck-A", { codex: real(here) });
    const b = await deck("Deck-B", { codex: real(there), shared: [CK("ana@example.net")], settings: { sendInUse: true } });
    await pair(a, b);
    const anaHere = async () => (await here.lan.readAccounts()).find((r: CodexRow) => r.email === "ana@example.net");
    const fileOf = async (id: string) => {
      const home = (await readCodexSelection(here.options)).profiles.find((p: { id: string }) => p.id === id).home;
      return JSON.parse(await readFile(join(home, "auth.json"), "utf8")).tokens.refresh_token;
    };

    // 1. It arrives as a profile of its own.
    expect((await a.e.round()).map((d: { action: string; ok: boolean }) => [d.action, d.ok])).toEqual([["add", true]]);
    const added = await anaHere();
    expect(added).toMatchObject({ rt: H(1) });
    expect(await fileOf(added.num)).toBe("fictional-refresh-1");

    // 2. The other deck renews it, which kills this copy; the next round
    //    proves that and heals it in the same profile.
    await writeFile(join(there.home, "auth.json"), JSON.stringify(login("ana@example.net", 2)), { mode: 0o600 });
    await b.e.round();
    expect((await a.e.round()).map((d: { action: string; ok: boolean }) => [d.action, d.ok])).toEqual([["heal", true]]);
    expect(await fileOf(added.num)).toBe("fictional-refresh-2");
    expect((await anaHere()).num).toBe(added.num);
    expect((await here.lan.readAccounts())).toHaveLength(2);

    // 3. Both copies the same now: nothing to do.
    expect(await a.e.round()).toEqual([]);

    // 4. Somebody signs in to Ana here on their own: a token the other deck
    //    never held. Its renewals never reach this login.
    const home = (await readCodexSelection(here.options)).profiles.find((p: { id: string }) => p.id === added.num).home;
    await writeFile(join(home, "auth.json"), JSON.stringify(login("ana@example.net", 9)), { mode: 0o600 });
    await writeFile(join(there.home, "auth.json"), JSON.stringify(login("ana@example.net", 3)), { mode: 0o600 });
    await b.e.round();
    expect(await a.e.round()).toEqual([]);
    expect(await fileOf(added.num)).toBe("fictional-refresh-9");
  }, 30_000);

  it("builds the share it gives with the registry's own export, so file-store rules still hold", async () => {
    const m = await machine(login("ana@example.net", 1));
    const { profileId } = await readCodexSelection(m.options);
    const direct = await createCodexShare({ ids: [profileId] }, m.options);
    expect(await m.lan.exportAccount(profileId, CK("ana@example.net"))).toBe(direct.blob);
  });
});
