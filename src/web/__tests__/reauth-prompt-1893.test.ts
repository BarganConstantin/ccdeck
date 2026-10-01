// #1893: an account the deck signed in itself whose login stops working used
// to be a row in the accounts panel that said "Login expired" to whoever
// happened to open it. Now the deck remembers which accounts its own
// `+ → Sign in` added, and asks — once per incident, over the canvas — for the
// ones whose stored login claude-swap has refused since.
//
// This file pins the rules, each against the acceptance criterion it answers:
// what gets the provenance and what never does, what counts as a refusal and
// what never does (an expiry time is not evidence), how an incident is named so
// "Not now" sticks to it and a later one can ask again, that Local network's
// repair goes first, what the dialog says for one account and for several, and
// that none of it polls. reauth-origins-flow-1893.test.ts drives the sign-in,
// the removal and the roster read themselves.
import { afterAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
import {
  SIGNED_IN_HERE, hasRecovered, incidentsFrom, needsSignIn, normaliseOrigins, reauthFor,
  withDismissed, withSignIn, withTidied,
} from "../../server/account-origins.mjs";
import { accountKey } from "../../server/lan-copies.mjs";
import { authTrouble } from "../../server/claude-accounts.mjs";
import { loadPrefs, normalise, publicPrefs, updatePrefs } from "../../server/deck-prefs.mjs";
import { deadLogin } from "../account-issue";
import { lanRepairExpected } from "../account-lan";
import type { Account } from "../claude-accounts";
import type { LanStatus, Peer } from "../lan-types";
import {
  attentionLead, attentionRows, attentionTitle, incidentId, promptShows, settledBy, type AttentionRow,
} from "../reauth-attention";
import AccountAttentionModal, { AttentionBody } from "../components/AccountAttentionModal";

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const NOW = 1_790_000_000_000;
const MIN = 60_000;
const WORK = "work@example.com";
const KEY = accountKey(WORK, "org-1");

type Prefs = Record<string, unknown>;
/** What prefs.json holds about one account, or null. */
const originOf = (prefs: Prefs, key: string) => normaliseOrigins(prefs?.accounts)[key] ?? null;
/** Run one updatePrefs mutator the way the queued writer does: merge its
 *  patch one top-level field deep onto what it read. */
const apply = (prefs: Prefs, mutate: (p: Prefs) => Prefs | null): Prefs => ({ ...prefs, ...(mutate(prefs) ?? {}) });
const signedInAt = (at: number) => apply({}, withSignIn({ email: WORK, org: "org-1", added: true, now: at }));

// ── provenance ──────────────────────────────────────────────────────────────

describe("which accounts carry the deck's own sign-in", () => {
  it("marks an account a completed + → Sign in added, under its identity", () => {
    const p = signedInAt(NOW);
    expect(originOf(p, KEY)).toEqual({ origin: SIGNED_IN_HERE, signedInAt: NOW });
    expect(SIGNED_IN_HERE).toBe("ccdeck_signin");
  });

  it("does not mark an account that was already in the store when it was signed into", () => {
    // A share, Local network, or an account the deck found in an existing
    // store: all are already there, so a sign-in only refreshes them.
    const mutate = withSignIn({ email: WORK, org: "org-1", added: false, now: NOW });
    expect(mutate({})).toBeNull();
  });

  it("keeps the mark across a later re-sign-in, and moves when it was last signed in", () => {
    const first = signedInAt(NOW);
    const dismissed = apply(first, withDismissed([{ key: KEY, since: NOW }]));
    const again = apply(dismissed, withSignIn({ email: WORK, org: "org-1", added: false, now: NOW + 60 * MIN }));
    // The new sign-in closes the incident it fixed, and "Not now" goes with it.
    expect(originOf(again, KEY)).toEqual({ origin: SIGNED_IN_HERE, signedInAt: NOW + 60 * MIN });
  });

  it("keys by address AND organization, case-folded, never by slot", () => {
    const p = signedInAt(NOW);
    expect(originOf(p, accountKey("Work@Example.com", "org-1"))).not.toBeNull();
    expect(originOf(p, accountKey(WORK, "org-2"))).toBeNull();
  });

  it("forgets an account gone from the store, so a later share of it is not mistaken for one", () => {
    const p = apply(signedInAt(NOW), withTidied({ gone: [KEY] }));
    expect(originOf(p, KEY)).toBeNull();
    expect(withTidied({ gone: [KEY] })(p)).toBeNull();
  });

  it("keeps nothing from a hand-edited file that is not a provenance the deck writes", () => {
    const raw = JSON.parse(`{
      "${KEY}": { "origin": "ccdeck_signin", "signedInAt": 5, "dismissed": 5 },
      "other@x.io@@": { "origin": "paste_share", "signedInAt": 5 },
      "no-separator": { "origin": "ccdeck_signin" },
      "__proto__": { "origin": "ccdeck_signin" },
      "x@y.z@@o": "ccdeck_signin"
    }`);
    const out = normaliseOrigins(raw);
    expect(Object.keys(out)).toEqual([KEY]);
    expect(out[KEY]).toEqual({ origin: SIGNED_IN_HERE, signedInAt: 5, dismissed: 5 });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe("where it is kept", () => {
  const HOME = mkdtempSync(join(tmpdir(), "ccdeck-1893-prefs-"));
  afterAll(() => rmTempDir(HOME));

  it("survives a restart and a re-sign-in, in prefs.json", async () => {
    await updatePrefs(withSignIn({ email: WORK, org: "org-1", added: true, now: NOW }), HOME);
    // A restart is a fresh read of the file.
    expect(originOf((await loadPrefs(HOME)).prefs, KEY)).toEqual({ origin: SIGNED_IN_HERE, signedInAt: NOW });
    await updatePrefs(withDismissed([{ key: KEY, since: NOW }]), HOME);
    expect(originOf((await loadPrefs(HOME)).prefs, KEY)?.dismissed).toBe(NOW);
    await updatePrefs(withSignIn({ email: WORK, org: "org-1", added: false, now: NOW + MIN }), HOME);
    expect(originOf((await loadPrefs(HOME)).prefs, KEY)).toEqual({ origin: SIGNED_IN_HERE, signedInAt: NOW + MIN });
  });

  it("does not drop the other accounts when one changes", async () => {
    const other = accountKey("home@example.com", "");
    await updatePrefs(withSignIn({ email: "home@example.com", org: "", added: true, now: NOW }), HOME);
    await updatePrefs(withTidied({ gone: [KEY] }), HOME);
    const kept = (await loadPrefs(HOME)).prefs.accounts;
    expect(Object.keys(kept)).toEqual([other]);
  });

  it("never reaches a page, and a page cannot write it", () => {
    const prefs = normalise({ accounts: { [KEY]: { origin: SIGNED_IN_HERE, signedInAt: NOW } } });
    expect(prefs.accounts[KEY]).toBeDefined();
    expect("accounts" in publicPrefs(prefs)).toBe(false);
    // POST /api/prefs takes everything else in a patch, so the field is cut
    // out of the body by name, beside the reporter's own state.
    expect(src("../../server/prefs-routes.mjs"))
      .toMatch(/const \{ reports: _reports, report: _report, accounts: _accounts, \.\.\.patch \} = body;/);
  });
});

// ── what counts as a dead login ─────────────────────────────────────────────

const entry = { origin: SIGNED_IN_HERE, signedInAt: NOW - 10 * MIN };
const refused = (error: string) => ({ kind: "auth", error });
const after = { fetchedAt: NOW - 60 * MIN, attemptedAt: NOW - MIN };

describe("when an account is an incident", () => {
  it("is one for a deck-signed-in account refused with invalid_grant or no_refresh_token", () => {
    for (const code of ["invalid_grant", "no_refresh_token"]) {
      expect(reauthFor({ entry, trouble: refused(code), collector: null, ...after }))
        .toEqual({ since: NOW - 10 * MIN, dismissed: false });
    }
  });

  it("is one when claude-swap stopped collecting and says relogin_required", () => {
    const trouble = { kind: "stopped", error: null };
    expect(reauthFor({ entry, trouble, collector: "relogin_required", ...after })).not.toBeNull();
    // Any other verdict on a stopped collector is not a sign-in: an unreadable
    // keychain is about the deck, and no verdict at all is a silence.
    expect(reauthFor({ entry, trouble, collector: "keychain_unavailable", ...after })).toBeNull();
    expect(reauthFor({ entry, trouble, collector: null, ...after })).toBeNull();
  });

  it("is never one for an account the deck did not sign in", () => {
    expect(reauthFor({ entry: null, trouble: refused("invalid_grant"), collector: null, ...after })).toBeNull();
    expect(reauthFor({ entry: { origin: "paste_share", signedInAt: 0 }, trouble: refused("invalid_grant"), collector: null, ...after }))
      .toBeNull();
  });

  it("is never one for a failure that is not a dead refresh token", () => {
    for (const code of ["http-429", "timeout", "network", "transient", "error"]) {
      expect(reauthFor({ entry, trouble: refused(code), collector: null, ...after })).toBeNull();
    }
    // The reader is signed in and the deck re-captures the copy itself (#721).
    expect(reauthFor({ entry, trouble: { kind: "stale-copy", error: null }, collector: "relogin_required", ...after })).toBeNull();
    expect(reauthFor({ entry, trouble: null, collector: "relogin_required", ...after })).toBeNull();
  });

  it("never comes from time passing: an old reading with no refusal is not one", () => {
    // Half a day silent, an expired-token verdict, a reading weeks old — none
    // of it is claude-swap having refused the login.
    const silent = authTrouble({ consecutiveFailures: 0, lastError: null }, {
      matches: true, isActive: false, identity: null, email: WORK, fetchedAt: NOW - 30 * 24 * 60 * MIN, now: NOW,
    });
    expect(silent).toEqual({ kind: "stopped", error: null });
    for (const collector of [null, "token_expired", "ok"]) {
      expect(reauthFor({ entry, trouble: silent, collector, fetchedAt: NOW - 30 * 24 * 60 * MIN, attemptedAt: NOW - MIN }))
        .toBeNull();
    }
    expect(src("../../server/account-origins.mjs")).not.toMatch(/expiresAt|expires_at|Date\.now\(\)/);
  });

  it("waits for a refusal that came after the last sign-in here", () => {
    // claude-swap's last attempt was before the deck signed the account in
    // again: what it refused is the login that sign-in replaced.
    expect(reauthFor({ entry, trouble: refused("invalid_grant"), collector: null, fetchedAt: null, attemptedAt: entry.signedInAt }))
      .toBeNull();
    expect(reauthFor({ entry, trouble: refused("invalid_grant"), collector: null, fetchedAt: null, attemptedAt: null }))
      .toBeNull();
    expect(reauthFor({ entry, trouble: refused("invalid_grant"), collector: null, fetchedAt: null, attemptedAt: entry.signedInAt + 1 }))
      .not.toBeNull();
  });

  it("is the panel's own rule for a dead login, on the server", () => {
    // account-issue.ts decides the row's "Login expired"; account-origins.mjs
    // decides the prompt. One table, both rules.
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ consecutiveFailures: 1, lastError: "invalid_grant" }, null],
      [{ consecutiveFailures: 2, lastError: "no_refresh_token" }, null],
      [{ consecutiveFailures: 1, lastError: "http-429" }, "relogin_required"],
      [{ consecutiveFailures: 1, lastError: "http-401" }, null],
      [{ consecutiveFailures: 0, lastError: null }, "relogin_required"],
      [{ consecutiveFailures: 0, lastError: null }, "keychain_unavailable"],
      [{ consecutiveFailures: 0, lastError: null }, null],
    ];
    for (const [row, collector] of cases) {
      for (const fetchedAt of [NOW - MIN, NOW - 13 * 60 * MIN]) {
        const trouble = authTrouble(row, { matches: true, isActive: false, identity: null, email: WORK, fetchedAt, now: NOW });
        const panel = deadLogin({
          error: trouble?.error ?? null, stopped: trouble?.kind === "stopped",
          collector, staleCopy: trouble?.kind === "stale-copy",
        });
        expect(`${JSON.stringify(row)} ${collector} ${fetchedAt}: ${needsSignIn(trouble, collector)}`)
          .toBe(`${JSON.stringify(row)} ${collector} ${fetchedAt}: ${panel}`);
      }
    }
  });
});

describe("how an incident is named", () => {
  it("follows the last moment the login was known to work", () => {
    const late = { ...entry, signedInAt: NOW - 120 * MIN };
    // A good read after the sign-in: the incident follows the read.
    expect(reauthFor({ entry: late, trouble: refused("invalid_grant"), collector: null, fetchedAt: NOW - 30 * MIN + 0.4, attemptedAt: NOW - MIN })?.since)
      .toBe(NOW - 30 * MIN);
    // No good read since the sign-in: the incident follows the sign-in.
    expect(reauthFor({ entry: late, trouble: refused("invalid_grant"), collector: null, fetchedAt: NOW - 500 * MIN, attemptedAt: NOW - MIN })?.since)
      .toBe(NOW - 120 * MIN);
  });

  it("stays put off for the same incident, and asks again for a new one", () => {
    const since = NOW - 10 * MIN;
    const putOff = { ...entry, dismissed: since };
    // The same refusal, polled, refreshed and restarted over: still put off.
    for (const attemptedAt of [NOW - MIN, NOW, NOW + 600 * MIN]) {
      expect(reauthFor({ entry: putOff, trouble: refused("invalid_grant"), collector: null, fetchedAt: NOW - 60 * MIN, attemptedAt }))
        .toEqual({ since, dismissed: true });
    }
    // It worked again, then failed again: a new incident, and nothing put it off.
    expect(reauthFor({ entry: putOff, trouble: refused("invalid_grant"), collector: null, fetchedAt: NOW + 5 * MIN, attemptedAt: NOW + 9 * MIN }))
      .toEqual({ since: NOW + 5 * MIN, dismissed: false });
  });

  it("forgets a put-off once the account is read well after it — and not before", () => {
    const putOff = { ...entry, dismissed: NOW - 10 * MIN };
    // The read the incident started from, fractional seconds and all.
    expect(hasRecovered(putOff, NOW - 10 * MIN + 0.9)).toBe(false);
    expect(hasRecovered(putOff, null)).toBe(false);
    expect(hasRecovered(putOff, NOW - 9 * MIN)).toBe(true);
    expect(hasRecovered(entry, NOW)).toBe(false);
    const cleared = apply({ accounts: { [KEY]: putOff } }, withTidied({ recovered: [KEY] }));
    expect(originOf(cleared, KEY)).toEqual(entry);
    expect(withTidied({ recovered: [KEY] })(cleared)).toBeNull();
  });

  it("tidies only what the read judged: an entry changed since is not its to undo", () => {
    const putOff = { ...entry, dismissed: NOW - 10 * MIN };
    const seen = { [KEY]: putOff };
    // Signed in again while the read was out: the read's "gone" is about the
    // mark it saw, not this one.
    const resigned = { accounts: { [KEY]: { ...entry, signedInAt: NOW } } };
    expect(withTidied({ gone: [KEY], seen })(resigned)).toBeNull();
    // Put off again, for a newer incident: that put-off stays.
    const newer = { accounts: { [KEY]: { ...entry, dismissed: NOW } } };
    expect(withTidied({ recovered: [KEY], seen })(newer)).toBeNull();
    // Unchanged since: tidied.
    expect(originOf(apply({ accounts: seen }, withTidied({ recovered: [KEY], seen })), KEY)).toEqual(entry);
    expect(originOf(apply({ accounts: seen }, withTidied({ gone: [KEY], seen })), KEY)).toBeNull();
  });

  it("takes only well-formed incidents from a request, and only for accounts the deck marked", () => {
    expect(incidentsFrom([{ key: KEY, since: 5 }, { key: "nope", since: 5 }, { key: KEY, since: "5" }, null, "x"]))
      .toEqual([{ key: KEY, since: 5 }]);
    expect(incidentsFrom("x")).toEqual([]);
    expect(withDismissed([{ key: accountKey("stranger@x.io", ""), since: 5 }])(signedInAt(NOW))).toBeNull();
  });
});

// ── the page's half ─────────────────────────────────────────────────────────

function account(num: number, email: string, over: Partial<Account> = {}): Account {
  const key = accountKey(email, "");
  return {
    num, email, alias: null, org: null, active: false, disabled: false, lanes: [], headroom: null,
    fetchedAt: NOW - 60 * MIN, nextAt: null, stale: true, error: "invalid_grant", orgUuid: "",
    origin: "ccdeck_signin", reauth: { key, since: NOW - 60 * MIN, dismissed: false }, ...over,
  };
}

const NONE: ReadonlySet<string> = new Set();
const lanOff = { enabled: false, running: false, shared: [], peers: [] } as unknown as LanStatus;

function peer(over: Partial<Peer> = {}, offer: { alive: boolean; shareable?: boolean } = { alive: true }): Peer {
  return {
    fp: "fp-1", name: "laptop", addr: "10.0.0.2", port: 4000, paired: true, lastSeen: NOW - 1000,
    offers: { at: NOW - 1000, accounts: [{ key: accountKey(WORK, ""), email: WORK, ...offer }] },
    ...over,
  };
}
const lanWith = (peers: Peer[], shared = [accountKey(WORK, "")]) =>
  ({ enabled: true, running: true, shared, peers } as unknown as LanStatus);

describe("which accounts the prompt names", () => {
  it("names every deck-signed-in account in an incident, in one list", () => {
    const rows = attentionRows([account(1, WORK), account(2, "home@example.com"), account(3, "ok@x.io", { reauth: null })],
      { lan: lanOff, now: NOW, closed: NONE });
    expect(rows.map(r => r.email)).toEqual([WORK, "home@example.com"]);
    expect(rows[0].id).toBe(incidentId(accountKey(WORK, ""), NOW - 60 * MIN));
  });

  it("leaves out what was put off, what was settled here, and what the deck did not sign in", () => {
    const a = account(1, WORK);
    expect(attentionRows([{ ...a, reauth: { ...a.reauth!, dismissed: true } }], { lan: lanOff, now: NOW, closed: NONE })).toEqual([]);
    expect(attentionRows([a], { lan: lanOff, now: NOW, closed: new Set([incidentId(a.reauth!.key, a.reauth!.since)]) })).toEqual([]);
    expect(attentionRows([{ ...a, origin: null }], { lan: lanOff, now: NOW, closed: NONE })).toEqual([]);
  });

  it("waits for the network's first answer, then reads an unreadable one as nothing coming", () => {
    expect(attentionRows([account(1, WORK)], { lan: undefined, now: NOW, closed: NONE })).toEqual([]);
    expect(attentionRows([account(1, WORK)], { lan: null, now: NOW, closed: NONE })).toHaveLength(1);
  });

  it("lets Local network repair the login first, when a paired deck online holds a live copy", () => {
    const key = accountKey(WORK, "");
    expect(lanRepairExpected(key, WORK, lanWith([peer()]), NOW)).toBe(true);
    expect(attentionRows([account(1, WORK)], { lan: lanWith([peer()]), now: NOW, closed: NONE })).toEqual([]);
  });

  it("asks when no repair can come", () => {
    const key = accountKey(WORK, "");
    const cases: Array<[string, LanStatus]> = [
      ["network off", lanOff],
      ["not running", { ...lanWith([peer()]), running: false }],
      ["not shared here", lanWith([peer()], [])],
      ["its copy is dead too", lanWith([peer({}, { alive: false })])],
      ["its copy cannot be handed over", lanWith([peer({}, { alive: true, shareable: false })])],
      ["the deck is offline", lanWith([peer({ lastSeen: NOW - 60 * MIN, last: null })])],
      ["not paired", lanWith([peer({ paired: false })])],
      ["its heal already failed", lanWith([peer({ last: { at: NOW - 1000, done: [{ email: WORK, action: "heal", ok: false }] } })])],
      // A heal that took clears claude-swap's failure as it lands, so an
      // incident after one is a copy that died again: waiting on that deck
      // would wait for as long as it stays online.
      ["its heal took and the login died again", lanWith([peer({ last: { at: NOW - 1000, done: [{ email: WORK, action: "heal", ok: true }] } })])],
    ];
    for (const [why, status] of cases) {
      expect(`${why}: ${lanRepairExpected(key, WORK, status, NOW)}`).toBe(`${why}: false`);
    }
    // A round that did something else with the account, or healed another
    // one, is still a repair to come.
    const other = lanWith([peer({ last: { at: NOW - 1000, done: [{ email: "other@x.io", action: "heal", ok: true }, { email: WORK, action: "add", ok: true }] } })]);
    expect(lanRepairExpected(key, WORK, other, NOW)).toBe(true);
  });

  it("takes an account off once a sign-in from the prompt recorded it", () => {
    const rows = attentionRows([account(1, WORK), account(2, "home@example.com")], { lan: lanOff, now: NOW, closed: NONE });
    expect(settledBy(rows, { num: "1", email: "WORK@example.com" })).toEqual([rows[0].id]);
    // Somebody approved a different address in the browser: that one is fixed,
    // not the one they were asked about.
    expect(settledBy(rows, { num: "7", email: "someone@else.io" })).toEqual([]);
    expect(settledBy(rows, { num: "2", email: WORK })).toEqual([]);
    expect(settledBy(rows, null)).toEqual([]);
  });
});

describe("when the prompt takes its turn", () => {
  it("waits for a dialog somebody already has open, then stays up whatever opens over it", () => {
    expect(promptShows({ rows: 2, ours: false, dialogs: 0 })).toBe(true);
    // The panel's own sign-in, a share, the tour: it does not paint over them.
    expect(promptShows({ rows: 2, ours: false, dialogs: 1 })).toBe(false);
    expect(promptShows({ rows: 2, ours: true, dialogs: 3 })).toBe(true);
    expect(promptShows({ rows: 0, ours: true, dialogs: 0 })).toBe(false);
    const host = src("../components/AccountAttentionModal.tsx");
    expect(host).toMatch(/promptShows\(\{ rows: rows\.length, ours: oursRef\.current, dialogs: modalStack\.dialogDepth\(\) \}\)/);
  });
});

// ── the dialog ──────────────────────────────────────────────────────────────

const row = (email: string, n = 1, alias: string | null = null): AttentionRow => ({
  id: `${email}#1`, key: `${email}@@`, since: 1, num: n, email, name: email, alias,
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noop = () => {};

describe("what the dialog says", () => {
  it("for one account: names it, says what stopped, offers Sign in again and Not now", () => {
    const html = renderToStaticMarkup(createElement(AccountAttentionModal, { rows: [row(WORK, 1, "Work")], onSignIn: noop, onLater: noop }));
    expect(attentionTitle(1)).toBe("Account needs your attention");
    expect(html).toContain("Account needs your attention");
    expect(text(html)).toContain(`The Claude login for ${WORK} (Work) has expired and needs a new sign‑in.`);
    expect(text(html)).toContain("it keeps its slot, its alias and its history");
    expect(html).toMatch(/<button[^>]*class="btn primary"[^>]*>Sign in again<\/button>/);
    expect(html).toMatch(/<button[^>]*>Not now<\/button>/);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="reauth-title"');
  });

  it("for several: one dialog, a count, and a row for each with its own Sign in again", () => {
    const rows = [row(WORK, 1), row("personal@example.com", 2)];
    const html = renderToStaticMarkup(createElement(AttentionBody, { rows, onSignIn: noop, onLater: noop }));
    expect(attentionTitle(2)).toBe("Accounts need your attention");
    expect(attentionLead(2)).toBe("2 Claude accounts need you to sign in again.");
    expect(text(html)).toContain("2 Claude accounts need you to sign in again.");
    for (const r of rows) {
      expect(html).toContain(`aria-label="Sign in again as ${r.email}"`);
    }
    expect(html.match(/Login expired/g)).toHaveLength(2);
    expect(html.match(/>Not now</g)).toHaveLength(1);
  });

  it("is calm: no warn colour, no error class, nothing alarming in its words", () => {
    const html = renderToStaticMarkup(createElement(AttentionBody, { rows: [row(WORK), row("b@x.io", 2)], onSignIn: noop, onLater: noop }));
    expect(html).not.toMatch(/aa-err|aa-warn|ap-warn|error/i);
    const sheet = src("../styles/add-account.css");
    const block = sheet.slice(sheet.indexOf(".modal.reauth-ask"));
    expect(block).not.toMatch(/var\(--(warn|err|danger)/);
  });

  it("uses the deck's modal system: the shared hook, Escape and the backdrop as Not now", () => {
    const modal = src("../components/AccountAttentionModal.tsx");
    expect(modal).toMatch(/const dialogRef = useModalDismiss\(onLater, \{ focusRef: firstRef \}\)/);
    expect(modal).toMatch(/<div className="modal-backdrop" onClick=\{onLater\} role="presentation">/);
    expect(modal).toMatch(/aria-label="Not now \(Esc\)"/);
  });
});

// ── wiring ──────────────────────────────────────────────────────────────────

describe("how it is wired", () => {
  it("opens the existing sign-in dialog for that account, and steps aside while it is open", () => {
    const modal = src("../components/AccountAttentionModal.tsx");
    expect(modal).toMatch(/<AddAccountDialog\s+email=\{signingIn\.email \|\| null\}/);
    expect(modal).toMatch(/onSignedIn=\{signedIn\}/);
    const dialog = src("../components/AddAccountDialog.tsx");
    // The address rides on the sign-in it already runs; without one it is the
    // bare request the panel's + → Add has always sent.
    expect(dialog).toMatch(/admin\(email \? \{ action: "login", email \} : \{ action: "login" \}\)/);
  });

  it("adds no poll: one read when the deck opens, one when somebody looks again, then the panel's own reads", () => {
    const hook = src("../use-account-attention.ts");
    expect(hook).not.toMatch(/setInterval|setTimeout/);
    expect(hook).toMatch(/useEffect\(\(\) => \{ if \(enabled\) void read\(false\); \}, \[enabled, read\]\);/);
    // Looking again is an event, rate-limited, and never forced.
    expect(hook).toMatch(/document\.addEventListener\("visibilitychange", look\)/);
    expect(hook).toMatch(/window\.addEventListener\("focus", look\)/);
    expect(hook).toMatch(/const LOOK_AGAIN_MS = 60_000;/);
    expect(hook.match(/void read\(true\)/g)).toHaveLength(1);   // only after a sign-in changed something
    const app = src("../App.tsx");
    expect(app).toMatch(/onRoster=\{attention\.observe\}/);
    expect(app).toMatch(/lanStatus: lanPairs\.lanStatus/);
    const panel = src("../components/AccountsPanel.tsx");
    expect(panel).toMatch(/onRosterRef\.current\?\.\(fresh\)/);
  });

  it("puts off an incident through the admin route, and only prefs.json changes", () => {
    const routes = src("../../server/account-routes.mjs");
    expect(routes).toMatch(/case "reauth-later": result = await dismissReauth\(parsed\.incidents\); break;/);
    expect(routes).toMatch(/await writeOrigins\(withDismissed\(incidents\)\)/);
    // A write that would change nothing is never made — a second "Not now"
    // from another tab, a sign-in of an account the deck never marked.
    expect(routes).toMatch(/async function writeOrigins\(mutate\) \{\s*if \(!mutate\(heldPrefs\.current\(\)\)\) return;\s*await heldPrefs\.update\(mutate\);\s*\}/);
    const hook = src("../use-account-attention.ts");
    expect(hook).toMatch(/action: "reauth-later", incidents: shown\.map\(r => \(\{ key: r\.key, since: r\.since \}\)\)/);
  });

  it("hands the roster and the sign-in flow their origins when the server starts", () => {
    expect(src("../../server/index.mjs")).toMatch(/wireStaleCopyRepair\(\);\s*\/\/[^\n]*\n[^\n]*\n\s*wireAccountOrigins\(\);/);
  });
});
