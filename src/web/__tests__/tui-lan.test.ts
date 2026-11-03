// `ccdeck tui`'s Local network tab, held to the web's.
//
// The TUI is plain Node and cannot import TypeScript, so src/server/tui-lan.mjs
// is a copy of the web's roster rules — lan-roster.ts, lan-round.ts and
// account-lan.ts — with the English catalog's words. A copy drifts the first
// time one side is edited without the other. So every status below goes
// through both, and the port must hand back exactly what the web draws: the
// line under the switch, the list of machines, the way-in line, when the last
// round ran, and the accounts Local network offers — key order included, since
// a row printed in the terminal is printed field by field.
//
// The web side is run in English on purpose: `t()` follows the browser, and
// Node 21+ has a `navigator.language` that follows the machine's locale.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { codexLanAccounts, lanAccounts, lanKindHeads, offeredHere } from "../account-lan";
import { type Account } from "../claude-accounts";
import { type CodexProfile } from "../codex-accounts";
import { en } from "../i18n/en";
import { resetLanguageForTest, setLanguage } from "../i18n";
import { nextShared } from "../lan-share";
import { checkedLabel, deckRows, entryLine, isOnline, ONLINE_MS, sectionState } from "../lan-roster";
import type { LanAccount, LanStatus, LanStranger, Peer } from "../lan-types";

// @ts-expect-error — plain .mjs module, no types
const port = await import("../../server/tui-lan.mjs");

beforeAll(() => setLanguage("en"));
afterAll(() => resetLanguageForTest());

const NOW = 1_790_550_000_000;
const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ── fixtures ────────────────────────────────────────────────────────────────

const status = (over: Partial<LanStatus> = {}): LanStatus => ({
  enabled: true, running: true, name: "Studio", fp: "self-fp", port: 4319, addrs: ["192.168.1.2"],
  shared: [], peers: [], trusted: [], invite: null, pending: [], strangers: [], declined: [],
  checkedAt: NOW - 30 * SEC,
  ...over,
});

const peer = (over: Partial<Peer> = {}): Peer => ({
  fp: "bbb-bbb", peerFp: "bbb-bbb", name: "MacBook", addr: "192.168.1.6", port: 4319,
  paired: true, lastSeen: NOW - 5 * SEC, last: { at: NOW - 5 * SEC, done: [] }, ...over,
});

const typed = (over: Partial<Peer> = {}): Peer => ({
  fp: "manual:10.0.0.9:4319", peerFp: null, name: "10.0.0.9", addr: "10.0.0.9", port: 4319,
  manual: true, met: false, paired: false, ...over,
});

const caller = (over: Partial<Peer> = {}): Peer => ({
  fp: "ccc-ccc", peerFp: "ccc-ccc", name: "Windows box", addr: "", port: 0,
  paired: true, waiting: true, lastSeen: NOW - 20 * SEC, last: null, ...over,
});

const stranger = (over: Partial<LanStranger> = {}): LanStranger =>
  ({ fp: "aaa-aaa", name: "Laptop", addr: "192.168.1.5", port: 4319, at: NOW - 30 * SEC, ...over });

