// The deck's best feature only works while you are looking at it, which is the
// same as saying it does not work.
//
// A blocked session already reaches four surfaces — the amber topbar chip, the
// tab title, the favicon and the live region — and every one of them is drawn
// INSIDE a page. The tab title and the favicon were #338's answer to the deck
// living in a background tab, and they are the right answer for a tab that is
// merely behind another one. They are no answer at all for the tab that got
// closed, or the browser that got quit, or the window on the other desktop. The
// user asked "which agent is waiting on me" and the deck's reply is "come and
// look" — so the one time it matters, when you have walked away and four agents
// have gone quiet, the deck is silent for exactly the reason it exists.
//
// A system notification is the only surface that leaves the page. There are two
// ways to raise one and they cover different halves of the problem:
//
//   from the page, via the Notification API — this file. Needs a live document,
//   so it covers "hidden behind something" and not "closed". Free, no install,
//   and it names the deck rather than whatever process spawned it.
//
//   from the server, via notify() in browser-react.mjs — covers the other half,
//   with no browser at all. That path already exists and already ships on all
//   three platforms; it is Browser Watch's, and wiring the block to it is a
//   separate change with its own settings and its own attribution problem.
//
// WHY THIS IS PURE AND DOM-FREE, importing nothing but shapes: the suite runs in
// bare node with no jsdom, so a rule spelled out inside a component is a rule
// the tests cannot call, and a rule the tests cannot call gets copied and then
// drifts. block-announce.ts makes the same argument at length and this file is
// its sibling — the decision lives here, App.tsx does the `new Notification`,
// and notify.test.ts calls exactly what ships.
import { isAlarming } from "./ambient-counts";
import type { BlockedSession } from "./ambient-counts";
import type { WaitingBlock } from "./types";

/** What `Notification.permission` can say. Mirrored rather than imported from
 *  lib.dom so this module still typechecks in the bare-node suite. */
export type NotifyPermission = "default" | "granted" | "denied";

/** One notification, ready to hand to the DOM. `key` is the identity, not
 *  decoration: it is both the dedupe key here and the `tag` on the DOM side, so
 *  a second copy raised by a second deck REPLACES the first in the tray rather
 *  than stacking beside it. */
export interface BlockNotice {
  key: string;
  title: string;
  body: string;
  /** The session to select when the user clicks it. */
  sessionId: string;
}

/**
 * The identity of one block: the session, and the moment it began.
 *
 * `since` is in the key and that is the whole dedupe. One notification is
 * delivered many times — a copy per deck sharing events.jsonl, and the entire
 * history again on every tab that opens — and the reducer deliberately does NOT
 * re-stamp `since` when a copy lands (see WaitingBlock in types.ts), so every
 * copy of one block agrees on this string and only the first raises anything.
 *
 * The other direction is why `since` is in it rather than the session id alone.
 * Answer a prompt, and the same session blocks again ten seconds later on the
 * next tool call: a different block, a different `since`, a notification the
 * user genuinely wants. Keyed on the session alone the deck would tell you
 * about the first permission prompt of the session and none of the rest.
 */
export function blockKey(sessionId: string, block: WaitingBlock): string {
  return `${sessionId}@${block.since}`;
}

/**
 * What a blocked session should say in the tray.
 *
 * The label is the title because that is the only line guaranteed to survive:
 * every platform truncates a notification body, macOS collapses it to one line
 * when the tray is busy, and the question being answered is "WHICH agent" — so
 * the session's name goes where nothing can clip it.
 *
 * The body is CC's own sentence and then the guess, in that order and separated
 * rather than blended. The sentence is what CC actually said; the tool is what
 * the deck inferred from stream position and is wrong sometimes (BlockedTool in
 * types.ts). Blending them into one line — "Needs permission for rm -rf" —
 * would launder an inference into a quotation, in the one notification a user
 * reads while deciding whether to approve a command. The hedge is not optional
 * and it is not padding.
 */
/**
 * The guess, worded against the sentence it will sit under — or null when there
 * is nothing left to add.
 *
 * ONE FUNCTION BECAUSE THERE ARE TWO SURFACES. The notification body and the
 * sidebar tooltip print the same two things in the same order, and the first
 * version of this de-duplicated the name in the notification and left the
 * tooltip repeating it. Same block, same information, two different wordings,
 * depending on where you happened to read it — which is the kind of seam that
 * makes an interface feel assembled rather than made.
 *
 * The de-duplication itself: CC's sentence is usually "Claude needs your
 * permission to use Bash", under which "Bash · rm -rf node_modules" spends its
 * first word repeating what was just said and pushes the part that is new —
 * the command — further from the eye. When the sentence has already named the
 * tool, the guess is only the command; when it has not, the name is the whole
 * of what the guess has to offer.
 *
 * Word-boundary matched, so `Edit` is not treated as named by "the Editor" —
 * which would silently drop the one word identifying what is being asked about.
 */
export function guessLine(block: WaitingBlock, said: string): string | null {
  if (!block.tool) return null;
  const { name, preview } = block.tool;
  const named = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(said);
  if (preview) return named ? preview : `${name} · ${preview}`;
  return named ? null : name;
}

export function noticeBody(block: WaitingBlock): string {
  const said = block.message || "Needs your permission";
  const tool = guessLine(block, said);
  return tool ? `${said}\nLikely on: ${tool}` : said;
}

