// Sharing accounts in `ccdeck tui`, as the deck's Accounts panel does: one
// account from its menu, several in one paste from the list, and on the other
// machine the paste taken in from the Add page's second tab. Claude's through
// the deck's admin route (account-routes.mjs: share, import), Codex's through
// its own two (codex-share.mjs), with the deck's words for every step
// (ShareAccountsDialog.tsx, AddAccountDialog.tsx, CodexShareDialog.tsx,
// CodexImportPane.tsx, share-bundle.ts, i18n/areas/{accounts,codex}/en.ts).
//
// THE TEXT IS A CREDENTIAL. A share carries each account's login in the clear,
// so it lives in one place, `state.share`, while its page is up and not a
// moment after: closing the page drops it. It is drawn on the screen and sent
// to the terminal's clipboard on a key, as the deck draws it and copies it;
// it is never put in a notice, never in an error — a refusal is the route's
// fixed reason code put into words here, never the route's own text — and
// never in anything the deck counts.
//
// Pure, like tui-view.mjs: a state and a key in, the next state and the one
// thing to go and do out; a state in, the rows to paint out. tui-view.mjs
// hands in what it owns (`note`, the copy notice, the panel drawing), and
// bin/cli/tui.js asks the deck.
import { accountName } from "./account-pick.mjs";
import { PRODUCT } from "./brand.mjs";
import { clip, oneLine, textWidth } from "./cli-lines.mjs";
import { codexRows } from "./tui-codex.mjs";

// ── the deck's words ────────────────────────────────────────────────────────

/** How many Codex accounts one share takes (codex-share.mjs). */
export const CODEX_SHARE_MAX = 20;
/** The longest paste each import route reads, what the field keeps: Claude's
 *  the admin route's whole body (http-io.mjs readBody, 64,000 bytes) less the
 *  JSON around the share, Codex's codex-share.mjs CODEX_SHARE_MAX_LENGTH. */
export const PASTE_MAX = Object.freeze({ claude: 63_900, codex: 512_000 });

const WORDS = Object.freeze({
  oneTitle: "Share account",
  setTitle: "Share accounts",
  codexTitle: "Share Codex accounts",
  expired: "This share has expired",
  liveNote: (arrow) => `Paste it into the other deck with + ${arrow} Paste a share. Accounts it already holds are left exactly as they are.`,
  deadNote: "Another deck will refuse this text now. Make a new one — the same accounts are still picked.",
  couldNotExport: "could not be exported",
  which: `Which accounts go to the other ${PRODUCT}?`,
  nothing: "Nothing to share",
  nothingNote: "This deck is not holding any accounts right now. Sign one in with +, or wait — the panel is still reading the store.",
  makeFailed: "the share could not be made",
  pasteTitle: "Paste an account shared from another deck",
  pasteNote: "Use share on one account in the other deck, or ↗ above its list to send several at once — e and E in its tui. A share carries a live login for every account in it and expires ten minutes after it is made.",
  importLive: "claude-swap is adding the accounts in this share. Any already here are left as they are.",
  importFailed: "the import failed",
  importNote: "Nothing changed on the deck you copied this from. An account already here is left as it is, unless its stored login was dead or you pressed update anyway.",
  updateTip: (email) => `u overwrites the stored login for ${email} with the one in this share. Do this when that account has stopped working here; if it works, leave it.`,
  updateFailed: "that account could not be updated",
  codexWarning: "The share code contains live sign-in credentials. Anyone with it can use these accounts. Send it only through a private channel you trust.",
  codexRenewal: "Both copies share an OAuth renewal token. Renewing the login on one machine may invalidate the other copy and require signing in again.",
  codexChoose: "Choose up to 20 accounts. Only ChatGPT logins stored in auth.json can be shared.",
  codexEmpty: "No Codex accounts to share.",
  codexCopyHint: (arrow) => `Copy the entire code, then paste it on the other deck under + ${arrow} Paste a share.`,
  codexNoExpiry: "This code is encoded, not encrypted. It has no automatic expiry or ccdeck revocation. Delete clipboard and message copies after use.",
  codexIsolated: "Each imported login gets a new isolated profile, without copied settings or history. Existing logins and the active account are kept. Repeat imports are skipped.",
  codexProtection: "Restricts access to each selected Codex folder and auth.json to your Windows user. This changes folder permissions, including inherited access for its contents. Your login, settings and active account stay in place.",
});

/** "1 account, ready to paste" (accounts.sd.ready). */
const readyLine = (n) => (n === 1 ? "1 account, ready to paste" : `${n} accounts, ready to paste`);
/** What the text is (accounts.sd.warn). */
const warnLine = (n) => (n === 1 ? "this is the password" : `this is ${n} passwords`);
/** The bundle came up short (accounts.sd.failedHead). */
const failedHead = (n) => (n === 1 ? "One account is not in this bundle:" : `${n} accounts are not in this bundle:`);

/** The line above the picker, counting tokens (share-bundle.ts shareCountLine). */
export function shareCountLine(n, g) {
  if (n <= 0) return "Nothing picked yet.";
  return n === 1
    ? `1 account ${g.dash} its sign-in token will be on your clipboard.`
    : `${n} accounts ${g.dash} ${n} sign-in tokens will be on your clipboard.`;
}

/** How much longer another deck takes the share (share-bundle.ts shareExpiry):
 *  `{ text, tone }`, tone `ok`, `soon` or `gone`. */
export function shareExpiry(expiresAt, nowMs) {
  const left = Math.round((Number(expiresAt) - nowMs) / 1000);
  if (!Number.isFinite(left) || left <= 0) return { text: "expired", tone: "gone" };
  if (left < 60) return { text: `expires in ${left}s`, tone: "soon" };
  return { text: `expires in ${Math.round(left / 60)}m`, tone: "ok" };
}

/** The word beside an account in an import's results (share-bundle.ts outcomeWord). */
export function outcomeWord(state) {
  switch (state) {
    case "imported": return "imported";
    case "healed": return "dead token replaced";
    case "updated": return "updated";
    case "present": return "already here";
    default: return "not imported";
  }
}

