// Everything a share knows that is not React: how long another deck will still
// take it, what to call each account in the picker, and how to read back what
// an import did.
//
// Out here rather than in the two dialogs because the counting is the part that
// has to be right. A picker that mislabels two accounts as one, or a result
// that says "imported" about an account that was already present, is a lie the
// user acts on — they close the tab believing a machine is configured. Plain
// data in, plain data out, tested without a DOM.
import { arrivalCheck } from "./admin-failure";
import { t as tNow, type TFunction } from "./i18n";

/** What the accounts panel knows about an account, narrowed to the naming. */
export interface NamedAccount {
  num: number;
  email: string | null;
  alias: string | null;
  /** The organization's NAME, which is what the roster carries — the uuid the
   *  identity is really keyed by never reaches the browser. */
  org: string | null;
}

/**
 * How much longer another deck will ACCEPT this share, said as a countdown.
 *
 * Not how long it is safe for, which is a claim this timer cannot make and used
 * to imply. The envelope is base64 of plain `{v, exp, payload}` with no MAC and
 * no key anywhere — anyone holding the text can decode it, rewrite `exp`,
 * re-encode and import it, and if they could not, the payload inside is still
 * the account's OAuth token in the clear and `cswap import` takes it directly.
 * A key would not help: the whole point of a share is that the receiving deck
 * shares no secret with the sending one, so there is nothing to sign with that
 * the recipient could verify.
 *
 * What the expiry does buy is real but smaller, and it is worth naming so it
 * does not get mistaken for the other thing: a copy left behind in clipboard
 * history, a scrollback buffer or a chat window stops working through the
 * import dialog. That is hygiene against forgetting, not defence against
 * anybody. Until the login is rotated, a copy is a copy.
 *
 * `tone` drives the colour, and it says "this is about to stop working" — which
 * is why `gone` is the emphatic one. The warning about what the text IS lives
 * beside the countdown rather than on it.
 */
export function shareExpiry(expiresAt: number, nowSec: number, t: TFunction = tNow): { text: string; tone: "ok" | "soon" | "gone" } {
  const left = Math.round(expiresAt / 1000) - nowSec;
  if (left <= 0) return { text: t("accounts.share.expired"), tone: "gone" };
  if (left < 60) return { text: t("accounts.share.expiresSec", { n: left }), tone: "soon" };
  return { text: t("accounts.share.expiresMin", { n: Math.round(left / 60) }), tone: "ok" };
}

export interface PickerRow {
  num: number;
  label: string;
  /** The second line, or null when the label alone is unambiguous. */
  sub: string | null;
}

/**
 * What to call each account in the picker.
 *
 * The label is the same one the panel rows lead with — the alias if the user
 * gave one, else the address — because a picker that renamed the accounts would
 * be asking about a different list from the one on screen.
 *
 * The second line is the disambiguator, and it earns its place only when the
 * label cannot stand alone. One address under two organizations is TWO accounts
 * to claude-swap, deliberately, so two rows reading `me@work.com` would be a
 * picker where the user cannot tell which one they are about to put on their
 * clipboard. The organization is what separates them; an account whose address
 * appears once needs nothing.
 *
 * When the roster carries no organization NAME — it holds the name, never the
 * uuid the identity is really keyed by — the slot number is the tiebreak. A
 * literal "no organization" on both rows would leave them identical, which is
 * the exact failure this line exists to prevent.
 */
