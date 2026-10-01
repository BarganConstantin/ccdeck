// What the deck says from a tab nobody is looking at.
//
// A deck spends almost all of its life in a background tab, and until #338 that
// tab carried exactly nothing: index.html's <title> is static markup and
// `document.title` was never assigned anywhere in src/web/, so the one surface
// that is always on screen read the same whether five sessions were blocked on a
// permission prompt or the machine had been idle since lunch. A dashboard you
// have to focus to read is a dashboard you close.
//
// The tab strip gives about four characters and sixteen pixels, so it gets two
// signals and no more: a count in the title, a state in the icon. Both are
// decided here, as plain strings, because the vitest suite runs in bare node
// with no DOM — nothing in this file touches `document`, and the caller owns
// every write.
import { PRODUCT } from "./brand";
import { KIT_FAVICON_SVG, KIT_STATUS_COLOUR, KIT_TRAY_SVG, type KitStatus } from "./brand-kit";

/** Which of the four states the tab's mark should be wearing. */
export type AmbientIcon = "offline" | "waiting" | "running" | "idle";

export interface AmbientSignal {
  /** What `document.title` should be — already complete, including the name. */
  title: string;
  icon: AmbientIcon;
}

/**
 * What the tab should say and wear, given what the canvas currently holds.
 *
 * THE COUNT LEADS THE STRING: `(2) ccdeck`, never `ccdeck (2)`. Every browser
 * truncates a tab title from the END, and a tab in a strip of fifteen is a few
 * characters wide — so a count appended to the name is the first thing clipped
 * and the deck is back to saying nothing at exactly the moment it has something
 * to say. `(2) c…` is readable down to almost nothing. This ordering is the
 * whole feature, it looks like a typo to anyone tidying the file, and
 * ambient-signal.test.ts asserts the count is at index 0 rather than merely
 * present so that the tidy fails there instead of in a user's tab strip.
 *
 * Never `(0) ccdeck`. Zero is the resting state and has to look like one: a
 * parenthesised zero is a badge that reports nothing is wrong, which is a badge
 * that gets ignored — and a badge that gets ignored is ignored at `(1)` too.
 *
 * The name comes from PRODUCT rather than a literal because this is a surface a
 * human reads, which is the line brand.ts draws; index.html holds the only copy
 * that cannot be derived (it is parsed before any module runs) and
 * display-name.test.ts pins the two together.
 */
export function ambientSignal(
  { waiting, running, connected = true }: { waiting: number; running: number; connected?: boolean },
): AmbientSignal {
  return {
    // The count survives a dead stream, and that is deliberate. It is the last
    // reading rather than a live one, but nobody answered those prompts while
    // the deck was not looking, so it is very likely still true — and a count
    // that vanished the moment the connection dropped would read as "they were
    // dealt with". `(2)` beside a broken mark is the honest pair: two sessions
    // were waiting, and contact has been lost.
    title: waiting > 0 ? `(${waiting}) ${PRODUCT}` : PRODUCT,
    // Offline outranks everything, and not because a blocked session matters
    // less than a dropped socket (#719). While the stream is down, `waiting`
    // and `running` are both frozen readings of a board that has moved on
    // without telling anyone — so the syncing mark claims work is in flight that
    // may have finished minutes ago, and the bare one claims a quiet deck. Both
    // are answers to a question the deck can no longer answer. Worse, acting on
    // the alarm does not clear it: going and approving the prompt changes
    // nothing here, because nothing is arriving to say it was approved. The
    // condition gates the other three, so it precedes them.
    //
    // Then waiting outranks running. The tab strip is an alarm surface, not a
    // status report: one session sitting on a permission prompt while four
    // others work wears the waiting dot, because the four will finish on their
    // own and the one will not. Running answers the lesser question — "is anything still
    // moving" — and only gets the icon when the answer to the first one is no.
    icon: !connected ? "offline" : waiting > 0 ? "waiting" : running > 0 ? "running" : "idle",
  };
}