/** Every kind of peer the list can hold, each in the state its name says. */
const PEERS: Record<string, Peer> = {
  beaconOnline: peer({ fp: "p1", peerFp: "p1", name: "Beacon on", last: null, lastSeen: NOW - 10 * SEC }),
  beaconOffline: peer({ fp: "p2", peerFp: "p2", name: "Beacon off", last: null, lastSeen: NOW - 10 * MIN }),
  roundOnline: peer({ fp: "p3", peerFp: "p3", name: "Round on", manual: true, met: true, lastSeen: undefined, last: { at: NOW - 40 * SEC, done: [] } }),
  roundOld: peer({ fp: "p4", peerFp: "p4", name: "Round old", lastSeen: undefined, last: { at: NOW - 3 * HOUR, done: [] } }),
  refused: peer({ fp: "p5", peerFp: "p5", name: "Refused", lastSeen: NOW - 10 * SEC, last: { at: NOW - 10 * SEC, error: "connect ECONNREFUSED 192.168.1.9:4319" } }),
  timedOut: peer({ fp: "p6", peerFp: "p6", name: "Timed out", lastSeen: NOW - 2 * HOUR, last: { at: NOW - 2 * MIN, error: "handshake timed out" } }),
  pipe: peer({ fp: "p7", peerFp: "p7", name: "Pipe", lastSeen: undefined, last: { at: NOW - 5 * MIN, error: "write EPIPE" } }),
  unknownFault: peer({ fp: "p8", peerFp: "p8", name: "Odd", last: { at: NOW - 5 * SEC, error: "something nobody wrote down" } }),
  answerWaiting: peer({ fp: "p9", peerFp: "p9", name: "Asked", last: { at: NOW - 5 * SEC, error: "waiting for the other deck to accept this one" } }),
  answerNo: peer({ fp: "p10", peerFp: "p10", name: "Said no", last: { at: NOW - 5 * SEC, error: "that deck said no" } }),
  answerInvite: peer({ fp: "p11", peerFp: "p11", name: "Invite there", last: { at: NOW - 5 * SEC, error: "that deck pairs only by invite" } }),
  answerMyInvite: peer({ fp: "p12", peerFp: "p12", name: "Invite here", lastSeen: NOW - 3 * MIN, last: { at: NOW - 3 * MIN, error: "this deck pairs only by invite" } }),
  arrived: peer({
    fp: "p13", peerFp: "p13", name: "Arrived",
    last: { at: NOW - 2 * MIN, done: [{ email: "a@x.io", action: "heal", ok: true }, { email: "b@x.io", action: "add", ok: true }] },
  }),
  arrivedOne: peer({
    fp: "p14", peerFp: "p14", name: "Arrived one", lastSeen: NOW - 50 * MIN,
    last: { at: NOW - 50 * MIN, done: [{ email: "a@x.io", action: "heal", ok: true }] },
  }),
  partial: peer({
    fp: "p15", peerFp: "p15", name: "Partial",
    last: {
      at: NOW - 30 * SEC,
      done: [
        { email: "a@x.io", action: "heal", ok: true, why: "unreadable_here" },
        { email: "b@x.io", action: "heal", ok: false, why: "keychain_unavailable" },
        { email: "c@x.io", action: "add", ok: false, why: "in use" },
        { email: "d@x.io", action: "add", ok: false, why: "keychain_unavailable" },
        { email: "e@x.io", action: "add", ok: false, why: "constructor" },
      ],
    },
  }),
  warned: peer({
    fp: "p16", peerFp: "p16", name: "Warned",
    last: {
      at: NOW - 30 * SEC,
      done: [
        { email: "a@x.io", action: "heal", ok: true, why: "relogin_required_here" },
        { email: "b@x.io", action: "heal", ok: true, why: "no_credentials_here" },
        { email: "c@x.io", action: "heal", ok: true, why: "unverified_here" },
        { email: "d@x.io", action: "heal", ok: true, why: null },
      ],
    },
  }),
  cutOff: peer({
    fp: "p17", peerFp: "p17", name: "Cut off",
    last: { at: NOW - 4 * MIN, error: "peer closed the connection", done: [{ email: "a@x.io", action: "heal", ok: true, why: "unreadable_here" }] },
  }),
  callerFresh: caller({ fp: "c1", peerFp: "c1", name: "Caller fresh" }),
  callerOld: caller({ fp: "c2", peerFp: "c2", name: "Caller old", lastSeen: NOW - 26 * HOUR }),
  callerNever: caller({ fp: "c3", peerFp: "c3", name: "Caller never", lastSeen: undefined }),
  callerLeftover: caller({ fp: "c4", peerFp: "c4", name: "Caller leftover", lastSeen: NOW - 10 * SEC, last: { at: NOW - 30 * HOUR, error: "handshake timed out" } }),
  diallingFresh: typed(),
  diallingFailed: typed({ fp: "manual:10.0.0.10:4319", addr: "10.0.0.10", name: "10.0.0.10", last: { at: NOW - 70 * SEC, error: "handshake timed out" } }),
  diallingNoAddr: typed({ fp: "manual:nowhere", addr: "", name: "nowhere", port: 4319 }),
  metNotPaired: peer({ fp: "p18", peerFp: "p18", name: "Met", manual: true, met: true, paired: false }),
  heardNotPaired: peer({ fp: "p19", peerFp: "p19", name: "Heard", paired: false }),
  tailnet: peer({ fp: "p20", peerFp: "p20", name: "Tailnet box", addr: "100.64.0.7", via: "tailscale" }),
  tailnetLan: peer({ fp: "p21", peerFp: "p21", name: "Lan box", via: "lan" }),
  numbered9: peer({ fp: "p22", peerFp: "p22", name: "deck 9", addr: "192.168.1.30" }),
  numbered10: peer({ fp: "p23", peerFp: "p23", name: "deck 10", addr: "192.168.1.31" }),
  peerFpless: peer({ fp: "p24-old", peerFp: undefined, name: "No peerFp" }),
};