/** Something the Mac found wrong with an account once it landed (admin-failure.ts arrivalCheck). */
const ARRIVAL = Object.freeze({
  unreadable_here: { short: "Keychain locked on this Mac", long: `claude-swap could not read the login keychain — start ${PRODUCT} from a Terminal window rather than a background service.` },
  no_credentials_here: { short: "no stored login here", long: "claude-swap still holds no login for it here." },
  relogin_required_here: { short: "login expired", long: "the imported login was rejected — sign in again on a deck where it still works." },
  unverified_here: { short: "not checked", long: "claude-swap could not confirm whether this Mac can read it." },
});
export const arrivalCheck = (code) => (typeof code === "string" && Object.hasOwn(ARRIVAL, code) ? ARRIVAL[code] : null);

/** "2 of 3 imported, 1 already here." (share-bundle.ts importSummary). */
export function importSummary(results) {
  const total = results.length;
  if (!total) return "Nothing to import.";
  const count = (s) => results.filter(r => r.state === s).length;
  const parts = [];
  if (count("imported")) parts.push(`${count("imported")} of ${total} imported`);
  if (count("healed")) parts.push(`${count("healed")} had a dead token replaced`);
  if (count("updated")) parts.push(`${count("updated")} updated`);
  if (count("present")) parts.push(`${count("present")} already here`);
  if (count("failed")) parts.push(`${count("failed")} did not arrive`);
  const warnings = [...new Set(results.map(r => arrivalCheck(r.check)?.short).filter(Boolean))];
  return `${[...parts, ...warnings].join(", ")}.`;
}

/** A result row's identity: one address under two organizations is two accounts. */
export const importRowKey = (r) => `${r.email}|${r.org ?? ""}`;

/**
 * Why the deck would not share or import, in the deck's words for each fixed
 * reason code (admin-failure.ts REASONS, CodexShareDialog.tsx transferFailure)
 * — not the route's own text, which comes from claude-swap, the one place a
 * share could leak into a sentence. The one exception is a share's refusal,
 * whose sentence is said only when nothing in it looks like one (swapSentence).
 */
const CLAUDE_REFUSED = Object.freeze({
  not_a_share: "that does not look like a shared account — it should start with ccdeck2:",
  corrupt: "that share is incomplete — copy the whole thing",
  wrong_version: `that share was made by a newer ${PRODUCT}`,
  expired: "that share has expired — make a new one",
  import_failed: "claude-swap refused the import",
  unreadable_export: "claude-swap wrote something this deck could not read — try again, and upgrade it if this repeats",
  mixed_versions: "claude-swap changed format part-way through — try again",
  nothing_to_share: "none of those accounts could be exported",
  export_failed: "claude-swap could not export that account",
  too_many: "that is more accounts than one share can carry",
  not_in_bundle: "that account is not in this share",
  bad_account: "that is not an account claude-swap has",
  keychain_unavailable: `claude-swap could not read the login keychain — start ${PRODUCT} from a Terminal window rather than a background service`,
  no_cswap: "claude-swap could not be run — it is not on this deck's PATH",
  timeout: "claude-swap took too long and was stopped — try again",
});
const CODEX_REFUSED_SHARE = Object.freeze({
  windows_permissions_required: "Windows permissions prevent sharing this login. Secure the selected profiles, then try again.",
  windows_share_protection_failed: "Windows could not secure a selected profile. Close programs using its login file, run ccdeck without administrator rights and try again. Some permissions may already have been tightened.",
  file_auth_required: "A selected account has no exportable file login, or uses a keyring. Nothing was shared. Use a file-backed ChatGPT login.",
  unsupported_auth: "Only complete ChatGPT file logins are supported. API keys and unknown auth formats cannot be transferred.",
  invalid_share: "Invalid share code. Paste the entire ccdeck-codex-v1. code, with no extra text.",
  selection_conflict: "The account list changed. It has been read again — enter tries once more.",
  windows_permissions_failed: "Windows could not protect the new profile with a private ACL. No accounts were imported. Check folder permissions and try again.",
  share_too_large: "The selected logins exceed the share-code limit. Select fewer accounts and try again.",
});
const CODEX_FAILED = "The transfer could not finish. Reload the accounts and try again.";

/** claude-swap's own sentence about a share it could not make, one line —
 *  or nothing, if anything in it looks like a share or a login: the deck
 *  builds it from stderr alone, and this does not take that on trust. */
const LOOKS_SECRET = /ccdeck2:|ccdeck-codex-v1\.|[A-Za-z0-9+/_=-]{40,}/;
export function swapSentence(text) {
  const line = oneLine(text);
  return line && !LOOKS_SECRET.test(line) ? clip(line, 300) : "";
}

/**
 * A refusal in words: `{ ok: false }` answers by their reason code, a deck
 * that answered something else by its status. `fallback` is the deck's own
 * sentence for a failure it gave no known reason for.
 */
export function shareTrouble(r, { codex = false, fallback, deck = null, detail = false }) {
  const reason = typeof r?.body?.reason === "string" ? r.body.reason : null;
  // A Claude share's refusal carries claude-swap's own sentence, built from
  // its stderr alone because its output is the credential (cswap-admin.mjs).
  // It names what the reason code cannot — the keychain, the account — and
  // the web page leads with it too (admin-failure.ts explainFailure). An
  // import's is never said: that is claude-swap reading the share it was handed.
  const said = detail && !codex ? swapSentence(r?.body?.detail) : "";
  if (said) return said;
  if (r?.status === 413) return "that is longer than a share can be — copy the share alone";
  const map = codex ? CODEX_REFUSED_SHARE : CLAUDE_REFUSED;
  if (reason && Object.hasOwn(map, reason)) return map[reason];
  if (r?.status === 0) return "the deck did not answer";
  if (r?.status === 404 && !reason) {
    return `the deck${deck?.port ? ` on ${deck.port}` : ""} predates sharing from here — an update of ${PRODUCT} brings it`;
  }
  return codex ? CODEX_FAILED : fallback;
}

