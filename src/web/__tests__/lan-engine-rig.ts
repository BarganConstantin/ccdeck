// Whole decks on loopback, for the cases that are about what a deck does when
// nobody presses anything: a store the case can read back, a UDP socket that
// sends nothing but can be handed a packet, and every write the engine asks
// prefs to make, kept as it arrives.
//
// LOOPBACK ONLY. Every listener binds 127.0.0.1 on a port the OS picks, and the
// beacon's socket never leaves this process — a suite that announced fake decks
// on somebody's office network was found exactly that way (see
// lan-engine.test.ts). Nothing here reads or writes prefs on disk: what a deck
// would have kept is the arrays below.
// @ts-expect-error — plain .mjs server module, no types
import { createEngine } from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { identityFrom, PROTOCOL } from "../../server/lan-sync.mjs";

export interface StoreRow { num: number; email: string; orgUuid: string; alive: boolean }
export interface Id { secret: string; pub: string; fp: string }

/** A socket that goes nowhere, and a way to hand the engine a packet as though
 *  it had arrived. */
export function deafSocket() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return {
    on(ev: string, fn: (...a: unknown[]) => void) { handlers.set(ev, fn); },
    bind(_p: number, _h: string, cb: () => void) { cb(); },
    setBroadcast() { /* nothing to set */ },
    send(_m: unknown, _p: number, _a: string, cb?: (e: Error | null) => void) { cb?.(null); },
    close() { /* nothing to release */ },
    deliver(msg: Buffer, from: string) { handlers.get("message")?.(msg, { address: from }); },
  };
}

/** Every engine a case started, stopped by the file's afterEach. */
export const running: Array<{ stop: () => void }> = [];
export const stopAll = () => { for (const e of running.splice(0)) e.stop(); };

export interface RigDeck {
  e: any;
  id: Id;
  sock: ReturnType<typeof deafSocket>;
  port: number;
  /** What the store was asked to take in, and to give out. */
  imported: string[];
  exported: number[];
  /** Accounts the engine asked to tick for sharing on arrival (#1188). */
  ticked: string[];
  /** Every write of the trusted list, and every dial row kept in prefs. */
  trustWrites: Array<Array<Record<string, unknown>>>;
  dials: string[];
}

/**
 * One deck, switched on. `settings` is what prefs would hand it on top of a
 * fresh key and an empty trusted list; `deps` replaces any of the engine's own
 * dependencies, `now` included.
 */
export async function rigDeck(name: string, {
  rows = [], shared = [], settings = {}, deps = {},
}: {
  rows?: StoreRow[]; shared?: string[]; settings?: Record<string, unknown>; deps?: Record<string, unknown>;
} = {}): Promise<RigDeck> {
  const id: Id = identityFrom("");
  const imported: string[] = [];
  const exported: number[] = [];
  const ticked: string[] = [];
  const trustWrites: Array<Array<Record<string, unknown>>> = [];
  const dials: string[] = [];
  const sock = deafSocket();
  const e = createEngine({
    readAccounts: async () => ({ accounts: rows }),
    exportAccount: async (num: number) => { exported.push(num); return `ccdeck2:slot-${num}`; },
    importAccount: async (blob: string) => { imported.push(blob); return true; },
    onShared: async (key: string) => { ticked.push(key); },
    onTrust: (list: Array<Record<string, unknown>>) => { trustWrites.push(list.map(t => ({ ...t }))); },
    onDial: (entry: string) => { dials.push(entry); },
    createSocket: () => sock,
    host: "127.0.0.1",
    ...deps,
  });
  running.push(e);
  await e.apply({ enabled: true, name, secret: id.secret, shared, trusted: [], unpaired: [], ...settings });
  return { e, id, sock, port: e.status().port as number, imported, exported, ticked, trustWrites, dials };
}

/** One beacon from `from`, as it arrives off the wire at `to`. No `h`, so
 *  nothing collapses it into another machine's row. */
export function announce(to: RigDeck, from: { fp: string; port: number; name?: string }, addr = "127.0.0.1") {
  to.sock.deliver(Buffer.from(JSON.stringify({
    m: "CCDK", v: PROTOCOL, n: from.name ?? "Stranger", f: from.fp, p: from.port, i: "00".repeat(8),
  })), addr);
}