export function pickerRows(accounts: NamedAccount[], t: TFunction = tNow): PickerRow[] {
  const seen = new Map<string, number>();
  for (const a of accounts) {
    const key = (a.email ?? "").trim().toLowerCase();
    if (key) seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return accounts.map(a => {
    const email = (a.email ?? "").trim();
    const label = a.alias || email || t("accounts.accountNLower", { n: a.num });
    const parts: string[] = [];
    if (a.alias && email) parts.push(email);
    if (email && (seen.get(email.toLowerCase()) ?? 0) > 1) parts.push(a.org || t("accounts.slotN", { n: a.num }));
    return { num: a.num, label, sub: parts.length ? parts.join(" · ") : null };
  });
}

/**
 * Which accounts go into the bundle: every one on the roster the user has not
 * taken out, in the roster's order.
 *
 * The picker opens with everything ticked, so it holds the EXCLUSIONS and
 * derives this from the live roster on every render (#1175). An account that
 * leaves the store while the dialog is open — the panel repolls every fifteen
 * seconds, and claude-swap rewriting sequence.json reads as a moment where it
 * is gone — drops out of the list, and comes back ticked when it returns; one
 * the user unticked stays out through all of it. Each account in the result is
 * a live OAuth login on the clipboard, so this list is the whole of what the
 * user agreed to put there.
 */
export function pickedAccounts(accounts: ReadonlyArray<{ num: number }>, unpicked: readonly number[]): number[] {
  return accounts.filter(a => !unpicked.includes(a.num)).map(a => a.num);
}

/** One press on a row's box: take it out, or put it back. */
export function toggleUnpicked(unpicked: readonly number[], num: number): number[] {
  return unpicked.includes(num) ? unpicked.filter(n => n !== num) : [...unpicked, num];
}

/** The admin request a share press sends, or null when nothing is picked — a
 *  bundle of nothing is not a request worth making. */
export function shareRequest(picked: readonly number[]): { action: "share"; accounts: number[] } | null {
  return picked.length ? { action: "share", accounts: [...picked] } : null;
}

/**
 * The sentence above the picker, which is the one that has to land before the
 * copy and not after it.
 *
 * It counts tokens, not accounts, because that is the thing being moved. The
 * envelope carries each account's OAuth login in the clear — claude-swap's own
 * transfer module says so — so five ticked boxes is five live logins on a
 * clipboard that other apps can read, that clipboard-history tools write to
 * disk, and that Universal Clipboard syncs to other devices. Somebody who
 * intended to move one account and left the defaults alone should learn that
 * from this line rather than from the far end.
 */
export function shareCountLine(n: number, t: TFunction = tNow): string {
  if (n <= 0) return t("accounts.share.nothingPicked");
  return t("accounts.share.count", { count: n });
}

/** The five things that can happen to one account in an import. */
export type ImportState = "imported" | "healed" | "updated" | "present" | "failed";

export interface ImportResult {
  email: string;
  org?: string;
  num: string | null;
  state: ImportState;
  /** Set when the account landed and this Mac found something wrong with it
   *  after — see arrivalCheck. */
  check?: string;
}

/** What a result row is known by. The address alone is not enough: one
 *  address under two organizations is two accounts to claude-swap, and the
 *  import reports each on a row of its own. */
export function importRowKey(r: { email: string; org?: string }): string {
  return `${r.email}|${r.org ?? ""}`;
}

/**
 * The result list once "update anyway" has answered for one of its rows.
 *
 * The row it names is replaced where it stands and every other row is left
 * alone. And a list that is no longer on screen stays gone (#1175): "Import
 * another" sets it to null while the request can still be out, and turning
 * that null into a list — `rows ?? []` was the first spelling — flipped the
 * paste form the user had just asked for back to a success screen reading
 * "Nothing to import."
 */
export function replaceImportRow(
  rows: ImportResult[] | null, key: string, fresh: ImportResult,
): ImportResult[] | null {
  return rows ? rows.map(r => (importRowKey(r) === key ? fresh : r)) : rows;
}

/**
 * The word beside one account in the result list.
 *
 * `healed` and `updated` both mean the stored credentials were rewritten, and
 * they are kept apart because the reason is the only interesting part: one is
 * claude-swap noticing the local token was dead and fixing it unasked, the
 * other is a person pressing "update anyway". Collapsing them would make an
 * automatic rewrite look like something the user did.
 */
export function outcomeWord(state: ImportState, t: TFunction = tNow): string {
  switch (state) {
    case "imported": return t("accounts.import.word.imported");
    case "healed":   return t("accounts.import.word.healed");
    case "updated":  return t("accounts.import.word.updated");
    case "present":  return t("accounts.import.word.present");
    default:         return t("accounts.import.word.failed");
  }
}

/**
 * "3 of 5 imported, 2 already here" — the line somebody needs before they trust
 * the deck and close the tab.
 *
 * A bare "done" is what makes people run an import twice and then wonder
 * whether they doubled something. Every group that happened is named; a group
 * that did not happen is left out rather than printed as a zero, so the common
 * case reads as one clause and not as a table of nothing.
 */
export function importSummary(results: ImportResult[], t: TFunction = tNow): string {
  const total = results.length;
  if (!total) return t("accounts.import.nothing");
  const count = (s: ImportState) => results.filter(r => r.state === s).length;
  const parts: string[] = [];
  const arrived = count("imported");
  if (arrived) parts.push(t("accounts.import.arrived", { arrived, total }));
  const healed = count("healed");
  if (healed) parts.push(t("accounts.import.healedN", { n: healed }));
  const updated = count("updated");
  if (updated) parts.push(t("accounts.import.updatedN", { n: updated }));
  const present = count("present");
  if (present) parts.push(t("accounts.import.presentN", { n: present }));
  const failed = count("failed");
  if (failed) parts.push(t("accounts.import.failedN", { n: failed }));
  const warnings = [...new Set(results.map(r => arrivalCheck(r.check, t)?.short).filter((s): s is string => !!s))];
  const joiner = t("accounts.joiner");
  return `${parts.join(joiner)}${warnings.length ? `${joiner}${warnings.join(joiner)}` : ""}${t("accounts.endMark")}`;
}