/** One machine running more than one deck, and one name on two machines. */
const TWINS: Peer[] = [
  peer({ fp: "t1", peerFp: "t1", name: "Colleague Mac", addr: "192.168.1.40", lastSeen: NOW - 3 * HOUR, last: null }),
  peer({ fp: "t2", peerFp: "t2", name: "Colleague Mac", addr: "192.168.1.40", lastSeen: NOW - 5 * SEC }),
  caller({ fp: "t3", peerFp: "t3", name: "Colleague Mac", lastSeen: undefined }),
];
const SPLIT: Peer[] = [
  peer({ fp: "s1", peerFp: "s1", name: "MacBook", addr: "192.168.1.50" }),
  peer({ fp: "s2", peerFp: "s2", name: "MacBook", addr: "192.168.1.51", lastSeen: NOW - 2 * HOUR, last: null }),
  caller({ fp: "s3", peerFp: "s3", name: "MacBook" }),
];

const PENDING: LanStranger[] = [
  stranger({ fp: "r1", name: "Asking laptop", addr: "192.168.1.60", at: NOW - 20 * SEC }),
  stranger({ fp: "r2", name: "Asking tailnet", addr: "100.64.0.9", at: NOW - 7 * MIN, via: "tailscale", own: true }),
  stranger({ fp: "r3", name: "", addr: "192.168.1.61", at: NOW - 3 * HOUR }),
];
const NEARBY: LanStranger[] = [
  stranger({ fp: "n1", name: "Nearby one" }),
  stranger({ fp: "n2", name: "Nearby tailnet", addr: "100.64.0.11", via: "tailscale" }),
  stranger({ fp: "n3", name: "Laptop", addr: "192.168.1.70" }),
  stranger({ fp: "n4", name: "Laptop", addr: "192.168.1.71" }),
  stranger({ fp: "p1", name: "Already a peer" }),
];
const DECLINED: LanStranger[] = [
  stranger({ fp: "d1", name: "Turned away", addr: "192.168.1.80" }),
  stranger({ fp: "n1", name: "Also nearby" }),
];

const ALIASES: Record<string, string> = {
  p1: "Desk",                  // a paired deck renamed
  p3: "Round on",              // an alias equal to its own name: no `self`
  n1: "Kitchen",               // a nearby deck renamed
  r1: "Bob's laptop",          // a request renamed
  d1: "Not that one",          // a declined deck renamed
  t2: "Colleague Mac",         // one of a machine's decks, under the same name
  c2: "Desk",                  // a second deck under an alias that collides
};

const all = Object.values(PEERS);

