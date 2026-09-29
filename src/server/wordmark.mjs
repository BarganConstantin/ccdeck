// The ccdeck wordmark: the drawn mark at the top of the boot, and the two
// forms it falls back to in a terminal that cannot hold it.
//
// Lifted out of term.mjs, which it draws with — the palette and the glyph tier
// — and which stays the module that answers what the terminal can do. This is
// the one thing the boot draws with those answers that is art rather than a
// row, and it is pure the same way: every input is a parameter, and nothing
// here writes.
//
// Drawn, not pasted out of a figlet font — six letters on a 4×6 pixel grid,
// printed two pixel rows to a text row with the half-block characters, which is
// what gives it a lowercase with real ascenders in three lines instead of six.
// The old banner said `agents-deck`, a name the repo, the command, the README
// and the docs stopped using; this one says what the product is called.
import { glyphs, palette } from "./term.mjs";

const LETTERS = {
  c: ["....", "....", ".###", "#...", "#...", ".###"],
  d: ["...#", "...#", ".###", "#..#", "#..#", ".###"],
  e: ["....", "....", ".###", "####", "#...", ".###"],
  k: ["#...", "#...", "#.##", "##..", "#.#.", "#..#"],
};

/** Two pixel rows into one text row: ▀ upper only, ▄ lower only, █ both. */
function squash(top, bottom) {
  let out = "";
  for (let i = 0; i < top.length; i++) {
    const t = top[i] === "#";
    const b = bottom[i] === "#";
    out += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
  }
  return out;
}

function renderWord(word) {
  const rows = ["", "", ""];
  for (const [n, ch] of [...word].entries()) {
    const px = LETTERS[ch];
    for (let r = 0; r < 3; r++) rows[r] += (n ? " " : "") + squash(px[r * 2], px[r * 2 + 1]);
  }
  return rows.map((r) => r.replace(/\s+$/, ""));
}

/** The drawn mark itself, three text rows of half-blocks.
 *
 *  Exported for one reader, and it is a test rather than a caller (#383). This
 *  is the ONLY place the art's true width can be measured: `renderWord` trims
 *  each row's trailing blanks, so the rows are not all the same length, and the
 *  arithmetic in WORDMARK_WIDTH below is a hand-computed prediction of the
 *  widest of them. Nothing in the banner path compares the two — `wordmark()`
 *  gates on WORDMARK_WIDTH and then prints THESE lines — so an under-counting
 *  width lets the art render into a terminal too narrow to hold it and the
 *  three rows wrap into six. See wordmark-art-width.test.ts, which is the
 *  comparison this export exists to make possible. */
export const WORDMARK_LINES = renderWord("ccdeck");
/** 29 columns of art, plus the two-space indent every other line uses. */
export const WORDMARK_WIDTH = 2 + LETTERS.c[0].length * 6 + 5;

/**
 * The tagline, longest version that fits — the name and version are the part
 * that must survive, the rest is context.
 *
 * `prefix` is how many columns are already spent on the line the tagline lands
 * on, and it is a parameter because the three layouts below do not agree on it
 * (#383). In the full banner the tagline gets a line of its own behind a
 * two-space indent; in the compact and plain ones it shares the line with the
 * product name, which costs eight or nine columns more. This budget was
 * hard-coded at 2 for all three, so between 21 and 31 columns — the widths where
 * the compact form is chosen and the medium tagline still looks affordable —
 * the banner printed a 36-column line into a terminal that could not hold it and
 * the first thing a user saw wrapped. `columns - 1` keeps the last cell empty,
 * because a line ending exactly at the right margin makes some terminals wrap
 * anyway.
 */
function tagline(version, columns, bullet, prefix) {
  const v = `v${version}`;
  const options = [
    `${v} ${bullet} live agent DAG ${bullet} Claude Code + Codex`,
    `${v} ${bullet} live agent DAG`,
    v,
  ];
  return options.find((o) => o.length + prefix <= columns - 1) ?? v;
}

// What each layout spends before the tagline starts, counted off the strings
// built in `wordmark` below: "  ccdeck " for plain, "  ccdeck  " for compact,
// and the bare two-space indent for the full banner's own tagline line.
const PLAIN_PREFIX_W   = "  ccdeck ".length;
const COMPACT_PREFIX_W = "  ccdeck  ".length;
const TAG_INDENT_W     = "  ".length;

/**
 * The wordmark, in the largest form this terminal can hold.
 *
 *   "full"    — the drawn mark, three rows, on a vertical gradient
 *   "compact" — the name in the accent, for a terminal too narrow for the art
 *               or a console without the half-block glyphs
 *   "plain"   — no escapes at all: a pipe, a CI log, NO_COLOR
 *
 * Returns the lines to print, blank lines included, so the caller writes them
 * and nothing else decides how much air the banner gets.
 */
export function wordmark({
  columns = 80, version = "0.0.0", profile = "none", unicode = true, pal = palette(profile),
} = {}) {
  const g = glyphs(unicode);
  // Each layout asks for its own tagline, because each leaves it a different
  // amount of room — see the prefix constants above.
  const tag = (prefix) => tagline(version, columns, g.bullet, prefix);

  if (profile === "none") return { kind: "plain", lines: ["", `  ccdeck ${tag(PLAIN_PREFIX_W)}`, ""] };
  if (!unicode || columns < WORDMARK_WIDTH + 1) {
    return { kind: "compact", lines: ["", `  ${pal.bold}${pal.accent}ccdeck${pal.reset}  ${pal.muted}${tag(COMPACT_PREFIX_W)}${pal.reset}`, ""] };
  }

  const ramp = [pal.accentSoft, pal.accent, pal.accentDeep];
  return {
    kind: "full",
    lines: [
      "",
      ...WORDMARK_LINES.map((l, i) => `  ${ramp[i]}${l}${pal.reset}`),
      "",
      `  ${pal.muted}${tag(TAG_INDENT_W)}${pal.reset}`,
      "",
    ],
  };
}
