// What a deck answers a paired deck that asks, driven on its own: settings,
// a listener and a store the test describes, a connection whose frames the
// test reads, and the real proof and seal from lan-sync.mjs.
//
// lan-engine.test.ts proves the same answers across a real handshake — two
// engines, a hostile peer, a sealed login moved. What is pinned here is the
// ladder of checks in front of each answer, rung by rung, and that each is
// read again after every wait: a deck unpaired, a switch turned off or a tick
// taken back while the store was read gets the refusal, not the answer.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { createServe } from "../../server/lan-serve.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { credentialAad, open, transferChallenge } from "../../server/lan-sync.mjs";

const ME = "fp-me";
const PEER = "fp-peer";
const KEY = "a@x|org-1";

type Cfg = { enabled: boolean; trusted: Array<{ fp: string }>; shared: string[] };
type Slot = { key: string; num: number; alive: boolean; readable?: boolean; unreadableWhy?: string; active?: boolean; email?: string; org?: string };

function rig(over: { accounts?: Slot[]; live?: unknown; blob?: string | null } = {}) {
  const st = {
    cfg: { enabled: true, trusted: [{ fp: PEER }], shared: [KEY] } as Cfg,
    server: {} as object | null,
    accounts: over.accounts ?? [{ key: KEY, num: 3, alive: true, readable: true, email: "a@x", org: "org-1" }],
    blob: over.blob === undefined ? "ccdeck2:slot-3" : over.blob,
    /** Run between a read of the store and its answer, as the owner would. */
    duringRead: null as null | (() => void),
    duringExport: null as null | (() => void),
    readError: null as null | Error,
  };
  const log: string[] = [];
  const errors: Array<[string, unknown]> = [];
  const { serve } = createServe({
    settings: () => st.cfg,
    serverNow: () => st.server,
    myFp: () => ME,
    inbound: { spoke: (ctx: { peerFp: string }) => log.push(`spoke ${ctx.peerFp}`) },
    learnCaller: (ctx: { peerFp: string }) => log.push(`learn ${ctx.peerFp}`),
    keepManifest: (_key: unknown, msg: { t: string }, fp: string) => log.push(`kept ${msg.t} from ${fp}`),
    manifestFrame: (accounts: Slot[], _key: unknown, fp: string) => ({ t: "manifest", accounts: accounts.map(a => a.key), to: fp }),
    localAccounts: async () => {
      log.push("read");
      if (st.readError) throw st.readError;
      st.duringRead?.();
      return st.accounts;
    },
    liveLogin: "live" in over ? async () => over.live : null,
    exportAccount: async (num: number, key: string) => {
      log.push(`export ${num} ${key}`);
      st.duringExport?.();
      return st.blob;
    },
    onError: (where: string, err: unknown) => errors.push([where, err]),
  });
  const key = randomBytes(32);
  const sent: Array<Record<string, any>> = [];
  const ctx = { peerFp: PEER, peerAddr: "192.168.1.5", key, send: (f: Record<string, unknown>) => { sent.push(f); } };
  /** A `want` for `account` carrying the proof the asker would make. */
  const want = (account = KEY, proof?: string) => {
    const nonce = randomBytes(12).toString("hex");
    return {
      t: "want", key: account, nonce,
      proof: proof ?? transferChallenge(key, { nonce, accountKey: account, fromFp: PEER, toFp: ME }),
    };
  };
  const ask = async (msg: unknown) => { await serve(msg, ctx); return sent.at(-1); };
  return { st, log, errors, ctx, key, sent, want, ask, serve };
}

describe("who is answered at all", () => {
  it("nobody who is not paired, and nobody while the deck is off or not listening", async () => {
    for (const change of [
      (r: ReturnType<typeof rig>) => { r.st.cfg = { ...r.st.cfg, trusted: [] }; },
      (r: ReturnType<typeof rig>) => { r.st.cfg = { ...r.st.cfg, enabled: false }; },
      (r: ReturnType<typeof rig>) => { r.st.server = null; },
    ]) {
      const r = rig();
      change(r);
      expect(await r.ask({ t: "manifest" })).toEqual({ t: "no", why: "not paired" });
      // Nothing about the caller is recorded, and nothing is read.
      expect(r.log).toEqual([]);
    }
  });

  it("records who spoke, then the dial-back, before any verb", async () => {
    const r = rig();
    await r.serve({ t: "anything" }, r.ctx);
    expect(r.log).toEqual([`spoke ${PEER}`, `learn ${PEER}`]);
    // A verb it does not know is not answered.
    expect(r.sent).toEqual([]);
  });
});