// THE MARK IS THE KIT'S AND THE STATE SITS ON IT (2026-10-01).
//
// Until the brand kit, this file drew its own mark and carried the state in
// the mark itself: a grey ring at rest, a blue ring around a dot while
// running, a solid amber disc while waiting, a red ring with a bite out of it
// offline (#338, #719). The kit's rule is that status is an overlay on an
// unchanged mark, never a recolouring or a reshaping of it, so nothing here is
// drawn any more (brand-kit.ts holds the files):
//
//   - the mark is the kit's favicon, byte for byte — the file index.html
//     links, worn unchanged at rest;
//   - each other state adds the overlay the kit's tray master draws for it,
//     element for element, in the favicon's own frame for the mark, so it
//     lands where the tray puts it beside the mark;
//   - in the kit's status colour for that state, through `currentColor`.
//
// Owner decision, same day: idle → the kit's default (no overlay), waiting →
// waiting, running → syncing, offline → error. The kit's paused is unused.
//
// What this gave up, said once here so nobody has to dig for it: the old marks
// differed in their whole silhouette, which is what let a dichromat viewer
// tell them apart at 16px. The kit's overlays differ in shape too — a dot, a
// ring with a bang, an arc with an arrowhead — but they are a corner glyph a
// few pixels across. The title's `(n)` still carries the alarm on its own.
//
// The overlays sit inside the favicon's own dark tile, never on the tab strip,
// so their contrast is against the tile; ambient-signal.test.ts measures it.

/** The tray state each tab state wears; idle wears none. */
const KIT_STATE: Readonly<Record<Exclude<AmbientIcon, "idle">, KitStatus>> = {
  waiting: "waiting",
  running: "syncing",
  offline: "error",
};

/** What a tray master draws after its masked mark: the state's overlay, unchanged. */
function trayOverlay(tray: string): string {
  const markEnd = tray.indexOf("</g>", tray.indexOf("<g mask="));
  return markEnd < 0 ? "" : tray.slice(markEnd + "</g>".length, tray.lastIndexOf("</svg>"));
}

/** The transform the favicon draws its mark in, which the tray's overlay coordinates assume. */
const MARK_FRAME = /<g transform="([^"]+)">/.exec(KIT_FAVICON_SVG)?.[1];

/** The favicon with one state's overlay added after the mark. */
function withOverlay(state: KitStatus): string {
  const frame = MARK_FRAME ? ` transform="${MARK_FRAME}"` : "";
  const overlay = `<g${frame} color="${KIT_STATUS_COLOUR[state]}">${trayOverlay(KIT_TRAY_SVG[state])}</g>`;
  const end = KIT_FAVICON_SVG.lastIndexOf("</svg>");
  return KIT_FAVICON_SVG.slice(0, end) + overlay + KIT_FAVICON_SVG.slice(end);
}

/**
 * The four hrefs, encoded once at module load.
 *
 * At rest the tab wears the file itself, the same href index.html boots with,
 * so the first frame and the second cannot disagree. The other three are data
 * URIs, built once: the effect that assigns one is on the SSE path and has no
 * business re-encoding a string it could have had for free.
 *
 * `encodeURIComponent` rather than escaping by hand: `#` inside a URI is the
 * FRAGMENT delimiter, so an unencoded hex colour ends the data URI mid-attribute
 * and the browser silently keeps whichever icon it already had.
 *
 * And no animation, ever — not here and not in the caller. A pulsing favicon
 * asks the browser to re-parse and re-rasterise a data URI every frame for the
 * lifetime of the tab, and it is the single most hated pattern in this genre.
 */
export const FAVICON_HREF: Readonly<Record<AmbientIcon, string>> = Object.freeze({
  offline: `data:image/svg+xml,${encodeURIComponent(withOverlay(KIT_STATE.offline))}`,
  waiting: `data:image/svg+xml,${encodeURIComponent(withOverlay(KIT_STATE.waiting))}`,
  running: `data:image/svg+xml,${encodeURIComponent(withOverlay(KIT_STATE.running))}`,
  idle: "/favicon.svg",
});