/**
 * The blocks that deserve a notification right now.
 *
 * THREE GATES, and every one of them is about not being a nuisance — a
 * notification channel that cries wolf gets muted by the OS and then the
 * feature is worse than not having shipped it.
 *
 *   1. PERMISSION BLOCKS ONLY, via `isAlarming`. `blockedSessions()` already
 *      filters to these, so this is belt-and-braces against a caller passing a
 *      wider list; #348 measured 16 idle to 5 permission on a real log, and an
 *      idle prompt is a finished turn, not a stopped session. Three quarters
 *      noise is how a channel gets turned off.
 *
 *   2. NOT WHILE THE PAGE IS VISIBLE. A page you are looking at already carries
 *      the chip, the title, the favicon and a chime. Raising an OS notification
 *      over the top of it tells you something you can already see, in a way you
 *      have to dismiss.
 *
 *   3. ONCE PER BLOCK, via `raised`. See `blockKey`.
 *
 * Deliberately NOT gated on how long the block has been standing. A delay would
 * be defensible — most prompts are answered in seconds — but the deck cannot
 * know whether you are at the keyboard, and the block this feature exists for
 * is the one nobody is sitting in front of. Waiting thirty seconds to tell you
 * about a session that will still be blocked in an hour buys nothing and costs
 * the case where you were about to walk away.
 */
export function noticesFor(
  blocked: readonly BlockedSession[],
  raised: ReadonlySet<string>,
  pageVisible: boolean,
): BlockNotice[] {
  if (pageVisible) return [];
  const out: BlockNotice[] = [];
  for (const b of blocked) {
    if (!isAlarming(b.waiting)) continue;
    const key = blockKey(b.id, b.waiting);
    if (raised.has(key)) continue;
    out.push({ key, title: b.label, body: noticeBody(b.waiting), sessionId: b.id });
  }
  return out;
}

/**
 * The keys to carry into the next frame.
 *
 * Two jobs, and the second is the one that is easy to forget. It records what
 * was just raised, and it FORGETS blocks that are no longer standing — without
 * which the set is a leak that grows for the life of the tab, on a page that is
 * expected to stay open for days.
 *
 * Forgetting is safe precisely because the key carries `since`. A block that
 * cleared and came back is a new key, so dropping the old one cannot cause a
 * repeat notification for the block the user already dealt with; there is no
 * such thing as the same block twice.
 */
export function nextRaised(
  blocked: readonly BlockedSession[],
  justRaised: readonly BlockNotice[],
  raised: ReadonlySet<string>,
): Set<string> {
  const live = new Set<string>();
  for (const b of blocked) live.add(blockKey(b.id, b.waiting));
  const next = new Set<string>();
  for (const key of raised) if (live.has(key)) next.add(key);
  for (const n of justRaised) next.add(n.key);
  return next;
}

/**
 * What a notifier starting up should consider already told.
 *
 * A deck opening onto a machine with four sessions already blocked must not
 * fire four notifications about prompts that have been sitting there since
 * lunch. The visibility gate covers the ordinary case — you just opened the
 * page, so it is visible — but not a tab restored into the background by a
 * session-restoring browser, which is exactly the shape of "I rebooted and
 * Chrome brought everything back".
 *
 * So the world as found is adopted as history. Anything that blocks AFTER the
 * deck is watching is news and gets said; anything that was already standing is
 * on screen for the user to read whenever they look, which is what the four
 * in-page surfaces are for.
 */
export function seedRaised(blocked: readonly BlockedSession[]): Set<string> {
  return new Set(blocked.map(b => blockKey(b.id, b.waiting)));
}

/**
 * Should the memo be re-seeded — that is, has the notifier just started
 * watching?
 *
 * A rule rather than an inline comparison because getting it wrong is invisible
 * and expensive, and because a rule spelled out inside a component is one the
 * bare-node suite cannot call. It cost this feature its first impression once
 * already: seeding lived behind the `granted` check, so on the ordinary path —
 * open the deck, see a session blocked, press the button, allow — the seed had
 * not run when permission arrived, and the next block was adopted as history
 * instead of announced. The first notification after a user asked to be
 * notified was silence, and the one after that worked, by which time they had
 * decided the feature was broken.
 *
 * TWO moments count as starting to watch, and both must:
 *
 *   mount — `seededAt` is null, whatever the permission says. A deck opening
 *   onto four standing prompts must not fire four notifications about lunchtime.
 *
 *   the answer changing — the user pressing the button and allowing. That is
 *   them saying "tell me from here", and what is standing at that moment is on
 *   the screen they pressed it from. History too. What comes next is news.
 */
export function shouldReseed(
  seededAt: NotifyPermission | null,
  permission: NotifyPermission,
): boolean {
  return seededAt !== permission;
}

/**
 * Whether the deck should be offering to turn notifications on.
 *
 * "denied" is a dead end and the button must not pretend otherwise: once a user
 * has refused, `requestPermission()` resolves "denied" again without ever
 * showing a prompt, so a button that keeps offering is a button that silently
 * does nothing — the failure mode browser-react.mjs refuses to ship for its own
 * reactions ("a mode that silently does nothing is worse than one that was
 * never offered"). Only "default" is askable; "denied" is told, in words, that
 * the switch is in the browser's own site settings now.
 */
export function canAsk(permission: NotifyPermission, supported: boolean): boolean {
  return supported && permission === "default";
}
