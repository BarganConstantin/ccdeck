// The words on a session's cluster header: the folder it runs in and what the
// session is called when that is something else, each cut to the column the
// card beside it cuts at, with when it started and its id's tail kept for the
// tooltip.
//
// Lifted out of components/SessionClusters.tsx. None of it touches React or
// the canvas: clusterBounds asks clusterHeader for the fields when it builds a
// cluster, and the component draws them with SEP.
import { distinctIdTail } from "./session-id-tail";
import { t, type TFunction } from "./i18n";
import { sameWords, startedLine } from "./rail-row-copy";

/**
 * The two fields a cluster header draws, kept apart rather than joined into
 * one string, because they are not two things of one kind.
 *
 * `label` is the session's ADDRESS, the folder it runs in; `name` is its title
 * (rail-row-copy.ts sessionNames), the name the user gave it or Claude Code's.
 * The sheet draws the folder uppercase and the name in its own case, and it can
 * only do that if they arrive here separately.
 *
 * CHANGED ON PURPOSE (owner's critique, 2026-11-11): two sessions in one folder
 * were told apart by four characters of the id on the pill ("CCDECK · 2886"),
 * which no other surface said. The id and the start time are in the tooltip.
 */
export interface ClusterHeader {
  /** Workspace basename. Always present, always drawn first. */
  label: string;
  /** What the session is called — the user's name for it, else Claude Code's
   *  title — truncated to NAME_COLUMNS. Absent when there is neither, or when
   *  it only says the folder again. */
  name?: string;
  /** The two fields on one line with nothing truncated — the line the tooltip
   *  is built on, which is where a cut name is recovered. */
  fullLabel: string;
  /** The pill's tooltip: everything the pill says, whole and in the order it
   *  draws it — the words a screen reader hears for a session waiting on you,
   *  the workspace, the plan, the subagents' summary, the name — then when the
   *  session started with its id's tail, and what a press does. The pill
   *  ellipsises at its gutter and at the pane's edge, and this is where the cut
   *  part is read back. */
  title: string;
  /** The whole workspace, and the fields after the plan (branch, name) already
   *  joined: what `clusterTooltip` needs to word the tooltip again in the
   *  language on show without rebuilding the header. */
  tipWorkspace: string;
  tipRest: string;
  /** When the session started, and as much of its id's tail as tells it from
   *  every other session on the board: the tooltip's second line. */
  startedAt?: number;
  idTail: string;
}

/** The pill's tooltip for a header, in the language `tr` speaks. */
export function clusterTooltip(h: { alarm?: boolean; tipWorkspace: string; tipRest: string; planLine?: string; startedAt?: number; idTail?: string }, tr: TFunction = t): string {
  const whole = [h.tipWorkspace, h.planLine ? tr("board.cluster.plan", { plan: h.planLine }) : undefined, h.tipRest || undefined].filter(Boolean).join(SEP);
  const started = h.startedAt != null && h.idTail ? `${startedLine(h.startedAt, h.idTail, Date.now(), tr)}\n` : "";
  return `${h.alarm ? tr("board.cluster.waitingOnYou") : ""}${whole}\n${started}${tr("board.cluster.zoomTo")}\n${tr("board.cluster.dragWrapper")}`;
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

function columns(ch: string): number {
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
 * The header, as two fields rather than as one string: the folder, and the
 * session's title when it is not the folder.
 *
 *     VCRM-CORE
 *     VCRM-CORE · account-management-oauth-flow
 *
 * Two sessions in one folder with no title of their own read alike on the pill
 * and apart in its tooltip: when each started and the tail of its id, as much
 * of it as `peers` (the other sessions on the board) leave it needing. The
 * tail, because a Codex id is a UUIDv7 that opens with its timestamp (#1732;
 * see session-id-tail.ts).
 */
export function clusterHeader(
  workspace: string,
  name: string | undefined,
  sessionId: string,
  peers: readonly string[] = [],
  { branch, plan, alarm = false, startedAt }: { branch?: string; plan?: string; alarm?: boolean; startedAt?: number } = {},
): ClusterHeader {
  const trimmed = name?.trim() ?? "";
  const named = trimmed && !sameWords(trimmed, workspace) ? trimmed : "";
  const idTail = distinctIdTail(sessionId, peers);
  const fields = [workspace, named || undefined].filter(Boolean) as string[];
  // The pill draws the plan and the subagents' summary between the workspace
  // and the name, and says "waiting on you: " first for a screen reader; the
  // tooltip reads the same run, with the plan's step whole.
  const tipRest = [branch, named || undefined].filter(Boolean).join(SEP);
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
    // in `fullLabel` and in the tooltip built on it.
    label: truncateName(workspace),
    name: named ? truncateName(named) : undefined,
    fullLabel: fields.join(SEP),
    title: clusterTooltip({ alarm, tipWorkspace: workspace, tipRest, planLine: plan, startedAt, idTail }),
    tipWorkspace: workspace,
    tipRest,
    ...(startedAt != null ? { startedAt } : null),
    idTail,
  };
}

