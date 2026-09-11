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
import { authTrouble, readVerdicts } from "../../server/claude-accounts.mjs";
import { collectorText } from "../components/AccountsPanel";

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

describe("a collector that has simply stopped", () => {
  // THE CASE THE COUNTER CANNOT SEE. `consecutiveFailures` counts REJECTIONS,
  // and the failure on the machine that reported this was not one: `cswap list`
  // answered `usageStatus: keychain_unavailable` — claude-swap unable to OPEN
  // the credential rather than having it refused — for three accounts whose
  // counters all read zero, last collected 21 hours, 40 hours and 28 days ago.
  //
  // The cost was not a missing badge. `alive` is `trouble == null`, and that one
  // flag drives three things: what the panel says, whether LAN pairing may heal
  // the account, and what this deck PUBLISHES about it to every paired machine.
  // At `alive: true` the panel was silent, the heal never fired — syncAction
  // only heals a copy this deck calls dead — and the manifest advertised a
  // credential nobody here could read as one a peer could have.
  const QUIET = { consecutiveFailures: 0, lastError: null };
  const HOURS = 60 * 60_000;

  it("is trouble after half a day, whatever the counter says", () => {
    const out = authTrouble(QUIET, {
      matches: true, isActive: false, email: "claude2@sapec.md",
      fetchedAt: 0, now: 21 * HOURS,
    });
    expect(out?.kind).toBe("stopped");
    // NOT an error. All that is known is the silence; the reason lives in
    // claude-swap and may be a dead login, a keychain it cannot open, or a
    // machine that was off. `invalid_grant` here would be inventing evidence.
    expect(out?.error).toBeNull();
  });

  it("leaves a cadence alone, including a laptop closed overnight", () => {
    for (const hours of [0, 1, 9, 11]) {
      expect(authTrouble(QUIET, {
        matches: true, isActive: false, email: "x@y", fetchedAt: 0, now: hours * HOURS,
      }), `${hours}h`).toBeNull();
    }
  });

  it("says nothing about an account nobody has ever collected", () => {
    // Usually one added a minute ago. The panel already has a word for it
    // ("never collected"), and calling a new account broken is a worse first
    // impression than saying nothing.
    expect(authTrouble(QUIET, {
      matches: true, isActive: false, email: "x@y", fetchedAt: null, now: 99 * HOURS,
    })).toBeNull();
  });

  it("still defers to the CLI for the active account", () => {
    // #721's rule survives: if the user is signed in as this account, a
    // collector that stopped is `stale-copy` — quiet, and no offer to sign them
    // in again — rather than a silence of unknown cause.
    const out = authTrouble(QUIET, {
      matches: true, isActive: true, identity: HERE, email: "claude3@sapec.md",
      fetchedAt: 0, now: 21 * HOURS,
    });
    expect(out?.kind).toBe("stale-copy");
  });

  it("does not outrank a failure that was actually reported", () => {
    // A row with both an old fetch and a real rejection is the rejection: it
    // names a cause, and a cause beats a silence.
    const out = authTrouble({ consecutiveFailures: 1, lastError: "invalid_grant" }, {
      matches: true, isActive: false, email: "x@y", fetchedAt: 0, now: 21 * HOURS,
    });
    expect(out?.kind).toBe("auth");
    expect(out?.error).toBe("invalid_grant");
  });

  it("makes the account healable and stops it being advertised", () => {
    // The two consequences that matter more than the label. `alive` is
    // `trouble == null` in the row the panel and the LAN both read.
    const server = src("../../server/claude-accounts.mjs");
    expect(server).toContain("alive:    trouble == null,");
    const lan = src("../../server/lan-sync.mjs");
    // A peer heals only what this deck calls dead …
    expect(lan).toContain("return mine.alive ? null : \"heal\";");
    // … and publishes only what it calls alive.
    expect(lan).toContain("alive: !!a.alive");
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

  it("offers nothing at all for a silence it will not explain", () => {
    // `stopped` is the third trouble state: claude-swap has collected nothing
    // for half a day and says nothing about why — the failure that reached this
    // was `keychain_unavailable`, which never touches consecutiveFailures, so
    // the row's counter reads zero while the account is unusable.
    //
    // It says so and stops there. A `sign in again` under it would be the panel
    // guessing at a cause one line beneath a sentence saying it will not, and
    // the guess has a cost: that button is a full interactive re-login. The
    // repair that fits needs no button — the account is published as NOT alive,
    // so a paired deck with a working copy replaces it on its next round.
    expect(panel).toMatch(/\{a\.stopped && \(/);
    const block = panel.slice(panel.indexOf("{a.stopped && ("), panel.indexOf("{a.error && (()"));
    expect(block).toContain("not collecting");
    expect(block).not.toContain("<button");
  });

  it("offers the repair that Refresh cannot be", () => {
    // The user pressed Refresh and nothing moved, which is correct and useless:
    // Refresh re-reads the store, and claude-swap had stopped attempting the
    // row, so the store could not change. `resume` is what ends that — it
    // re-captures the credentials, which is what clears the quarantine.
    expect(panel).toMatch(/action: "recapture"/);
    expect(panel).toMatch(/resuming…/);
    // Through the panel's own press convention, which does NOT disable the
    // control it came from (#518/#620) — a button that removes itself on press
    // takes the focus with it. `admin` refuses the second press instead.
    expect(panel).toMatch(/\{\.\.\.pressProps\("recapture"\)\}/);
    expect(panel).toMatch(/if \(out\?\.ok\) load\(true\)/);
  });

  it("says the quieter true thing instead", () => {
    expect(panel).toMatch(/a\.staleCopy && \(/);
    expect(panel).toMatch(/numbers paused/);
    // And names the remedy that actually applies, rather than the one that
    // would log the user out of a working session.
    expect(panel).toMatch(/Resume re-captures/);
    expect(panel).toMatch(/No sign-in, no switch/);
  });
});

describe("the repair itself", () => {
  const adminSrc = src("../../server/cswap-admin.mjs");

  it("re-captures rather than logs anybody in", () => {
    // `cswap add` on an account already in the store is an idempotent
    // credential refresh — registerSignedIn says so in its own words. It
    // captures what is signed in right now, which for the active slot is this
    // account, with the working credentials the user already has.
    expect(adminSrc).toMatch(/export async function recaptureActive\(\)/);
    const body = adminSrc.slice(adminSrc.indexOf("export async function recaptureActive"));
    const fn = body.slice(0, body.indexOf("\nexport "));
    expect(fn).toMatch(/\["add"\]/);
    // Never these: they would sign the user out of the session they are in.
    expect(fn).not.toMatch(/auth", "login|startLogin|"switch"/);
  });

  it("takes the store lock, like every other mutation here", () => {
    const body = adminSrc.slice(adminSrc.indexOf("export async function recaptureActive"));
    expect(body.slice(0, 400)).toMatch(/withStoreLock/);
  });

  it("waits for the collection, so the press has something to show for itself", () => {
    // `cswap add` clears the strike instantly and the collection takes seconds.
    // Detached, that left a window where the badge was gone but the numbers were
    // twenty hours old and the row still said "due" — a press that looked like
    // it had done nothing, which is the complaint the button exists to answer.
    const body = adminSrc.slice(adminSrc.indexOf("export async function recaptureActive"));
    const fn = body.slice(0, body.indexOf("\nexport "));
    expect(fn).toMatch(/await run\(await cswapBin\(\), \["list"\]/);
    expect(fn, "a detached collection is the bug this replaced").not.toMatch(/runDetached/);
  });

  it("still succeeds when that collection does not, because the capture held", () => {
    // The credentials are captured either way and claude-swap's own schedule
    // will collect within minutes. Failing the press over a slow subprocess
    // would report a repair that did happen as one that did not.
    const body = adminSrc.slice(adminSrc.indexOf("export async function recaptureActive"));
    const fn = body.slice(0, body.indexOf("\nexport "));
    expect(fn).toMatch(/\.catch\(\(\) => null\)/);
    expect(fn).toMatch(/ok: true, email: before\.email, collected:/);
  });

  it("refuses when nobody is signed in, rather than capturing nothing", () => {
    const body = adminSrc.slice(adminSrc.indexOf("export async function recaptureActive"));
    expect(body.slice(0, 700)).toMatch(/not_signed_in/);
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

describe("what claude-swap says, in its own words", () => {
  // `usage.json` records numbers and a failure COUNTER; `cswap list --json`
  // records a per-slot VERDICT, and the two answer different questions.
  // Measured at one instant, same account:
  //
  //   usage.json  ->  consecutiveFailures: 0, lastError: null
  //   cswap list  ->  usageStatus: "no_credentials"
  it("reads the verdicts out of claude-swap's own listing", () => {
    const out = readVerdicts(JSON.stringify({
      accounts: [
        { number: 1, email: "a@b", usageStatus: "no_credentials" },
        { number: 2, email: "c@d", usageStatus: "ok" },
        { number: 4, email: "e@f", usageStatus: "relogin_required" },
      ],
    }));
    expect(out).toEqual({ 1: "no_credentials", 2: "ok", 4: "relogin_required" });
  });

  it("treats a shape it does not know as no verdicts, never as a throw", () => {
    // Another tool's output, on a boot path. A version that changes its JSON
    // must cost the reason, not the deck.
    expect(readVerdicts("not json at all")).toEqual({});
    expect(readVerdicts("{}")).toEqual({});
    expect(readVerdicts(JSON.stringify({ accounts: "no" }))).toEqual({});
    expect(readVerdicts(JSON.stringify({ accounts: [{ number: "1", usageStatus: "ok" }] }))).toEqual({});
    expect(readVerdicts(JSON.stringify({ accounts: [{ number: 1 }] }))).toEqual({});
  });

  it("gives each state the sentence its remedy needs", () => {
    // Three states, three different things for a person to do. Until this
    // existed the panel collapsed all of them into one silence.
    expect(collectorText("no_credentials")?.text).toBe("no stored login");
    expect(collectorText("no_credentials")?.hint).toMatch(/paired deck/);
    expect(collectorText("relogin_required")?.text).toBe("login expired");
    expect(collectorText("relogin_required")?.hint).toMatch(/[Ss]igning in again/);
  });

  it("says a keychain failure is about the DECK, not the account", () => {
    // The one that would send a person to fix something that is not broken.
    // Measured on one machine, one command, one instant, two sessions:
    //
    //   from a background session  ->  keychain_unavailable, keychain_unavailable
    //   from the GUI session       ->  no_credentials,       relogin_required
    const v = collectorText("keychain_unavailable");
    expect(v?.text).toBe("keychain unreadable");
    expect(v?.hint).toMatch(/about the deck, not the account/);
    expect(v?.hint).toMatch(/background session/);
  });

  it("says nothing at all when there is no verdict yet", () => {
    // The first minutes of every boot, before the collector has been asked.
    expect(collectorText(null)).toBeNull();
    // And an unknown code is shown as a code rather than dressed as a sentence.
    expect(collectorText("something_new")?.text).toBe("something_new");
  });
});