/** Named statuses, each a state the section can be in. */
const STATUSES: Array<[string, LanStatus | null]> = [
  ["not read yet", null],
  ["off", status({ enabled: false, running: false, peers: all })],
  ["off, never on", status({ enabled: false, running: false })],
  ["starting", status({ running: false })],
  ["stalled", status({ running: false, stalled: "another deck on this machine holds port 4319" })],
  ["stalled while running", status({ stalled: "port taken" })],
  ["no peers", status()],
  ["no peers, nearby only", status({ strangers: NEARBY })],
  ["one request", status({ pending: [PENDING[0]] })],
  ["requests and peers", status({ pending: PENDING, peers: all, strangers: NEARBY, declined: DECLINED })],
  ["requests under invite-only", status({ pairingMode: "invite", pending: PENDING, peers: [PEERS.beaconOnline] })],
  ["every peer", status({ peers: all })],
  ["every peer, renamed", status({ peers: all, aliases: ALIASES, strangers: NEARBY, declined: DECLINED, pending: PENDING })],
  ["every peer, invite-only nearby", status({ peers: all, strangers: NEARBY, pairingMode: "invite", aliases: ALIASES })],
  ["nearby, automatic", status({ strangers: NEARBY, pairingMode: "automatic" })],
  ["nearby, invite", status({ strangers: NEARBY, pairingMode: "invite" })],
  ["declined only", status({ declined: DECLINED, aliases: ALIASES })],
  ["all online", status({ peers: [PEERS.beaconOnline, PEERS.roundOnline, PEERS.callerFresh] })],
  ["one online", status({ peers: [PEERS.beaconOnline] })],
  ["some online", status({ peers: [PEERS.beaconOnline, PEERS.beaconOffline, PEERS.refused] })],
  ["none online", status({ peers: [PEERS.beaconOffline, PEERS.refused, PEERS.callerOld] })],
  ["one, unreachable", status({ peers: [PEERS.timedOut] })],
  ["all waiting on a person", status({ peers: [PEERS.answerWaiting, peer({ fp: "p9b", peerFp: "p9b", name: "Asked too", last: { at: NOW - 5 * SEC, error: "waiting for the other deck to accept this one" } })] })],
  ["one waiting on a person", status({ peers: [PEERS.answerWaiting] })],
  ["waiting on a person, and one fine", status({ peers: [PEERS.answerWaiting, PEERS.beaconOnline] })],
  ["one-way decks", status({ peers: [PEERS.callerFresh, PEERS.callerOld, PEERS.callerNever, PEERS.callerLeftover] })],
  ["one-way, called long ago", status({ peers: [PEERS.callerOld] })],
  ["one-way, never called", status({ peers: [PEERS.callerNever] })],
  ["dialling only", status({ peers: [PEERS.diallingFresh, PEERS.diallingFailed, PEERS.diallingNoAddr] })],
  ["dialling and paired", status({ peers: [PEERS.diallingFailed, PEERS.beaconOnline] })],
  ["heard, not paired", status({ peers: [PEERS.heardNotPaired] })],
  ["met, not paired", status({ peers: [PEERS.metNotPaired] })],
  ["two decks on one machine", status({ peers: TWINS })],
  ["two decks on one machine, renamed", status({ peers: TWINS, aliases: ALIASES })],
  ["one name at two addresses", status({ peers: SPLIT })],
  ["one name at two addresses, plus nearby", status({ peers: SPLIT, strangers: [stranger({ fp: "x1", name: "MacBook", addr: "192.168.1.52" })] })],
  ["Tailscale", status({ peers: [PEERS.tailnet, PEERS.tailnetLan], pending: [PENDING[1]], strangers: [NEARBY[1]] })],
  ["Tailscale, invite", status({ peers: [PEERS.tailnet], strangers: [NEARBY[1]], pairingMode: "invite" })],
  ["blocked", status({ peers: [PEERS.beaconOnline], reach: { blocked: true, why: "firewall", category: "firewall", alias: "ufw" } })],
  ["blocked with a request", status({ peers: [PEERS.beaconOnline], pending: [PENDING[0]], reach: { blocked: true, why: "firewall", category: "firewall", alias: "ufw" } })],
  ["not blocked", status({ peers: [PEERS.beaconOnline], reach: { blocked: false, why: "", category: "", alias: "" } })],
  ["rounds with logins", status({ peers: [PEERS.arrived, PEERS.arrivedOne, PEERS.partial, PEERS.warned, PEERS.cutOff] })],
  ["numbered names", status({ peers: [PEERS.numbered10, PEERS.numbered9] })],
  ["holes in the lists", status({ peers: [PEERS.beaconOnline, PEERS.beaconOnline], pending: [PENDING[0], PENDING[0]], strangers: [stranger({ fp: "" }), NEARBY[0]] })],
  ["missing lists", { enabled: true, running: true } as unknown as LanStatus],
];

/** The web's half, composed as LanSyncSection composes it. */
function web(s: LanStatus | null, now: number) {
  const rows = deckRows(s?.pairingMode === "invite" && s ? { ...s, pending: [] } : s, now);
  return { rows, state: sectionState(s, now), entry: entryLine(s, rows) };
}

const same = (got: unknown, want: unknown, label: string) => {
  expect(got, label).toStrictEqual(want);
  // And in the same order, which is how a terminal prints a row.
  expect(JSON.stringify(got), label).toBe(JSON.stringify(want));
};

// ── parity ──────────────────────────────────────────────────────────────────

