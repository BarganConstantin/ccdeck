// An account whose login had expired here said "Login expired" for hours while
// Local network was on and every paired deck offered the same account — and
// never said that none of those copies worked either. So nothing arrived to
// repair it, and the row gave no reason why. Claude retires a login's other
// copies each time one machine refreshes it, so shared copies expire
// together, and the only fix is a sign-in on one machine. The row now says so
// when it is true, and only then.
import { describe, expect, it } from "vitest";

import { accountIssue } from "../account-issue";
import { noCopyWorksNearby } from "../account-lan";

const KEY = "porbu@sapec.md@@63c917ff";
const NOW = 1_790_000_000_000;

function status(offers: Array<{ alive: boolean } | null>, over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    shared: [KEY],
    peers: offers.map((o, i) => ({
      fp: `peer-${i}`, name: `peer-${i}`, addr: "192.168.1.2", port: 1, paired: true, lastSeen: NOW - 10_000,
      offers: o ? { at: 0, accounts: [{ key: KEY, email: "porbu@sapec.md", ...o }] } : { at: 0, accounts: [] },
    })),
    ...over,
  } as unknown as Parameters<typeof noCopyWorksNearby>[1];
}

describe("whether any paired deck holds a working copy of a shared account", () => {
  it("says none does when every deck that offers it offers a dead copy", () => {
    expect(noCopyWorksNearby(KEY, status([{ alive: false }, { alive: false }, null]), NOW)).toBe(true);
  });

  it("says nothing while one deck still offers a working copy — that one repairs it", () => {
    expect(noCopyWorksNearby(KEY, status([{ alive: false }, { alive: true }]), NOW)).toBe(false);
  });

  it("says nothing when no deck offers it at all, or the network is off", () => {
    expect(noCopyWorksNearby(KEY, status([null, null]), NOW)).toBe(false);
    expect(noCopyWorksNearby(KEY, status([{ alive: false }], { enabled: false }), NOW)).toBe(false);
    expect(noCopyWorksNearby(KEY, null, NOW)).toBe(false);
  });

  // A round repairs a login from any paired deck that offers a live copy,
  // ticked here or not — see lanRepairExpected. This still asked for the tick,
  // so a login not ticked here, whose every copy nearby had expired too, said
  // only "Login expired" and waited for a repair that could not come.
  it("says none does for a login that is not ticked here, too", () => {
    expect(noCopyWorksNearby(KEY, status([{ alive: false }, { alive: false }], { shared: [] }), NOW)).toBe(true);
    expect(noCopyWorksNearby(KEY, status([{ alive: false }, { alive: true }], { shared: [] }), NOW)).toBe(false);
  });

  it("does not count a deck that has gone quiet: what it offered then may not be true now", () => {
    const s = status([{ alive: false }, { alive: false }]);
    (s!.peers[1] as { lastSeen: number }).lastSeen = NOW - 3 * 60 * 60 * 1000;
    // One deck that is on still says dead: that one is evidence.
    expect(noCopyWorksNearby(KEY, s, NOW)).toBe(true);
    (s!.peers[0] as { lastSeen: number }).lastSeen = NOW - 3 * 60 * 60 * 1000;
    // Nobody that is on has said anything: nothing to conclude.
    expect(noCopyWorksNearby(KEY, s, NOW)).toBe(false);
  });

  it("counts only paired decks", () => {
    const s = status([{ alive: true }, { alive: false }]);
    (s!.peers[0] as { paired: boolean }).paired = false;
    expect(noCopyWorksNearby(KEY, s, NOW)).toBe(true);
  });
});

describe("the row of an expired account that no paired deck can repair", () => {
  const expired = { error: "invalid_grant", collector: "relogin_required" };

  it("says the login has expired on every deck, and what one sign-in does", () => {
    const issue = accountIssue(expired, 0, { noCopyWorksNearby: true })!;
    expect(issue.text).toBe("Login expired on all online decks");
    expect(issue.hint).toMatch(/Sign in again on any one machine/);
    expect(issue.fix).toBe("Sign in again");
    expect(issue.tone).toBe("warn");
  });

  // Said now about a login that is not ticked here as well, and a sign-in on
  // a machine that does not share the login repairs nobody else: only one that
  // shares it hands its copy to the others.
  it("promises the others a repair only from a machine that shares the login", () => {
    const issue = accountIssue(expired, 0, { noCopyWorksNearby: true })!;
    expect(issue.hint).toMatch(/Sign in again on any one machine that shares it; the others repair from it on their next round\.$/);
  });

  it("says it for a quarantined slot the collector stopped on, too", () => {
    const issue = accountIssue({ error: null, stopped: true, collector: "relogin_required" }, 0, { noCopyWorksNearby: true })!;
    expect(issue.text).toBe("Login expired on all online decks");
  });

  it("keeps the ordinary sentence when a paired deck may still repair it", () => {
    expect(accountIssue(expired, 0, { noCopyWorksNearby: false })!.text).toBe("Login expired");
    expect(accountIssue(expired, 0)!.text).toBe("Login expired");
  });

  it("never tells somebody who is signed in to sign in again, on a stale copy (#721)", () => {
    const stale = { error: null, staleCopy: true, collector: "relogin_required", repair: null };
    expect(accountIssue(stale, 0, { noCopyWorksNearby: true })).toEqual(accountIssue(stale, 0));
  });

  it("goes by the row's own issue, not the verdict beside it", () => {
    const limited = { error: "rate_limited", collector: "relogin_required" };
    expect(accountIssue(limited, 0, { noCopyWorksNearby: true })).toEqual(accountIssue(limited, 0));
  });

  it("never says it about a slot that is not a dead login", () => {
    const keychain = accountIssue({ error: null, stopped: true, collector: "keychain_unavailable" }, 0, { noCopyWorksNearby: true })!;
    expect(keychain.text).not.toMatch(/online decks/);
  });
});
