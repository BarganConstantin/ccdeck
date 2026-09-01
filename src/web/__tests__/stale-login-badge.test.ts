// #721: the deck printed "login expired" beside an account it was, at that
// same moment, reading live quota numbers for.
//
// MEASURED ON THE MACHINE THAT REPORTED IT, in one instant:
//
//   claude auth status --json  ->  loggedIn: true, claude3@sapec.md
//   cswap list --json          ->  claude3@sapec.md: relogin_required
//   GET /api/quota             ->  source: cli, 5h 33%, 7d 37%
//   GET /api/claude-accounts   ->  claude3@sapec.md: error "invalid_grant"
//
// Two facts had been shipped as one. claude-swap keeps its own COPY of each
// account's credentials, captured when the slot was added; when that copy's
// refresh token dies it can no longer collect, and says so. The user signing in
// again in a terminal refreshes the LIVE credentials and leaves the copy
// exactly as dead — so the deck's badge stayed, its "sign in again" button
// offered a full re-login of the account the user was mid-session in, and
// nothing could ever clear it, because a quarantined row is never re-attempted
// and the fields the badge reads are only written on an attempt.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { authTrouble } from "../../server/claude-accounts.mjs";

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const DEAD = { consecutiveFailures: 1, lastError: "invalid_grant" };
const HERE = { email: "claude3@sapec.md", orgId: "c42" };

describe("an account the collector cannot read", () => {
  it("says nothing red when the CLI says the user is signed in as it", () => {
    // The whole bug in one case. The row is genuinely quarantined and the user
    // genuinely has nothing to fix.
    const out = authTrouble(DEAD, {
      matches: true, isActive: true, identity: HERE, email: "claude3@sapec.md",
    });
    expect(out?.kind).toBe("stale-copy");
    expect(out?.error).toBeNull();
  });

  it("keeps the badge when the signed-in account is a different one", () => {
    // A dead slot the user is NOT signed in as is a real expiry, and the badge
    // is the correct thing to show — this is the case #37 was written for.
    const out = authTrouble(DEAD, {
      matches: true, isActive: true, identity: HERE, email: "claude1@sapec.md",
    });
    expect(out?.kind).toBe("auth");
    expect(out?.error).toBe("invalid_grant");
  });

  it("keeps the badge for an account that is not the active one", () => {
    // The CLI can only answer about the live credentials, which belong to the
    // active slot. It says nothing about any other row, so no other row may
    // borrow its answer.
    const out = authTrouble(DEAD, {
      matches: true, isActive: false, identity: HERE, email: "claude3@sapec.md",
    });
    expect(out?.kind).toBe("auth");
  });

  it("keeps the badge when the CLI could not be asked at all", () => {
    // A subprocess that failed is not evidence of anything. Clearing a real
    // expiry because `claude auth status` timed out is the opposite mistake,
    // and the more dangerous one: it hides a failure the user must act on.
    for (const identity of [null, undefined]) {
      const out = authTrouble(DEAD, {
        matches: true, isActive: true, identity, email: "claude3@sapec.md",
      });
      expect(out?.kind, String(identity)).toBe("auth");
    }
  });

  it("compares the addresses case-insensitively", () => {
    const out = authTrouble(DEAD, {
      matches: true, isActive: true,
      identity: { email: "Claude3@Sapec.MD", orgId: "c42" },
      email: "claude3@sapec.md",
    });
    expect(out?.kind).toBe("stale-copy");
  });

  it("says nothing at all about a healthy row", () => {
    expect(authTrouble({ consecutiveFailures: 0 }, {
      matches: true, isActive: true, identity: HERE, email: "claude3@sapec.md",
    })).toBeNull();
    // And nothing about a row that belongs to a previous occupant of the slot.
    expect(authTrouble(DEAD, {
      matches: false, isActive: true, identity: HERE, email: "claude3@sapec.md",
    })).toBeNull();
  });
});

describe("what the panel is allowed to offer", () => {
  const panel = src("../components/AccountsPanel.tsx");

  it("does not offer to sign the user in again while they are signed in", () => {
    // `sign in again` runs `claude auth login`, a full interactive re-login of
    // the account the user is mid-session in. It is gated on `fixable`, which
    // is reached only through `a.error` — so the server returning a null error
    // for this case is what withholds the button, and this pins that the button
    // has no other route to the screen.
    // The dialog has two openers and only one of them is a claim about an
    // account: the header's `+ Add`, which is the user deciding to add one, and
    // this row button, which is the deck telling them they must. `.ap-fix` is
    // no help either — the panel's retry button wears it too and signs nobody
    // in. So this pins the chain that leads to the row button specifically:
    // it renders only under `e.fixable`, which is reached only through
    // `a.error`, which authTrouble now returns null for in this case.
    const rowButton = /\{e\.fixable && \(\s*<button[^>]*onClick=\{\(\) => setAddOpen\(true\)\}/;
    expect(panel).toMatch(rowButton);
    expect(panel).toMatch(/\{a\.error && \(\(\) => \{/);
    // And nothing else in a row reaches it.
    const rowOpeners = (panel.match(/className="ap-fix" onClick=\{\(\) => setAddOpen\(true\)\}/g) ?? []).length;
    expect(rowOpeners, "a second row control opens the sign-in dialog").toBe(1);
  });

  it("says the quieter true thing instead", () => {
    expect(panel).toMatch(/a\.staleCopy && \(/);
    expect(panel).toMatch(/numbers paused/);
    // And names the remedy that actually applies, rather than the one that
    // would log the user out of a working session.
    expect(panel).toMatch(/cswap add/);
    expect(panel).toMatch(/do not need to sign in again/i);
  });
});

describe("what it costs to ask", () => {
  const server = src("../../server/claude-accounts.mjs");

  it("asks the CLI only when the store already claims trouble", () => {
    // A healthy machine must never spend a subprocess on this. The guard is the
    // active row's own failure count, which is already in hand.
    expect(server).toMatch(/\(activeRow\?\.consecutiveFailures \?\? 0\) > 0\s*\n\s*\? await currentIdentity\(\)/);
  });

  it("never lets that subprocess fail the whole read", () => {
    expect(server).toMatch(/currentIdentity\(\)\.catch\(\(\) => null\)/);
  });
});
