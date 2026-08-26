// Reading markup out of .tsx source, for the sweeps that have to do it.
//
// Two of this suite's guards work by finding every `<button>` in the components
// and asking the stylesheet about it — control-edges.test.ts, which measures the
// boundary each control draws, and control-appearance.test.ts, which asks
// whether a control's rules declare any appearance at all. Both need the same
// two things: a tag scanner that stops at the `>` that really closes the tag,
// and source with its comments already gone.
//
// #513 is why the second half is here rather than written twice. The scanner in
// control-edges.test.ts read raw TSX, tracked quote state as it walked, and had
// no idea what a comment was. A lone `'` in a line comment inside a JSX brace —
// an English possessive, which this codebase's prose-style comments are full of
// — opened a string nothing in the tag ever closed. `>` was then never seen at
// depth 0 and the scan ran to its character budget, harvesting every className
// it passed as though each one belonged to the button it started from.
//
// It fired once for real: moving the sound button from third to sixth in the
// topbar (#512) brought `.conn-banner` and `.ver-banner` inside the window, and
// the sweep demanded an accessible border from two elements that are not
// controls. That was fixed by rewording the comment, which is a workaround
// whose correctness depends on nobody writing a possessive near a `<button>`.
// The loud failure is the lucky one; the quiet one is a runaway that attributes
// one element's classes to another tag, so a control the sweep believes it has
// examined was never really read.
//
// So: comments are removed before anything looks for markup, and a scan that
// reaches its budget is REPORTED rather than truncated in silence. Hitting the
// budget used to be indistinguishable from a long tag.
//
// The scan is also per file now. Both callers used to join every .tsx into one
// string, which means a runaway at the end of one file reaches into the next —
// and a failure message that can name the file is worth more than one that
// cannot.

/**
 * The same source with its comments gone — a line comment to end of line, a
 * block comment to its terminator — and every newline kept, so a line number
 * computed on the result is the line number in the original file.
 *
 * `blankStrings` empties every string, template and quoted literal as well,
 * keeping the delimiters. Markup callers never want that — a className IS a
 * string — but a caller reading .test.ts source for numbers does: this suite's
 * prose quotes the code it retired, and a fixture holding the text of a budget
 * would otherwise be read as one. `budget.ts` is the caller that asks.
 *
 * Quote-aware, so `"https://example"` keeps its slashes and a block comment
 * opener inside a string literal is not a comment. And a `'` or `"` still open
 * at the end of a line closes there, because a JavaScript string of either kind
 * cannot contain a raw newline: a quote that appears to span one was never a
 * string. That is not a nicety. `AccountsPanel.tsx` renders `Couldn't read the
 * account store.` as JSX text, which is prose and not JavaScript — without the
 * rule that apostrophe would swallow every comment after it and hand the caller
 * back the exact hazard this function exists to remove. Template literals
 * really can span lines, so a backtick is exempt.
 *
 * What it does not do is understand regular-expression literals, where a `/`
 * is neither division nor a comment. Nothing in these components writes one
 * that opens a false comment, and the runaway report below is what says so if
 * that ever changes: eating a `>` by mistake is exactly what makes a scan run
 * away, and a runaway now has a name.
 */
