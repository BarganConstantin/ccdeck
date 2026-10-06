// The words on a session's cluster header: the workspace it runs in, what
// Claude Code calls it, and — when two sessions share a workspace — four
// characters of its id, each cut to the column the card beside it cuts at.
//
// Lifted out of components/SessionClusters.tsx unchanged. None of it touches
// React or the canvas: clusterBounds asks clusterHeader for the three fields
// when it builds a cluster, and the component draws them with SEP.
import { distinctIdTail } from "./session-id-tail";

/**
 * The three fields a cluster header draws, kept apart rather than joined into
 * one string, because they are not three things of one kind.
 *
 * `label` and `shortId` are the session ADDRESS: the workspace it runs in and,
 * when two sessions share that workspace, four characters of its id. `name` is
 * a DESCRIPTION — Claude Code rewrites it as the conversation moves and two
 * sessions may hold the same one, which is exactly why it cannot take the id
 * over. The sheet draws the two address fields uppercase and the name in its
 * own case, and it can only do that if they arrive here separately.
 */
export interface ClusterHeader {
  /** Workspace basename. Always present, always drawn first. */
  label: string;
  /** What Claude Code calls the session — its `agent-name` when it has one and
   *  its `ai-title` when it does not, the same choice the card makes, truncated
   *  to NAME_COLUMNS. Absent when there is neither: a Codex session, or a Claude
   *  one too young to have been named. */
  name?: string;
  /** The last four characters of the session id, or as many more as it takes
   *  to differ from the other sessions under the label. Present ONLY when
   *  another cluster carries the same workspace label; a name never replaces
   *  it. */
  shortId?: string;
  /** The same three fields on one line with nothing truncated — the tooltip,
   *  which is where a cut name is recovered. */
  fullLabel: string;
}

/** The separator between two header fields. One glyph for all of them — see
 *  the note on clusterHeader for why the fields are told apart by case. */
export const SEP = " · ";

/**
 * The most of a session name the header draws, in monospace columns.
 *
 * Measured, not picked. The card beside it already shows the name, and shows
 * it at 11px in a 240px node whose 12/16px padding leaves 210px of text —
 * 31.7 columns of a 6.62px advance before the ellipsis on `.session-name`
 * fires.
 * A header showing MORE than the card would put the only copy of a tail in a
 * tooltip; at 32 it never does, and both surfaces cut at the same word.
 *
 * What it is worth, measured in a browser against this sheet rather than
 * estimated: the longest agentName in the transcripts on this machine is 53
 * characters, "Refactor mailbox controller request response handling", and it
 * draws a 481.3px header. Capped, the same header is 350.7px. The narrowest
 * cluster there is — one 240px card plus PAD on both sides — is 276px wide and
 * the pill starts 16px inside it, so the overhang goes from 221.3px to 90.7px.
 * layout.ts leaves a full card width, 240px, of clear canvas between two
 * session columns, so a capped header stays inside that gutter and cannot
 * reach the box next door. An uncapped one could.
 *
 * The overhang itself is not new and is not the name: the pill is
 * `white-space: nowrap` in a layer that clips nothing, so it has always run
 * past the box it labels rather than wrapping, clipping or widening it — a
 * long workspace basename alone overhangs a one-card cluster by 21.2px today.
 * What the name changes is the magnitude, and the cap is the whole answer to
 * that. It is also why the cap is not tied to the cluster width: at 276px the
 * budget would be 17 columns, shorter than every name measured here, and a cap
 * that fires every time is not a cap.
 *
 * The field carries `ai-title` sentences now as well as `agent-name` slugs, and
 * the number survives that unchanged — checked rather than assumed. It is
 * derived from where the CARD ellipsises, which is a fact about a 240px node
 * and says nothing about which record filled it, and the bound it buys is a
 * bound on the OUTPUT: 32 columns draw the same 350.7px header whatever went in,
 * so the longest title measured here (64 code points, "Explore hotkey and global
 * search features in VCRM Angular portal") lands on the same overhang as the
 * 53-character name above. What did change is how often it fires — 4 of the 10
 * distinct names here exceed 32 columns, against 198 of the 299 distinct titles,
 * so the cap went from a guard to the ordinary path.
 */
export const NAME_COLUMNS = 32;