// ── what is on screen ───────────────────────────────────────────────────────

/** Whether a share page — the text, the paste, the results — covers the screen. */
export const sharePage = (state) => Boolean(state.share) && state.share.view !== "pick";
/** Whether the picker is up, in its box over the list. */
export const sharePicking = (state) => state.share?.view === "pick";
/** Whether the paste field is up: the terminal brackets a paste only then. */
export const takesPaste = (state) => state.share?.view === "paste";

/** The share up now, for the copy key's notice: said only while its text is on screen. */
export const shareValue = (state) => (state.share?.view === "shown" ? state.share.blob : null);

/** Whether a Claude share has run out, by the deck's clock. */
export function shareDead(sh, now, skew = 0) {
  if (!sh || sh.codex || sh.expiresAt == null) return false;
  return shareExpiry(sh.expiresAt, now + skew).tone === "gone";
}

/** The picker, everything ticked for Claude (the deck moves the whole set);
 *  for Codex the ones named, as the Codex panel opens it. */
export function openPick(codex, { picked = [], protect = false, error = null } = {}) {
  return codex
    ? { view: "pick", codex: true, picked: [...picked], at: 0, protect, error }
    : { view: "pick", codex: false, unpicked: [], at: 0, error };
}

/** The paste field, empty. `email` is the sign-in tab it came from. */
export function openPaste(codex, email = null) {
  return { view: "paste", codex, email, draft: "", sending: false, error: null };
}

/** The accounts the picker lists: `{ key, label, sub }` and the slot or id.
 *  The label is the one the list leads with, the second line only where the
 *  label alone cannot tell two apart (share-bundle.ts pickerRows). */