describe("the port says what the web says", () => {
  it("keeps every word the web's English catalog has", () => {
    const words = port.LAN_STRINGS as Record<string, string>;
    for (const [key, text] of Object.entries(words)) expect(text, key).toBe(en[key]);
  });

  it("keeps the presence window", () => {
    expect(port.LAN_ONLINE_MS).toBe(ONLINE_MS);
  });

  it.each(STATUSES)("the line under the switch: %s", (label, s) => {
    same(port.lanSectionState(s, NOW), web(s, NOW).state, label);
  });

  it.each(STATUSES)("the list of machines: %s", (label, s) => {
    same(port.lanDeckRows(s, NOW), web(s, NOW).rows, label);
  });

  it.each(STATUSES)("the way-in line: %s", (label, s) => {
    same(port.lanEntryLine(s, NOW), web(s, NOW).entry, label);
  });

  it("decides presence alike for every peer", () => {
    for (const [label, p] of Object.entries(PEERS)) expect(port.lanIsOnline(p, NOW), label).toBe(isOnline(p, NOW));
    for (const p of [...TWINS, ...SPLIT]) expect(port.lanIsOnline(p, NOW), p.fp).toBe(isOnline(p, NOW));
  });

  // Every clock the rows read — the beacon, the round, the call, the request
  // — at the edges of each unit: ninety seconds, an hour, two days, and a time
  // a little in the future (a clock skewed between two machines).
  const AGES = [0, 1, 89_499, 89_500, 90 * SEC, 94_999, 95 * SEC, 3 * MIN, 29.5 * MIN, 59 * MIN, 59.5 * MIN,
    89 * MIN, 90 * MIN, 47 * HOUR, 47.5 * HOUR, 48 * HOUR, 60 * HOUR, 9 * 24 * HOUR, -5 * SEC, -5 * MIN];

  it("ages every clock alike", () => {
    for (const age of AGES) {
      const at = NOW - age;
      const s = status({
        peers: [
          peer({ fp: "a1", peerFp: "a1", name: "Beacon", last: null, lastSeen: at }),
          peer({ fp: "a2", peerFp: "a2", name: "Round", lastSeen: undefined, last: { at, done: [] } }),
          peer({ fp: "a3", peerFp: "a3", name: "Round moved", lastSeen: at, last: { at, done: [{ email: "a@x.io", action: "heal", ok: true }] } }),
          peer({ fp: "a4", peerFp: "a4", name: "Round failed", lastSeen: at, last: { at, error: "connect EHOSTUNREACH 10.0.0.1:1" } }),
          peer({ fp: "a5", peerFp: "a5", name: "Cut", lastSeen: at, last: { at, error: "peer went quiet", done: [{ email: "a@x.io", action: "heal", ok: false, why: "keychain_unavailable" }] } }),
          caller({ fp: "a6", peerFp: "a6", name: "Caller", lastSeen: at }),
          typed({ last: { at, error: "connect ENETUNREACH 10.0.0.9:4319" } }),
        ],
        pending: [stranger({ fp: "a7", name: "Asker", at })],
      });
      const w = web(s, NOW);
      same(port.lanDeckRows(s, NOW), w.rows, `rows at ${age}`);
      same(port.lanSectionState(s, NOW), w.state, `state at ${age}`);
      same(port.lanEntryLine({ ...s, pending: [] }, NOW), web({ ...s, pending: [] }, NOW).entry, `entry at ${age}`);
      for (const busy of [false, true]) {
        expect(port.lanCheckedLabel(at, NOW, busy), `checked at ${age}, busy ${busy}`).toBe(checkedLabel(at, NOW, busy));
      }
    }
  });

  it("says when the last round ran alike", () => {
    for (const at of [null, undefined]) {
      for (const busy of [false, true]) expect(port.lanCheckedLabel(at, NOW, busy)).toBe(checkedLabel(at, NOW, busy));
    }
    // The words themselves, so the port is not only consistent but right.
    expect(port.lanCheckedLabel(null, NOW, false)).toBe("not checked yet");
    expect(port.lanCheckedLabel(NOW - 30 * SEC, NOW, false)).toBe("checked just now");
    expect(port.lanCheckedLabel(NOW - 3 * MIN, NOW, false)).toBe("checked 3m ago");
    expect(port.lanCheckedLabel(NOW - 3 * MIN, NOW, true)).toBe("checking…");
  });
});