export function withoutComments(source: string, blankStrings = false): string {
  let out = "";
  let quote = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (quote) {
      if (c === "\\") { out += blankStrings ? "  " : source.slice(i, i + 2); i += 2; continue; }
      if (c === "\n" && quote !== "`") { quote = ""; out += c; i++; continue; }
      if (c === quote) { quote = ""; out += c; i++; continue; }
      out += blankStrings && c !== "\n" ? " " : c;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      for (; i < stop; i++) if (source[i] === "\n") out += "\n";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 1-based line of an offset, which is why `withoutComments` keeps newlines. */
export function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * A tag the scan found, or could not finish.
 *
 * `attrs` is the text between the tag name and the `>` that closes it, which is
 * what most callers read classNames out of. `ranAway` says the scan spent its
 * whole budget without finding that `>` — the tag is then handed back with
 * `attrs: ""`, because attributes read out of a runaway belong to whatever the
 * scan wandered into, and crediting them to this tag is the silent
 * mis-attribution #513 is about.
 *
 * `end` is where that closing `>` sits, so a caller that needs the tag's BODY
 * as well as its attributes can go and read it — landmark-outline.test.ts asks,
 * because a glyph-only button is identified by what is written between the
 * tags. It is -1 for a runaway, for the same reason `attrs` is empty. The index
 * is into `withoutComments(source)` rather than into `source`, which is what
 * this function scans; a caller slicing with it has to pass source that is
 * already comment-free, and `withoutComments` is idempotent, so calling it
 * first costs nothing and makes the two agree.
 */
export interface Tag {
  name: string;
  attrs: string;
  line: number;
  ranAway: boolean;
  end: number;
}

/**
 * The longest opening tag in this app is `App.tsx`'s finish-sound button, at
 * 1,450 characters of handler once its comments are gone. Twice that is a
 * budget no real tag in this app reaches and a runaway crosses within a
 * screenful.
 *
 * The number matters less than it used to. With comments stripped there is far
 * less for a scan to run away into, and when one does it is reported by name
 * rather than truncated and swallowed. It is also smaller than the 4,000 it
 * replaces, because that figure was chosen against raw source: the same button
 * measured 2,953 characters with its prose still in it, which left the old
 * budget a thousand characters of slack it was never told it was spending.
 */
export const TAG_BUDGET = 3000;

/**
 * Every opening `<name …>` for the tags asked for, in one file's source.
 *
 * Braces are counted and quotes tracked so the `>` in `onClick={() => …}` does
 * not end the tag — that was #378's fix and it stands. What is new is that the
 * source goes through `withoutComments` first (here, so a caller cannot forget)
 * and that running out of budget is a fact the caller can see.
 */
export function openTags(source: string, names: readonly string[]): Tag[] {
  const bare = withoutComments(source);
  const head = new RegExp(`<(${names.join("|")})\\b`, "g");
  const out: Tag[] = [];
  for (const m of bare.matchAll(head)) {
    const start = m.index + m[0].length;
    const limit = Math.min(bare.length, start + TAG_BUDGET);
    let depth = 0, quote = "", i = start, closed = false;
    for (; i < limit; i++) {
      const c = bare[i];
      if (quote) {
        if (c === "\\") { i++; continue; }
        if (c === "\n" && quote !== "`") { quote = ""; continue; }
        if (c === quote) quote = "";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) { closed = true; break; }
    }
    out.push({
      name: m[1],
      attrs: closed ? bare.slice(start, i) : "",
      line: lineOf(bare, m.index),
      ranAway: !closed,
      end: closed ? i : -1,
    });
  }
  return out;
}

/**
 * Every class name a tag's attribute text hard-codes, as one flat list.
 *
 * The two forms control-edges.test.ts has always read, and only those: a quoted
 * attribute and a braced template literal. A name assembled at runtime leaves a
 * stub behind — `state-${…}` becomes `state-` — and those are dropped, because
 * no file here can say what they became.
 */
export function classesIn(attrs: string): string[] {
  const out: string[] = [];
  for (const m of attrs.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    for (const c of (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, " ").split(/\s+/)) {
      if (c && !c.endsWith("-")) out.push(c);
    }
  }
  return out;
}

/**
 * The class SETS a tag can render with — one per string the className
 * expression could evaluate to.
 *
 * Different from `classesIn`, and deliberately. A union is the right shape for
 * "which classes in this sheet belong to a control"; it is the wrong shape for
 * "does this control have an appearance", where the question has to be asked of
 * each set the element can actually wear. `className={checking ? "v checking" :
 * "v"}` renders as one of two elements and both of them have to look like
 * something.
 *
 * The expression is brace-matched rather than pattern-matched, so a ternary or
 * a nested template does not cut the run short, and every string, template and
 * single-quoted literal inside it counts as one candidate set.
 */
export function classSetsIn(attrs: string): string[][] {
  const sets: string[][] = [];
  for (const m of attrs.matchAll(/className=/g)) {
    const start = m.index + m[0].length;
    if (attrs[start] === '"' || attrs[start] === "'") {
      const end = attrs.indexOf(attrs[start], start + 1);
      if (end > 0) sets.push(split(attrs.slice(start + 1, end)));
      continue;
    }
    if (attrs[start] !== "{") continue;
    let depth = 0, i = start;
    for (; i < attrs.length; i++) {
      if (attrs[i] === "{") depth++;
      else if (attrs[i] === "}" && --depth === 0) break;
    }
    const expr = attrs.slice(start + 1, i);
    for (const lit of expr.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
      sets.push(split(lit[1] ?? lit[2] ?? lit[3]));
    }
  }
  return sets.filter(s => s.length);
}

/** A className string, as names. Interpolations leave a stub — see `classesIn`. */
function split(value: string): string[] {
  return value.replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(c => c && !c.endsWith("-"));
}