export function pickRows(state) {
  if (state.share?.codex) {
    return codexRows(state).map(r => ({ key: r.id, id: r.id, label: r.alias || r.email || `account ${r.num}`, sub: r.alias && r.email ? r.email : null }));
  }
  const accounts = state.roster?.ok && Array.isArray(state.roster.accounts) ? state.roster.accounts : [];
  const seen = new Map();
  for (const a of accounts) {
    const k = oneLine(a.email).toLowerCase();
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return accounts.map(a => {
    const email = oneLine(a.email);
    const alias = oneLine(a.alias);
    const parts = [];
    if (alias && email) parts.push(email);
    if (email && (seen.get(email.toLowerCase()) ?? 0) > 1) parts.push(oneLine(a.org) || `slot ${a.num}`);
    return { key: a.num, num: a.num, label: alias || email || `account ${a.num}`, sub: parts.length ? parts.join(" · ") : null };
  });
}

/** Whether a picker row is ticked. */
const ticked = (sh, row) => (sh.codex ? sh.picked.includes(row.id) : !sh.unpicked.includes(row.num));

/** What the picker would send: the ticked rows, in the list's order. */
export function pickedOf(state) {
  const sh = state.share;
  return pickRows(state).filter(r => ticked(sh, r)).map(r => (sh.codex ? r.id : r.num));
}

/** A share's text, only as the deck makes them: printable ASCII, nothing a
 *  terminal could read as anything but a character. */
const safeBlob = (b) => (typeof b === "string" && b.length > 0 && /^[\x21-\x7e]+$/.test(b) ? b : null);

/**
 * The deck's answer to a share, as the page that shows it — the menu closed.
 * `e` is the effect that asked (`{ codex, nums | ids, from, several }`).
 * Null when the answer carries no text this page may draw.
 */
export function shareMade(state, e, body) {
  const blob = safeBlob(body?.blob);
  if (!blob) return null;
  const codex = e.codex === true;
  const failed = !codex && Array.isArray(body.failed)
    ? body.failed.map(f => ({ num: String(f?.num ?? ""), email: oneLine(f?.email), detail: swapSentence(f?.detail) })) : [];
  const count = codex ? (Number.isInteger(body.count) ? body.count : e.ids.length)
    : Array.isArray(body.shared) ? body.shared.length : e.nums.length;
  const expiresAt = !codex && Number.isFinite(Number(body.expiresAt)) ? Number(body.expiresAt) : null;
  return {
    ...state,
    menu: null,
    help: false,
    share: {
      view: "shown", codex, blob, expiresAt, count, failed, several: e.several === true,
      nums: codex ? null : [...e.nums], ids: codex ? [...e.ids] : null, alone: false, part: 0, parts: 1, error: null,
    },
  };
}

/**
 * A share the deck refused, said where it was asked: under the picker, on the
 * page that asked for a new one, under the menu, or as a notice. A Codex login
 * Windows will not hand over without tightening its folder first opens the
 * picker on it, offering to do that, as the Codex panel does.
 */
export function shareFailed(state, e, why, reason, { note, now, g }) {
  const codex = e.codex === true;
  if (codex && reason === "windows_permissions_required") {
    if (state.share?.view === "pick") return { ...state, share: { ...state.share, protect: true, error: why } };
    return { ...state, menu: null, share: openPick(true, { picked: e.ids, protect: true, error: why }) };
  }
  if ((e.from === "pick" || e.from === "again") && state.share) return { ...state, share: { ...state.share, error: why } };
  if (e.from === "menu" && state.menu) return { ...state, menu: { ...state.menu, error: why } };
  return { ...state, notice: note("err", `could not share ${e.name ?? "the account"} ${g.dash} ${why}`, now) };
}

/** An import's answer as the results page. Claude's keeps the share while the
 *  page is up, for "update anyway"; Codex's has no such thing to keep it for. */
export function withImported(state, { codex, results, blob = null }) {
  const sh = state.share;
  const rows = Array.isArray(results) ? results : [];
  return {
    ...state,
    share: codex
      ? { view: "results", codex: true, results: rows.map(r => ({ id: String(r?.id ?? ""), status: String(r?.status ?? "") })), at: 0 }
      : {
        view: "results", codex: false, email: sh?.email ?? null, at: 0, forcing: null, rowError: null, blob,
        results: rows.map(r => ({
          email: oneLine(r?.email), org: typeof r?.org === "string" ? r.org : "", num: r?.num == null ? null : String(r.num),
          state: String(r?.state ?? "failed"), ...(typeof r?.check === "string" ? { check: r.check } : {}),
        })),
      },
  };
}

/** One row of the results replaced, after "update anyway" — only while the
 *  results are still the ones on screen (share-bundle.ts replaceImportRow). */
export function withUpdated(state, key, fresh) {
  const sh = state.share;
  if (sh?.view !== "results" || sh.codex) return state;
  const row = {
    email: oneLine(fresh?.email), org: typeof fresh?.org === "string" ? fresh.org : "", num: fresh?.num == null ? null : String(fresh.num),
    state: String(fresh?.state ?? "failed"), ...(typeof fresh?.check === "string" ? { check: fresh.check } : {}),
  };
  return { ...state, share: { ...sh, forcing: null, rowError: null, results: sh.results.map(r => (importRowKey(r) === key ? row : r)) } };
}

/** What a paste puts in the field: the share's own characters, and nothing
 *  else — a selection copied off wrapped rows comes with a newline at each
 *  row's end, and a message may add a space or a tab. */
export const pastedText = (s) => String(s ?? "").replace(/[^\x21-\x7e]/g, "");

// ── the keys ────────────────────────────────────────────────────────────────

/**
 * A key while a share is up: `{ state, effect }`. `ctx` carries what
 * tui-view.mjs owns: `note`, `copied` and `forgetCopied` (the copy key's
 * notice), `signinTab(state, sh)` (the Add page's other tab) and
 * `selectSlot`. Effects:
 *
 *   { type: "share", codex, nums | ids, protect?, from, several }   make one
 *   { type: "share-import", codex, blob, revision? }               take one in
 *   { type: "share-update", key }                                  update anyway
 *   { type: "copy", text }                                         the clipboard
 */
export function shareKey(state, str, key, ctx) {
  const sh = state.share;
  const name = key.name ?? "";
  const stay = { state, effect: null };
  // While the deck works on what was asked, the page waits for its answer.
  if (state.busy) return stay;
  const set = (patch) => ({ state: { ...state, share: { ...sh, ...patch } }, effect: null });
  const close = (patch = {}) => ({ state: { ...ctx.forgetCopied(state), share: null, ...patch }, effect: null });
  const enter = name === "return" || name === "enter";
  const up = name === "up" || (str === "k" && sh.view !== "paste");
  const down = name === "down" || (str === "j" && sh.view !== "paste");
  const noDeck = (what) => set({ error: `${what} goes through the deck ${ctx.g.dash} esc, then d starts one` });

  if (sh.view === "pick") {
    const rows = pickRows(state);
    if (name === "escape" || str === "q") return close();
    if (!rows.length) return enter ? close() : stay;
    const at = Math.max(0, Math.min(sh.at, rows.length - 1));
    if (up) return set({ at: (at - 1 + rows.length) % rows.length });
    if (down || name === "tab") return set({ at: (at + 1) % rows.length });
    if (str === " " || name === "space") {
      const row = rows[at];
      // The selection that Windows refused is the one "secure and share"
      // is for: another tick asks the deck again, as the Codex panel does.
      if (sh.codex) return set({ picked: sh.picked.includes(row.id) ? sh.picked.filter(id => id !== row.id) : [...sh.picked, row.id], protect: false, error: null, at });
      return set({ unpicked: sh.unpicked.includes(row.num) ? sh.unpicked.filter(n => n !== row.num) : [...sh.unpicked, row.num], error: null, at });
    }
    if (str === "a" && !sh.codex) {
      const all = rows.every(r => ticked(sh, r));
      return set({ unpicked: all ? rows.map(r => r.num) : [], error: null });
    }
    if (enter) {
      const picked = pickedOf(state);
      if (!picked.length) return stay;
      if (!state.deck) return noDeck("sharing");
      if (sh.codex) {
        if (picked.length > CODEX_SHARE_MAX) return set({ error: WORDS.codexChoose });
        return { state: { ...state, share: { ...sh, error: null } }, effect: { type: "share", codex: true, ids: picked, protect: sh.protect === true, from: "pick", several: true } };
      }
      return { state: { ...state, share: { ...sh, error: null } }, effect: { type: "share", codex: false, nums: picked, from: "pick", several: true } };
    }
    return stay;
  }

  if (sh.view === "shown") {
    const dead = shareDead(sh, ctx.now, state.skew ?? 0);
    const copyKey = str === "c" || (key.ctrl && name === "o");
    const expired = () => ({ state: { ...state, notice: ctx.note("info", `this share has expired ${ctx.g.dash} ${sh.alone ? "tab goes back, where enter makes a new one" : "enter makes a new one"}`, ctx.now) }, effect: null });
    if (sh.alone) {
      if (copyKey) return dead ? expired() : ctx.copied(state, sh.blob, true);
      const last = Math.max(0, (sh.parts ?? 1) - 1);
      if (name === "right" || str === "n") return sh.part < last ? set({ part: sh.part + 1 }) : stay;
      if (name === "left" || str === "p") return sh.part > 0 ? set({ part: sh.part - 1 }) : stay;
      if (name === "escape" || name === "tab" || enter || str === "q") {
        return { state: { ...ctx.forgetCopied(state), share: { ...sh, alone: false, part: 0 } }, effect: null };
      }
      return stay;
    }
    if (dead) {
      if (enter) {
        if (!state.deck) return noDeck("a new share");
        return { state: { ...ctx.forgetCopied(state), share: { ...sh, error: null } }, effect: { type: "share", codex: false, nums: sh.nums, from: "again", several: sh.several } };
      }
      if (copyKey) return expired();
    } else if (copyKey || enter) return ctx.copied(state, sh.blob, false);
    if (name === "tab") return { state: { ...ctx.forgetCopied(state), share: { ...sh, alone: true, part: 0 } }, effect: null };
    if (name === "escape" || str === "q") return close();
    return stay;
  }

  if (sh.view === "paste") {
    const max = sh.codex ? PASTE_MAX.codex : PASTE_MAX.claude;
    // A share made on the other tab: said here, not sent for the deck to
    // refuse in words that do not say where it goes.
    const elsewhere = (draft) => (draft.trimStart().startsWith(sh.codex ? "ccdeck2:" : "ccdeck-codex-v1.")
      ? `that is a ${sh.codex ? "Claude" : "Codex"} share ${ctx.g.dash} paste it on the ${sh.codex ? "Claude" : "Codex"} tab`
      : null);
    const add = (text) => {
      if (sh.sending || !text) return stay;
      const draft = `${sh.draft}${text}`;
      return draft.length > max
        ? set({ draft: draft.slice(0, max), error: `that is longer than a share can be ${ctx.g.dash} ctrl+u clears it, then paste the share alone` })
        : set({ draft, error: elsewhere(draft) });
    };
    // The whole paste at once, the terminal's own brackets around it: a
    // newline inside it is a character, not enter.
    if (name === "paste") return add(pastedText(str));
    if (sh.sending) return stay;
    if (name === "escape") return close();
    if (name === "tab") return { state: ctx.signinTab(state, sh), effect: null };
    if (enter) {
      const blob = sh.draft;
      if (!blob) return stay;
      const wrong = elsewhere(blob);
      if (wrong) return set({ error: wrong });
      if (!state.deck) return noDeck("an import");
      if (sh.codex) {
        const revision = state.codex?.revision;
        if (!Number.isFinite(revision)) return set({ error: `reading the Codex accounts${ctx.g.ellipsis} try again in a moment` });
        return { state: { ...state, share: { ...sh, sending: true, error: null } }, effect: { type: "share-import", codex: true, blob, revision } };
      }
      return { state: { ...state, share: { ...sh, sending: true, error: null } }, effect: { type: "share-import", codex: false, blob } };
    }
    if (name === "backspace") return set({ draft: sh.draft.slice(0, -1), error: null });
    if (key.ctrl && name === "u") return set({ draft: "", error: null });
    // Typed, or pasted by a terminal that does not bracket a paste: one
    // character a key, and a newline then is enter.
    if (typeof str === "string" && !key.ctrl && !key.meta && /^[\x21-\x7e]+$/.test(str)) return add(str);
    return stay;
  }

  // The results.
  const rows = sh.results;
  const at = Math.max(0, Math.min(sh.at ?? 0, rows.length - 1));
  if (up && rows.length) return set({ at: (at - 1 + rows.length) % rows.length });
  if (down && rows.length) return set({ at: (at + 1) % rows.length });
  if (str === "u" && !sh.codex) {
    const row = rows[at];
    if (row?.state !== "present" || !sh.blob) return stay;
    if (!state.deck) return set({ rowError: { key: importRowKey(row), text: `an update goes through the deck ${ctx.g.dash} esc, then d starts one` } });
    return { state: { ...state, share: { ...sh, forcing: importRowKey(row), rowError: null } }, effect: { type: "share-update", key: importRowKey(row) } };
  }
  if (str === "a") return { state: { ...state, share: openPaste(sh.codex, sh.email ?? null) }, effect: null };
  if (enter || name === "escape" || str === "q") {
    const came = sh.codex ? [] : rows.filter(r => r.state === "imported" && r.num != null);
    const closed = close();
    return came.length === 1 ? { state: ctx.selectSlot(closed.state, Number(came[0].num)), effect: null } : closed;
  }
  return stay;
}

/** The footer's keys while a share is up. */
export function shareKeys(state, { unicode, now }) {
  const sh = state.share;
  const arrows = unicode ? "↑↓" : "up/down";
  if (sh.view === "pick") {
    const rows = pickRows(state);
    if (!rows.length) return [["esc", "close"]];
    const go = pickedOf(state).length ? [["enter", sh.codex ? (sh.protect ? "secure and share" : "make the share") : "share"]] : [];
    if (sh.codex) return [[arrows, "move"], ["space", "tick"], ...go, ["esc", "close"]];
    const all = rows.every(r => ticked(sh, r));
    return [[arrows, "move"], ["space", "tick"], ["a", all ? "clear all" : "select all"], ...go, ["esc", "close"]];
  }
  if (sh.view === "shown") {
    if (sh.alone) {
      const dead = shareDead(sh, now, state.skew ?? 0);
      return [...((sh.parts ?? 1) > 1 && !dead ? [[unicode ? "←→" : "left/right", "parts"]] : []), ...(dead ? [] : [["c", "copy"]]), ["esc", "back"]];
    }
    if (shareDead(sh, now, state.skew ?? 0)) return [["enter", "make a new share"], ["esc", "close"]];
    return [["c", "copy"], ["tab", "text alone"], ["esc", "close"]];
  }
  if (sh.view === "paste") return sh.sending ? [] : [["enter", "import"], ["tab", "sign in"], ["esc", "close"]];
  const row = sh.results[sh.at ?? 0];
  return [
    ...(sh.results.length > 1 ? [[arrows, "move"]] : []),
    ...(!sh.codex && row?.state === "present" && sh.blob ? [["u", "update anyway"]] : []),
    ["a", "import another"],
    ["enter", "done"],
  ];
}

// ── drawing ─────────────────────────────────────────────────────────────────

/**
 * The picker, in a box over the list as an account's menu is: `{ title,
 * footRight, lines, selected }`, `inner` columns wide and at most `room` rows
 * — the accounts scroll to keep the selection in it.
 */
export function sharePickSpec(state, inner, room, look) {
  const { tone, g, unicode } = look;
  const plain = look.plain ?? ((l) => l);
  const sh = state.share;
  const rows = pickRows(state);
  const say = (text, code = tone.muted) => wrap(plain(text), inner).map(l => `${code}${l}${tone.reset}`);
  const refused = sh.error ? wrap(plain(sh.error), inner - 3).map((l, i) => `${tone.err}${i ? "   " : `${g.fail}  `}${l}${tone.reset}`) : [];
  const box = (on) => (on ? (unicode ? "[✓]" : "[x]") : "[ ]");
  const foot = [`${tone.muted}space ticks ${g.bullet} enter shares ${g.bullet} esc closes${tone.reset}`, `${tone.muted}esc closes${tone.reset}`];
  const title = `${tone.bold}${sh.codex ? WORDS.codexTitle : WORDS.setTitle}${tone.reset}`;
  if (!rows.length) {
    return {
      title, footRight: `${tone.muted}esc closes${tone.reset}`,
      lines: sh.codex ? say(WORDS.codexEmpty) : [`${tone.bold}${WORDS.nothing}${tone.reset}`, ...say(dashed(WORDS.nothingNote, g))],
      selected: -1,
    };
  }
  const n = pickedOf(state).length;
  const head = sh.codex
    ? [...say(WORDS.codexWarning, tone.warn), ...say(WORDS.codexRenewal), ...say(WORDS.codexChoose), ...(sh.protect ? say(WORDS.codexProtection) : [])]
    : [`${tone.bold}${plain(WORDS.which)}${tone.reset}`, ...say(shareCountLine(n, g), n ? tone.warn : tone.muted)];
  const at = Math.max(0, Math.min(sh.at, rows.length - 1));
  const listed = rows.map((r, i) => {
    const pointer = i === at ? `${tone.accent}${tone.bold}${unicode ? "›" : ">"}${tone.reset}` : " ";
    const label = plain(oneLine(r.label));
    const sub = r.sub ? plain(oneLine(r.sub)) : "";
    const room = inner - 6;
    const shownLabel = clip(label, room, g.ellipsis);
    const rest = room - textWidth(shownLabel) - 2;
    return `${pointer} ${ticked(sh, r) ? tone.ok : tone.muted}${box(ticked(sh, r))}${tone.reset} ${shownLabel}${sub && rest > 4 ? `  ${tone.muted}${clip(sub, rest, g.ellipsis)}${tone.reset}` : ""}`;
  });
  // The rows that fit under the words, scrolled so the selection is among them;
  // on a short screen the words give way first, down to their first line.
  const keep = Math.max(1, Math.min(head.length, room - 1 - refused.length - Math.min(rows.length, 3)));
  head.length = keep;
  const fixed = head.length + 1 + refused.length;
  const fit = Math.max(1, Math.min(rows.length, room - fixed));
  const top = Math.max(0, Math.min(at - fit + 1, rows.length - fit, at));
  const shown = listed.slice(Math.max(0, top), Math.max(0, top) + fit);
  return {
    title,
    note: rows.length > fit ? `${tone.muted}${top + 1}${unicode ? "–" : "-"}${top + shown.length} of ${rows.length}${tone.reset}` : "",
    footRight: foot,
    lines: [...head, "", ...shown, ...refused],
    selected: head.length + 1 + (at - top),
  };
}

/**
 * A share page, `room` rows under the title bar: `{ lines, run, parts }`, as
 * the sign-in pages give. `look.box(width, height, spec)` draws a panel.
 */
export function sharePageLines(state, room, width, columns, look) {
  const sh = state.share;
  if (sh.view === "shown") return sh.alone ? aloneLines(state, room, width, columns, look) : shownLines(state, room, width, columns, look);
  if (sh.view === "paste") return pasteLines(state, room, width, look);
  return resultsLines(state, room, width, look);
}

const pad = (lines, room) => [...lines, ...Array.from({ length: Math.max(0, room - lines.length) }, () => "")].slice(0, room);

/** The share, its warning and its countdown above it, its text edge to edge —
 *  one run the terminal wraps, so a selection takes it whole. */
function shownLines(state, room, width, columns, look) {
  const { tone, g, now } = look;
  const plain = look.plain ?? ((l) => l);
  const sh = state.share;
  const say = (text, code = tone.muted) => wrap(plain(text), width - 2).map(l => `  ${code}${l}${tone.reset}`);
  const dead = shareDead(sh, now, state.skew ?? 0);
  const title = sh.codex ? WORDS.codexTitle : sh.several ? WORDS.setTitle : WORDS.oneTitle;
  const heading = dead ? WORDS.expired : readyLine(sh.count);
  const head = [`  ${tone.bold}${title}${tone.reset}  ${tone.muted}${g.bullet}${tone.reset}  ${dead ? tone.err : ""}${heading}${tone.reset}`];
  let warn;
  if (sh.codex) warn = say(WORDS.codexWarning, tone.warn);
  else {
    const exp = shareExpiry(sh.expiresAt, now + (state.skew ?? 0));
    const ink = exp.tone === "gone" ? tone.err : exp.tone === "soon" ? tone.warn : tone.muted;
    warn = [`  ${tone.warn}${warnLine(sh.count)}${tone.reset} ${tone.muted}${g.bullet}${tone.reset} ${ink}${exp.text}${tone.reset}`];
  }
  const pieces = chunks(sh.blob, columns);
  const failed = sh.failed?.length
    ? ["", ...say(failedHead(sh.failed.length), tone.warn), ...sh.failed.map(f => failedRow(f, width, plain, tone))]
    : [];
  const notes = sh.codex
    ? [...say(WORDS.codexCopyHint(g.arrow)), ...say(WORDS.codexNoExpiry), ...say(WORDS.codexRenewal)]
    : say(dead ? dashed(WORDS.deadNote, g) : WORDS.liveNote(g.arrow));
  const blocks = {
    top: [""],
    head,
    warn,
    gap: [""],
    text: pieces,
    gap2: [""],
    failed,
    error: sh.error ? say(sh.error, tone.err) : [],
    notes,
  };
  const order = ["top", "head", "warn", "gap", "text", "gap2", "failed", "error", "notes"];
  const shown = new Set(order);
  const height = () => order.filter(b => shown.has(b)).reduce((n, b) => n + blocks[b].length, 0);
  // A text that does not fit whole with what must go with it is no text to
  // select: the page says so, and keeps its room for the rest.
  const must = ["head", "warn", "text", "failed", "error"].reduce((n, b) => n + blocks[b].length, 0);
  if (must > room) blocks.text = say(`the text needs ${pieces.length} rows here ${g.dash} tab shows it alone, c sends it to your clipboard`, tone.warn);
  for (const drop of ["notes", "top", "gap2", "gap"]) {
    if (height() <= room) break;
    shown.delete(drop);
  }
  return place(order, shown, blocks, pieces, sh.blob, columns, room, tone);
}

/** An account left out of a share: its name, and claude-swap's reason where
 *  it gave one (stderr alone — see shareTrouble), cut to the row. */
function failedRow(f, width, plain, tone) {
  const name = plain(oneLine(f.email || `account ${f.num}`));
  const why = swapSentence(f.detail) || WORDS.couldNotExport;
  return `    ${name}  ${tone.muted}${clip(plain(why), Math.max(8, width - 6 - textWidth(name)))}${tone.reset}`;
}

/**
 * The text with nothing else on its rows (tab), for a selection to take
 * exactly it — and, where it is longer than the screen, a part at a time:
 * each part pasted on the other machine adds to its field, so the parts in
 * order are the whole share.
 */
function aloneLines(state, room, width, columns, look) {
  const { tone, g, now } = look;
  const plain = look.plain ?? ((l) => l);
  const sh = state.share;
  const say = (text, code = tone.muted) => wrap(plain(text), width - 2).map(l => `  ${code}${l}${tone.reset}`);
  const whole = chunks(sh.blob, columns);
  // One part when the text and a line about it fit; otherwise as many as it
  // takes, each the screen's rows less the line that says which part it is.
  const per = Math.max(1, room - 1) * columns;
  const parts = whole.length + 1 <= room ? 1 : Math.ceil(sh.blob.length / per);
  const part = Math.max(0, Math.min(sh.part ?? 0, parts - 1));
  const text = parts === 1 ? sh.blob : sh.blob.slice(part * per, (part + 1) * per);
  const pieces = chunks(text, columns);
  const clipHint = `c asks your terminal to put the ${sh.codex ? "code" : "share"} on your clipboard. Some terminals do not allow it, and tmux lets it through only with set -g set-clipboard on.`;
  const blocks = {
    top: [""],
    // Run out while it was up: the text stays, the page says it is no use.
    open: shareDead(sh, now, state.skew ?? 0)
      ? say(`${WORDS.expired} ${g.dash} the other deck will refuse it. tab goes back, where enter makes a new one.`, tone.err)
      : parts === 1
        ? say("Select this text to copy it:", "")
        : [`  ${tone.bold}Part ${part + 1} of ${parts}${tone.reset}${tone.muted} ${g.dash} paste them there in order${tone.reset}`],
    text: pieces,
    after: ["", ...say(parts === 1
      ? "tab or esc goes back to the share."
      : "Each part pasted into the field there adds to it; press enter there after the last. tab or esc goes back.")],
    clip: say(clipHint),
  };
  const order = ["top", "open", "text", "after", "clip"];
  const shown = new Set(order);
  const height = () => order.filter(b => shown.has(b)).reduce((n, b) => n + blocks[b].length, 0);
  for (const drop of ["clip", "after", "top"]) {
    if (height() <= room) break;
    shown.delete(drop);
  }
  if (parts === 1 && height() > room) shown.delete("open");
  if (height() > room) blocks.text = say(`make the window taller to see the text ${g.dash} c sends it to your clipboard`, tone.warn);
  return { ...place(order, shown, blocks, pieces, text, columns, room, tone), parts };
}

/** The blocks in order, the text's rows marked as the run. */
function place(order, shown, blocks, pieces, text, columns, room, tone) {
  const lines = [];
  let run = null;
  for (const b of order) {
    if (!shown.has(b)) continue;
    if (b === "text" && blocks.text === pieces) run = { row: lines.length, rows: pieces.length, full: text.length % columns === 0, text: `${tone.accent}${text}${tone.reset}` };
    lines.push(...blocks[b]);
  }
  return { lines: pad(lines, room), run: run && run.row + run.rows <= room ? run : null, parts: 1 };
}

/** The Add page's tabs, on its panel's top border: the one shown lit. */
export function addTabs(paste, { tone, g }) {
  return paste
    ? `${tone.muted}Sign in ${g.bullet}${tone.reset} ${tone.bold}Paste a share${tone.reset}`
    : `${tone.bold}Sign in${tone.reset} ${tone.muted}${g.bullet} Paste a share${tone.reset}`;
}

/** The paste field, in the Add page's panel: the share's ends and its length,
 *  which says whether the whole of it arrived. */
function pasteLines(state, room, width, look) {
  const { tone, g, unicode } = look;
  const plain = look.plain ?? ((l) => l);
  const sh = state.share;
  const inner = width - 4;
  const say = (text, code = tone.muted) => wrap(plain(text), inner).map(l => `${code}${l}${tone.reset}`);
  const caret = sh.sending ? "" : `${tone.accent}${unicode ? "▏" : "_"}${tone.reset}`;
  const d = sh.draft;
  const n = d.length;
  // The share's two ends and its length, in the room the field has: the
  // length is how a paste that came up short shows.
  const count = `${n.toLocaleString("en-US")} characters`;
  const fieldW = Math.max(8, inner - 3 - textWidth(count) - 2);
  const head = Math.max(4, Math.ceil((fieldW - textWidth(g.ellipsis)) * 2 / 3));
  const ends = n <= fieldW ? d : `${d.slice(0, head)}${g.ellipsis}${d.slice(-Math.max(2, fieldW - textWidth(g.ellipsis) - head))}`;
  const field = n
    ? `${tone.accent}${unicode ? "›" : ">"}${tone.reset} ${ends}${caret}  ${tone.muted}${count}${tone.reset}`
    : `${tone.accent}${unicode ? "›" : ">"}${tone.reset} ${caret}${tone.muted}${sh.codex ? "ccdeck-codex-v1." : "ccdeck2:"}${g.ellipsis}${tone.reset}`;
  const refused = sh.error && !sh.sending ? wrap(plain(sh.error), inner - 3).map((l, i) => `${tone.err}${i ? "   " : `${g.fail}  `}${l}${tone.reset}`) : [];
  const lines = [
    `${tone.bold}${WORDS.pasteTitle}${tone.reset}`,
    "",
    field,
    ...refused,
    "",
    ...(sh.sending ? say(sh.codex ? `importing${g.ellipsis}` : WORDS.importLive) : say(sh.codex ? WORDS.codexIsolated : dashed(WORDS.pasteNote, g, unicode))),
  ];
  const title = `${tone.bold}${sh.codex ? "Add a Codex account" : sh.email ? "Sign in again" : "Add a Claude account"}${tone.reset}`;
  const box = look.box(width, Math.min(room, lines.length + 2), { title, note: addTabs(true, look), lines });
  return { lines: pad(box, room), run: null, parts: 1 };
}

/** What the import did, account by account, the deck's word beside each. */
function resultsLines(state, room, width, look) {
  const { tone, g, unicode } = look;
  const plain = look.plain ?? ((l) => l);
  const sh = state.share;
  const inner = width - 4;
  const say = (text, code = tone.muted) => wrap(plain(text), inner).map(l => `${code}${l}${tone.reset}`);
  const at = Math.max(0, Math.min(sh.at ?? 0, sh.results.length - 1));
  const pointer = `${tone.accent}${tone.bold}${unicode ? "›" : ">"}${tone.reset}`;
  const lines = [];
  let selected = -1;
  if (sh.codex) {
    const added = sh.results.filter(r => r.status === "imported").length;
    const skipped = sh.results.filter(r => r.status === "already_imported").length;
    lines.push(`${tone.ok}${g.ok}${tone.reset}  ${tone.bold}Added: ${added}. Already imported: ${skipped}.${tone.reset}`, "");
    const named = codexRows(state);
    const nameW = Math.min(inner - 22, Math.max(8, ...sh.results.map(r => textWidth(plain(accountName(named.find(p => p.id === r.id)) || "an account")))));
    sh.results.forEach((r, i) => {
      if (i === at) selected = lines.length;
      const who = plain(accountName(named.find(p => p.id === r.id)) || "an account");
      const word = r.status === "imported" ? `${tone.ok}added${tone.reset}` : `${tone.muted}already imported${tone.reset}`;
      lines.push(`${i === at ? pointer : " "} ${padEnd(clip(who, nameW, g.ellipsis), nameW)}  ${word}`);
    });
    lines.push("", ...say(WORDS.codexIsolated));
  } else {
    const trouble = sh.results.some(r => r.state === "failed" || arrivalCheck(r.check));
    const mark = `${trouble ? `${tone.warn}${g.warn}` : `${tone.ok}${g.ok}`}${tone.reset}`;
    lines.push(...wrap(plain(importSummary(sh.results)), inner - 3).map((l, i) => `${i ? "   " : `${mark}  `}${tone.bold}${l}${tone.reset}`), "");
    const who = (r) => plain(r.email || (r.num ? `slot ${r.num}` : "an account"));
    const nameW = Math.min(inner - 24, Math.max(8, ...sh.results.map(r => textWidth(who(r)))));
    sh.results.forEach((r, i) => {
      const key = importRowKey(r);
      if (i === at) selected = lines.length;
      const ink = r.state === "failed" ? tone.err : r.state === "present" ? tone.muted : tone.ok;
      const word = sh.forcing === key ? `${tone.muted}updating${g.ellipsis}${tone.reset}` : `${ink}${outcomeWord(r.state)}${tone.reset}`;
      lines.push(`${i === at ? pointer : " "} ${padEnd(clip(who(r), nameW, g.ellipsis), nameW)}  ${word}`);
      const check = arrivalCheck(r.check);
      if (check) lines.push(...wrap(plain(check.long), inner - 4).map(l => `    ${tone.warn}${l}${tone.reset}`));
      if (sh.rowError?.key === key) lines.push(...wrap(plain(sh.rowError.text), inner - 4).map(l => `    ${tone.err}${l}${tone.reset}`));
      if (i === at && r.state === "present" && sh.blob && sh.forcing !== key) {
        lines.push(...wrap(plain(WORDS.updateTip(r.email || "it")), inner - 4).map(l => `    ${tone.muted}${l}${tone.reset}`));
      }
    });
    lines.push("", ...say(WORDS.importNote));
  }
  const title = `${tone.bold}${sh.codex ? "Add a Codex account" : sh.email ? "Sign in again" : "Add a Claude account"}${tone.reset}`;
  // The selection kept in view on a short screen: the lines above it give way.
  const height = Math.min(room, lines.length + 2);
  const over = Math.max(0, lines.length + 2 - room);
  const from = Math.min(over, Math.max(0, selected - 2));
  const box = look.box(width, height, { title, note: addTabs(true, look), lines: lines.slice(from), selected: selected - from });
  return { lines: pad(box, room), run: null, parts: 1 };
}

// ── text ────────────────────────────────────────────────────────────────────

/** The deck's em dash, as this console draws it. */
const dashed = (s, g, unicode = true) => s.replaceAll("—", g.dash).replaceAll("↗", unicode ? "↗" : "^");

const padEnd = (s, n) => s + " ".repeat(Math.max(0, n - textWidth(s)));

function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    if (line && textWidth(`${line} ${word}`) > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.flatMap(l => (textWidth(l) > width ? chunks(l, width) : [l]));
}

/** Text with no spaces — a share — cut into lines `width` wide. */
function chunks(text, width) {
  const cells = [...String(text)];
  const out = [];
  for (let i = 0; i < cells.length; i += Math.max(1, width)) out.push(cells.slice(i, i + Math.max(1, width)).join(""));
  return out.length ? out : [""];
}