describe("the accounts Local network offers, alike", () => {
  const account = (over: Partial<Account> = {}): Account => ({
    num: 2, email: "side@example.com", alias: null, org: "Acme", orgUuid: "org-a",
    active: false, disabled: false, lanes: [], headroom: 40,
    fetchedAt: null, nextAt: null, stale: false, error: null,
    ...over,
  });
  const ACCOUNTS: Account[] = [
    account({ num: 1, email: "Main@Example.com ", orgUuid: "org-a", alive: true, collector: "ok", active: true }),
    account({ num: 2, email: "side@example.com", orgUuid: "org-b", alive: true, collector: null }),
    account({ num: 3, email: "dead@example.com", orgUuid: null, alive: false, collector: "relogin_required" }),
    account({ num: 4, email: null, orgUuid: undefined, alive: undefined, collector: undefined }),
    account({ num: 5, email: "main@example.com", orgUuid: "org-a", alive: true, collector: "keychain_unavailable" }),
    account({ num: 6, email: "active-unknown@example.com", orgUuid: "org-c", alive: true, collector: null, active: true }),
  ];

  const profile = (over: Partial<CodexProfile> = {}): CodexProfile => ({
    id: "p", label: "Codex", identityVersion: "1", active: false, signedInFilePresent: true, ...over,
  });
  const PROFILES: CodexProfile[] = [
    profile({ id: "c1", lan: { key: "codex:acct-1", email: "me@chatgpt.com" } }),
    profile({ id: "c2", lan: { key: "codex:acct-1", email: "me@chatgpt.com" }, active: true }),
    profile({ id: "c3", lan: { key: "codex:acct-1", email: "me@chatgpt.com" } }),
    profile({ id: "c4", lan: { key: "codex:acct-2", email: "work@chatgpt.com" }, active: true }),
    profile({ id: "c5", lan: { key: "codex:acct-2", email: "work@chatgpt.com" } }),
    profile({ id: "c6" }),
    profile({ id: "c7", lan: { key: "codex:acct-3", email: "gone@chatgpt.com" }, available: false }),
    profile({ id: "c8", lan: { key: "codex:acct-4", email: "spare@chatgpt.com" }, available: true }),
  ];

  it("lists Claude's accounts alike", () => {
    same(port.lanAccounts(ACCOUNTS), lanAccounts(ACCOUNTS), "claude");
    same(port.lanAccounts([]), lanAccounts([]), "none");
  });

  it("lists Codex's logins alike", () => {
    same(port.codexLanAccounts(PROFILES), codexLanAccounts(PROFILES), "codex");
    same(port.codexLanAccounts([]), codexLanAccounts([]), "none");
    for (const p of PROFILES) {
      expect(port.isCodexLanKey(p.lan?.key ?? "codex-ish")).toBe((p.lan?.key ?? "codex-ish").startsWith("codex:"));
    }
  });

  it("marks the login this deck is on alike, whatever sendInUse says", () => {
    const held: LanAccount[] = [...lanAccounts(ACCOUNTS), ...codexLanAccounts(PROFILES)];
    for (const s of [null, status(), status({ sendInUse: false }), status({ sendInUse: true })]) {
      same(port.lanOfferedHere(held, s), offeredHere(held, s), `sendInUse ${s?.sendInUse}`);
    }
  });

  it("heads the kinds alike", () => {
    const claude = lanAccounts(ACCOUNTS);
    const codex = codexLanAccounts(PROFILES);
    for (const list of [[], claude, codex, [...claude, ...codex], [codex[0], claude[0], codex[1]]]) {
      expect(port.lanKindHeads(list)).toStrictEqual(lanKindHeads(list));
    }
  });
});

// ── what only the port has ──────────────────────────────────────────────────

