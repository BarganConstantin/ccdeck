import { describe, expect, it } from "vitest";
import { codexLanAccounts, lanKindHeads, offeredHere } from "../account-lan";
import { peerView } from "../lan-peer";
import { deckRows, rowSource } from "../lan-roster";
import { exchangeLanes } from "../lan-exchange";
import type { CodexProfile } from "../codex-accounts";
import type { LanAccount, OfferedAccount } from "../lan-types";

const profile = (id: string, over: Partial<CodexProfile> = {}): CodexProfile => ({
  id, label: id, identityVersion: id, active: false, signedInFilePresent: true, ...over,
});
const ANA = "codex:ana@example.net@@0123456789abcdef0123456789abcdef";
const CLAUDE_ANA = "ana@example.net@@org-1";

describe("Codex logins in the Local network share list", () => {
  it("lists each signed-in Codex account once, marked as Codex and as the one in use", () => {
    const rows = codexLanAccounts([
      profile("p1", { lan: { key: ANA, email: "ana@example.net" } }),
      profile("p2", { active: true, lan: { key: ANA, email: "ana@example.net" } }),
      profile("p3"),
      profile("p4", { available: false, lan: { key: "codex:gone@example.net@@", email: "gone@example.net" } }),
    ]);
    expect(rows).toEqual([{ key: ANA, email: "ana@example.net", alive: true, shareable: true, provider: "codex", active: true }]);
    // The one in use is kept, by Claude's rule, unless its owner sends it.
    expect(offeredHere(rows, { sendInUse: false })[0]).toMatchObject({ shareable: false, inUse: true });
    expect(offeredHere(rows, { sendInUse: true })).toEqual(rows);
  });

  it("names each kind above its first row, only on a deck that has both", () => {
    const claude: LanAccount = { key: CLAUDE_ANA, email: "ana@example.net", alive: true };
    const codex: LanAccount = { key: ANA, email: "ana@example.net", alive: true, provider: "codex" };
    expect(lanKindHeads([claude, { ...claude, key: "b@@o" }, codex])).toEqual(["Claude", null, "Codex"]);
    expect(lanKindHeads([claude, claude])).toEqual([null, null]);
    expect(lanKindHeads([codex])).toEqual([null]);
  });

  it("draws a paired deck's Codex logins on lanes of their own, apart from a Claude login of the same address", () => {
    const theirs: OfferedAccount[] = [
      { key: CLAUDE_ANA, email: "ana@example.net", alive: true },
      { key: ANA, email: "ana@example.net", alive: true },
    ];
    const lanes = exchangeLanes(theirs, [], [], null);
    expect(lanes.map(l => [l.key, l.provider ?? "claude", l.here])).toEqual([
      [CLAUDE_ANA, "claude", "missing"],
      [ANA, "codex", "missing"],
    ]);
    // And what this deck alone offers, after.
    const mine: LanAccount = { key: ANA, email: "ana@example.net", alive: true, provider: "codex" };
    expect(exchangeLanes([], [mine], [ANA], null)[0]).toMatchObject({ key: ANA, provider: "codex", out: "live" });
  });
});

it('shows a failed Codex transfer instead of promising arrival next round', () => {
  const now = 1_700_000_000_000;
  const peer = { fp: 'aaa-aaa-aaa-aaa', peerFp: 'aaa-aaa-aaa-aaa', name: 'Windows deck', paired: true,
    addr: '127.0.0.1', port: 52011, lastSeen: now,
    offers: { at: now, accounts: [], codex: [{ key: ANA, email: 'ana@example.net', alive: true }] },
    last: { at: now, done: [{ key: ANA, email: 'ana@example.net', provider: 'codex', action: 'add', ok: false, why: 'export failed' }] } };
  const status = { peers: [peer], shared: [] } as never;
  const [row] = deckRows(status, now);
  const view = peerView({ row, source: rowSource(status, row), status, accounts: [], now });
  expect(view.lanes[0].caption).not.toContain('arrives next round');
  expect(view.lanes[0].caption).toContain('export failed');
  expect(view.lanes[0].tone).toBe('bad');
});
