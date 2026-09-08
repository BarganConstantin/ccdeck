// The two marks release-notes.json actually uses, and nothing else.
//
// Every note in that file is written in Markdown — `**bold**` for the sentence
// that carries the change and `` `code` `` for a flag, a path or a command —
// and the modal rendered the string raw. So the first window a user sees after
// an upgrade has been printing `**H**` and backticks since the feature shipped:
// 25 of 52 notes, 52 bold spans and 54 code spans, including the release that
// was published this morning.
//
// This is the same defect as the one `white-space: pre-line` fixed a level
// above it. The file's authors were marking up structure the renderer threw
// away — first the paragraph breaks, then the emphasis inside them.
//
// A PARSER, NOT A MARKDOWN LIBRARY. Counted in the file: bold 52, code 54,
// links 0, headings 0, lists 0, block quotes 0, italics 0. marked is ~40KB and
// markdown-it ~100KB on a bundle that already warns at 647KB and is fetched
// over npx while somebody waits — the same trade SectionHistoryModal made when
// it wrote a path string instead of importing Chart.js.
//
// AND A TOKEN TREE, NOT AN HTML STRING. The caller builds React elements from
// these, so nothing here can put markup on a page. release-notes.json is data
// this repo ships, but the renderer that reads it should not be the one place
// where a future note — or a file somebody edits in a published install — can
// spell a `<script>`.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; kids: Inline[] };

/**
 * Where the `**` that closes the one opened at `open` is, or -1.
 *
 * Two rules beyond "find the next one", both of which stop ordinary prose from
 * being read as emphasis:
 *
 *  • The delimiters have to hug their text — `**bold**`, never `** bold **`.
 *    Without that, `2 ** 3` and `4 ** 5` in one paragraph become one bold run
 *    with the arithmetic eaten.
 *  • A `**` inside a code span does not close anything. No note does this today
 *    (measured: 0 of 54 code spans contain `**`), but a note about a glob or a
 *    shell expansion is exactly the note that would, and it would swallow the
 *    rest of the paragraph.
 */
function closeOfBold(src: string, open: number): number {
  if (/\s|^$/.test(src[open + 2] ?? "")) return -1;
  let i = open + 2;
  while (i < src.length) {
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (src.startsWith("**", i) && !/\s/.test(src[i - 1] ?? " ")) return i;
    i++;
  }
  return -1;
}

/**
 * One note's body as a flat list of runs.
 *
 * Code binds tighter than bold, which is Markdown's own rule and the reason it
 * is written this way round: whatever a code span contains is what it says.
 * Bold nests code and not itself — `**a `b` c**` occurs twice in the file and
 * `**a **b** c**` is not a thing anyone writes.
 *
 * An unmatched delimiter stays as text. A note ending mid-span is a typo in a
 * data file, and the honest response is to show the author their stray
 * backtick, not to eat the rest of the paragraph looking for its partner.
 */
export function parseInline(src: string, allowBold = true): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ kind: "text", text }); text = ""; } };

  let i = 0;
  while (i < src.length) {
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      // `end > i + 1` and not `end >= 0`: an empty span is two backticks the
      // author meant to be seen.
      if (end > i + 1) {
        flush();
        out.push({ kind: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (allowBold && src.startsWith("**", i)) {
      const end = closeOfBold(src, i);
      if (end > 0) {
        flush();
        out.push({ kind: "bold", kids: parseInline(src.slice(i + 2, end), false) });
        i = end + 2;
        continue;
      }
    }
    text += src[i];
    i += 1;
  }
  flush();
  return out;
}

/** What the runs say with every mark removed — the text a reader ends up with.
 *  Used by the tests to hold the renderer to the one promise that matters: it
 *  may drop delimiters and may not drop, reorder or invent a character. */
export function plainOf(nodes: Inline[]): string {
  return nodes.map(n => (n.kind === "bold" ? plainOf(n.kids) : n.text)).join("");
}