describe("a manifest", () => {
  it("keeps what the caller said, then answers with this deck's list", async () => {
    const r = rig();
    expect(await r.ask({ t: "manifest" })).toEqual({ t: "manifest", accounts: [KEY], to: PEER });
    expect(r.log).toEqual([`spoke ${PEER}`, `learn ${PEER}`, `kept manifest from ${PEER}`, "read"]);
  });

  it("is refused when the deck was unpaired while the store was read", async () => {
    const r = rig();
    r.st.duringRead = () => { r.st.cfg = { ...r.st.cfg, trusted: [] }; };
    expect(await r.ask({ t: "manifest" })).toEqual({ t: "no", why: "not paired" });
  });
});

describe("a login", () => {
  it("is sent sealed for this pair and this account", async () => {
    const r = rig();
    const got = await r.ask(r.want());
    expect(got).toMatchObject({ t: "have", key: KEY });
    expect(open(r.key, got!.sealed, credentialAad(ME, PEER, KEY))).toBe("ccdeck2:slot-3");
    // Sealed for this direction only.
    expect(open(r.key, got!.sealed, credentialAad(PEER, ME, KEY))).toBeFalsy();
    expect(r.log.at(-1)).toBe(`export 3 ${KEY}`);
  });

  it("is not shared unless it is ticked here, and needs its own proof", async () => {
    const r = rig();
    expect(await r.ask(r.want("b@x|org-1"))).toEqual({ t: "no", why: "not shared" });
    expect(await r.ask(r.want(KEY, "0".repeat(64)))).toEqual({ t: "no", why: "proof" });
    expect(await r.ask({ ...r.want(), proof: 7 })).toEqual({ t: "no", why: "proof" });
    expect(r.log.filter(l => l.startsWith("export"))).toEqual([]);
  });

  it("is not this deck's to give when it has no slot, or a dead one", async () => {
    const none = rig({ accounts: [] });
    expect(await none.ask(none.want())).toEqual({ t: "no", why: "not mine to give" });
    const dead = rig({ accounts: [{ key: KEY, num: 3, alive: false, readable: true }] });
    expect(await dead.ask(dead.want())).toEqual({ t: "no", why: "not mine to give" });
  });

  it("that cannot be read here says why, before anything is run", async () => {
    const r = rig({ accounts: [{ key: KEY, num: 3, alive: true, readable: false, unreadableWhy: "keychain locked" }] });
    expect(await r.ask(r.want())).toEqual({ t: "no", why: "keychain locked" });
    expect(r.log.filter(l => l.startsWith("export"))).toEqual([]);
  });

  it("on the active slot is asked of the live login first", async () => {
    const active = { key: KEY, num: 3, alive: true, readable: true, active: true, email: "a@x", org: "org-1" };
    const other = rig({ accounts: [active], live: { email: "b@x", orgId: "org-1" } });
    expect(await other.ask(other.want())).toEqual({ t: "no", why: "export failed" });
    expect(other.log.filter(l => l.startsWith("export"))).toEqual([]);
    const same = rig({ accounts: [active], live: { email: "A@x", orgId: "org-1" } });
    expect(await same.ask(same.want())).toMatchObject({ t: "have" });
  });

  it("that the export did not produce is said so", async () => {
    const r = rig({ blob: null });
    expect(await r.ask(r.want())).toEqual({ t: "no", why: "export failed" });
  });

  it("is refused when its tick was taken back while the store was read, or while it was exported", async () => {
    const read = rig();
    read.st.duringRead = () => { read.st.cfg = { ...read.st.cfg, shared: [] }; };
    expect(await read.ask(read.want())).toEqual({ t: "no", why: "not shared" });
    expect(read.log.filter(l => l.startsWith("export"))).toEqual([]);
    const exp = rig();
    exp.st.duringExport = () => { exp.st.server = null; };
    expect(await exp.ask(exp.want())).toEqual({ t: "no", why: "not shared" });
  });
});

describe("a failure while answering", () => {
  it("is reported under serve and answered as an error", async () => {
    const r = rig();
    r.st.readError = new Error("store gone");
    expect(await r.ask(r.want())).toEqual({ t: "no", why: "error" });
    expect(r.errors.map(([where, err]) => [where, (err as Error).message])).toEqual([["serve", "store gone"]]);
  });
});