describe("the share list, as the setup dialog draws it", () => {
  const claude = [
    { email: "Main@Example.com", orgUuid: "org-a", alive: true, collector: "ok", active: true },
    { email: "side@example.com", orgUuid: "org-b", alive: true, collector: null, active: false },
    { email: "dead@example.com", orgUuid: "org-c", alive: false, collector: "relogin_required", active: false },
  ];
  const codex = [
    { id: "c1", lan: { key: "codex:acct-1", email: "me@chatgpt.com" }, active: true },
    { id: "c2", lan: { key: "codex:acct-2", email: "work@chatgpt.com" }, active: false },
    { id: "c3", active: false },
  ];

  it("lists Claude's logins, then Codex's, each kind under its name", () => {
    const rows = port.lanShareRows(status({ shared: ["main@example.com@@org-a", "codex:acct-2", "elsewhere@@org-z"] }), claude, codex);
    expect(rows).toStrictEqual([
      { key: "main@example.com@@org-a", email: "Main@Example.com", provider: "claude", head: "Claude", shared: true, shareable: false, alive: true, inUse: true, mark: "in use here · not sent" },
      { key: "side@example.com@@org-b", email: "side@example.com", provider: "claude", head: null, shared: false, shareable: true, alive: true, inUse: false, mark: null },
      { key: "dead@example.com@@org-c", email: "dead@example.com", provider: "claude", head: null, shared: false, shareable: false, alive: false, inUse: false, mark: "not working here" },
      { key: "codex:acct-1", email: "me@chatgpt.com", provider: "codex", head: "Codex", shared: false, shareable: false, alive: true, inUse: true, mark: null },
      { key: "codex:acct-2", email: "work@chatgpt.com", provider: "codex", head: null, shared: true, shareable: true, alive: true, inUse: false, mark: null },
    ]);
  });

  it("says nothing about the login in use while it is not ticked, or once it is sent", () => {
    const unticked = port.lanShareRows(status({ shared: [] }), claude, []);
    expect(unticked[0]).toMatchObject({ inUse: true, shared: false, mark: null });
    const sent = port.lanShareRows(status({ shared: ["main@example.com@@org-a"], sendInUse: true }), claude, []);
    expect(sent[0]).toMatchObject({ inUse: false, shared: true, shareable: true, mark: null });
  });

  it("draws no heads on a deck with one kind, and is empty with no accounts", () => {
    expect(port.lanShareRows(status(), claude, []).map((r: { head: unknown }) => r.head)).toStrictEqual([null, null, null]);
    expect(port.lanShareRows(status(), [], codex).map((r: { head: unknown }) => r.head)).toStrictEqual([null, null]);
    expect(port.lanShareRows(status(), [], [])).toStrictEqual([]);
    expect(port.lanShareRows(null, null, null)).toStrictEqual([]);
  });

  it("marks the login in use before the status has arrived", () => {
    expect(port.lanShareRows(null, claude, [])[0]).toMatchObject({ inUse: true, shared: false, shareable: false });
  });

  it("is built the way the dialog builds its rows", () => {
    // LanSetupModal's own composition, on the web's functions.
    const s = status({ shared: ["main@example.com@@org-a", "codex:acct-1", "dead@example.com@@org-c"] });
    const accounts = offeredHere([...lanAccounts(claude as unknown as Account[]), ...codexLanAccounts(codex as unknown as CodexProfile[])], s);
    const heads = lanKindHeads(accounts);
    const shared = new Set(s.shared);
    const want = accounts.map((a, i) => ({
      key: a.key, email: a.email, provider: a.provider ?? "claude", head: heads[i], shared: shared.has(a.key),
      shareable: a.shareable, alive: a.alive, inUse: a.inUse === true,
      mark: !a.alive ? en["lan.setup.notWorking"] : a.inUse && shared.has(a.key) ? en["lan.setup.inUseNotSent"] : null,
    }));
    expect(port.lanShareRows(s, claude, codex)).toStrictEqual(want);
  });
});

describe("one tick in the share list", () => {
  it("adds a key at the end and takes one out, keeping the rest in order", () => {
    expect(port.toggleShared(["a", "b"], "c")).toStrictEqual(["a", "b", "c"]);
    expect(port.toggleShared(["a", "b", "c"], "b")).toStrictEqual(["a", "c"]);
    expect(port.toggleShared([], "a")).toStrictEqual(["a"]);
    expect(port.toggleShared(null, "a")).toStrictEqual(["a"]);
    expect(port.toggleShared(["only"], "only")).toStrictEqual([]);
  });

  it("keeps the keys of accounts that are not on this deck", () => {
    expect(port.toggleShared(["gone@@org", "codex:old", "here@@org"], "here@@org")).toStrictEqual(["gone@@org", "codex:old"]);
  });

  it("hands back a new list and leaves the old one alone", () => {
    const before = ["a", "b"];
    const after = port.toggleShared(before, "a");
    expect(after).not.toBe(before);
    expect(before).toStrictEqual(["a", "b"]);
  });

  it("sends what the dialog's own tick sends", () => {
    for (const [shared, key] of [[["a", "b"], "c"], [["a", "b", "c"], "b"], [["a", "a", "b"], "a"], [["a", "a", "b"], "c"], [[], "x"]] as Array<[string[], string]>) {
      expect(port.toggleShared(shared, key), `${shared} ± ${key}`).toStrictEqual(nextShared(null, shared, key, !shared.includes(key)));
    }
  });
});
