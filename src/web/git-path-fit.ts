// A file path cut to the room its row leaves it, the way GitHub Desktop's
// path text does it: the file name is what a reader scans for, so it stays
// whole, and the folder in front of it gives way in its middle, down to `…/`.
// Only when the name alone cannot fit is the whole path cut in its middle.
//
// Cut by measuring, not by counting characters or by a CSS ellipsis: an
// ellipsis takes the end of the text, which is the file name, and a count
// cannot know what a proportional fallback font does to it. The widths come
// from a canvas in the deck's own monospace stack and are cached, so a list of
// a few hundred files measures each distinct string once.
//
// The same file listed twice — staged and unstaged — is cut the same way in
// both rows (`fitShared`), or the two rows would read as two different files.

/** The width of a string in the font the path is drawn in, in CSS pixels. */
export type Measure = (text: string) => number;

/** A path as two parts: the folder with its trailing slash (empty for a file
 *  at the top level), and the file name. Drawn in two tones. */
export interface PathParts {
  dir: string;
  base: string;
}

export interface PathCut extends PathParts {
  /** Whether anything was taken out. */
  cut: boolean;
}

const ELLIPSIS = "…";

export function splitPath(path: string): PathParts {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", base: path } : { dir: path.slice(0, i + 1), base: path.slice(i + 1) };
}

/**
 * `text` with its middle taken out until it fits `room`: the longest
 * `head…tail` that does, `headShare` of the kept characters in front. Each
 * longer spelling holds every character of the shorter one, so its width only
 * grows with what it keeps, and a binary search finds the longest that fits in
 * a handful of measurements. With no room even for one kept character, the
 * ellipsis alone.
 */
export function middleCut(text: string, room: number, measure: Measure, headShare = 0.5): string {
  if (measure(text) <= room) return text;
  // Kept and cut by what a reader sees as one character: an emoji with its
  // joiners and modifiers, a letter with its marks, a hidden character's
  // `⟨U+202E⟩`; never half of a surrogate pair.
  const u = units(text);
  const spell = (keep: number) => {
    const head = Math.ceil(keep * headShare);
    return `${u.slice(0, head).join("")}${ELLIPSIS}${u.slice(u.length - (keep - head)).join("")}`;
  };
  let lo = 0, hi = u.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(spell(mid)) <= room) lo = mid;
    else hi = mid - 1;
  }
  return spell(lo);
}

const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

/** `text` as the characters a reader sees — grapheme clusters, or code points
 *  where the platform cannot segment — with each drawn hidden character's
 *  `⟨U+…⟩` kept as one. */
export function units(text: string): string[] {
  const raw = segmenter ? Array.from(segmenter.segment(text), s => s.segment) : Array.from(text);
  if (!text.includes("⟨U+")) return raw;
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const rest = raw.slice(i, i + 9).join("");
    const m = /^⟨U\+[0-9A-F]{4,6}⟩/.exec(rest);
    if (m) { out.push(m[0]); i += Array.from(m[0]).length - 1; continue; }
    out.push(raw[i]);
  }
  return out;
}

/**
 * `path` cut to `room` pixels: whole when it fits; else the whole file name
 * behind a folder cut in its middle (`src/…/auth/`), down to `…/`; and only
 * when not even `…/name` fits, the whole path cut in its middle, keeping more
 * of the end, where the name is.
 */
export function fitPath(path: string, room: number, measure: Measure): PathCut {
  const { dir, base } = splitPath(path);
  if (measure(path) <= room) return { dir, base, cut: false };
  if (dir && measure(`${ELLIPSIS}/`) + measure(base) <= room) {
    // The folder without its slash is cut, and the slash put back: the cut
    // folder still ends where the name begins.
    let folder = middleCut(dir.slice(0, -1), room - measure(base) - measure("/"), measure);
    // A sliver of a folder (`s…/`) reads as noise; `…/` says the same.
    if (units(folder).length - 1 < 3) folder = ELLIPSIS;
    return { dir: `${folder}/`, base, cut: true };
  }
  const whole = middleCut(path, room, measure, 0.4);
  const at = whole.lastIndexOf("/");
  // What is left of the folder keeps the folder's tone; a cut that took the
  // last slash leaves a name alone.
  return at < 0 ? { dir: "", base: whole, cut: true } : { dir: whole.slice(0, at + 1), base: whole.slice(at + 1), cut: true };
}

/** Whether `…/name` (or the name, at the top level) fits `room` — the test a
 *  row runs before it lets the file name be cut, folding its subagent tag to
 *  `↳` first. */
export function nameFits(path: string, room: number, measure: Measure): boolean {
  const { dir, base } = splitPath(path);
  return measure(base) + (dir ? measure(`${ELLIPSIS}/`) : 0) <= room;
}

/**
 * Each row's cut, with every row of one path cut to the narrowest room any of
 * them has, so a file listed twice reads the same twice.
 */
export function fitShared(rows: ReadonlyArray<{ key: string; path: string; room: number }>, measure: Measure): Map<string, PathCut> {
  const narrowest = new Map<string, number>();
  for (const r of rows) narrowest.set(r.path, Math.min(narrowest.get(r.path) ?? Infinity, r.room));
  const byPath = new Map<string, PathCut>();
  const out = new Map<string, PathCut>();
  for (const r of rows) {
    let cut = byPath.get(r.path);
    if (!cut) {
      cut = fitPath(r.path, narrowest.get(r.path)!, measure);
      byPath.set(r.path, cut);
    }
    out.set(r.key, cut);
  }
  return out;
}

/** How many widths one cache keeps before it starts again: a few thousand
 *  strings is many lists' worth, and a cache that only grows is a leak in a
 *  page that stays open for days. */
const CACHE_CAP = 4000;

/** `raw` with every answer remembered. */
export function cachedMeasure(raw: Measure, cap = CACHE_CAP): Measure {
  const seen = new Map<string, number>();
  return (text: string) => {
    let w = seen.get(text);
    if (w === undefined) {
      if (seen.size >= cap) seen.clear();
      w = raw(text);
      seen.set(text, w);
    }
    return w;
  };
}

const measures = new Map<string, Measure>();
let monoStack: string | null = null;

/**
 * The deck's monospace stack at `px` (and `weight`), measured on a canvas and
 * cached per font. The stack is read off `--font-mono` once, at first use, so
 * the sheet stays the one place it is written; never on a frame of its own.
 * Browser only.
 */
export function monoMeasure(px: number, weight = 400): Measure {
  monoStack ??= getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
  const stack = monoStack;
  const font = `${weight} ${px}px ${stack}`;
  let m = measures.get(font);
  if (!m) {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return (text: string) => text.length * px * 0.6;
    m = cachedMeasure((text: string) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    });
    measures.set(font, m);
  }
  return m;
}