/** Code points a monospace font draws two columns wide: CJK, Hangul, kana and
 *  the fullwidth forms. Counting them as one would let a 32-character name
 *  draw 64 columns, which puts the bound above out by a factor of two.
 *
 *  Hypothetical for names, real for titles: the sweep of every transcript here
 *  turns up `日本語への翻訳とエージェント並列実行` as an ai-title — 18 code
 *  points that draw 36 columns, over the cap on a string a naive count calls
 *  comfortably under it. */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

export function columns(ch: string): number {
  return WIDE.test(ch) ? 2 : 1;
}

/**
 * A name cut to NAME_COLUMNS, ellipsis included in the count.
 *
 * Walks code points rather than UTF-16 units, because slicing a string in the
 * middle of a surrogate pair renders a replacement box, which looks like data
 * loss rather than truncation.
 *
 * #520 justified that with "one of them ends in U+2442", which is not a reason:
 * U+2442 is in the BMP and one UTF-16 unit wide, so a naive slice would have
 * survived it. Re-swept over all 309 distinct names and titles on this machine,
 * NOT ONE carries a surrogate pair — 15 carry a non-ASCII code point and every
 * one of those is BMP too. The walk stays because the field is free text that
 * already contains Romanian, Japanese and a dingbat, and an emoji in it is a
 * matter of time; it is insurance, and the honest note is that nothing here has
 * yet exercised it.
 *
 * Trailing separators are walked off before the ellipsis so a cut never reads
 * as a hyphen the name itself contains — which matters more now than it did,
 * since a sentence cut mid-way lands on a space far more often than a slug does.
 */
export function truncateName(name: string, budget = NAME_COLUMNS): string {
  const chars = [...name];
  let total = 0;
  for (const ch of chars) total += columns(ch);
  if (total <= budget) return name;
  const kept: string[] = [];
  let used = 0;
  for (const ch of chars) {
    const w = columns(ch);
    if (used + w > budget - 1) break;
    kept.push(ch);
    used += w;
  }
  while (kept.length && /[\s\-_.:/]/.test(kept[kept.length - 1])) kept.pop();
  return `${kept.join("")}…`;
}

/**
 * The header, as three fields rather than as one string.
 *
 * Pure, and separately testable, because there are four shapes it has to draw
 * deliberately and only one of them is the common case:
 *
 *     VCRM-CORE
 *     VCRM-CORE · account-management-oauth-flow
 *     VCRM-CORE · 4EFA
 *     VCRM-CORE · account-management-oauth-flow · 4EFA
 *
 * The id keeps the condition it has always had — it appears when a second
 * cluster carries the same workspace label, and not otherwise. A name does not
 * earn it and does not excuse it: two sessions in one workspace can be named
 * the same thing, so the name cannot do the job the id is there to do.
 *
 * It is the id's last four characters, and more when one of `peers` — the
 * other sessions under this workspace label — ends the same way. It used to be
 * the first four, and a Codex id is a UUIDv7 that opens with its timestamp, so
 * two Codex sessions in one repo both read `· 01A0` for seven weeks at a time
 * (#1732). See session-id-tail.ts.
 */
export function clusterHeader(
  workspace: string,
  name: string | undefined,
  sessionId: string,
  collides: boolean,
  peers: readonly string[] = [],
): ClusterHeader {
  const named = name?.trim() ?? "";
  const id = collides ? distinctIdTail(sessionId, peers) : undefined;
  const fields = [workspace, named || undefined, id].filter(Boolean) as string[];
  return {
    // THE LAST UNBOUNDED STRING ON THE HEADER, and it is capped by the same
    // ruler as the name beside it. The note above records that a long
    // workspace basename overhangs a one-card cluster by 21.2px and that this
    // is neither new nor the name's doing — true, and it is also a measurement
    // of the basenames on one machine rather than a bound on them. A checkout
    // under a long directory has no ceiling at all, and the 240px gutter
    // layout.ts leaves between columns is exactly what an uncapped field can
    // cross. Capping it costs nothing that was working: every workspace
    // measured here is far inside 32 columns, so this fires only where the
    // header was going to reach the cluster next door. The whole of it stays
    // in `fullLabel`, which is the tooltip.
    label: truncateName(workspace),
    name: named ? truncateName(named) : undefined,
    shortId: id,
    fullLabel: fields.join(SEP),
  };
}

