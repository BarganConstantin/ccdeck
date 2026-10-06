// The quiet syntax theme the diff is coloured with, and how a tokenized line
// becomes the spans the diff pane draws.
//
// Quiet on purpose: colour on this panel carries state, so a diff gets three
// syntax tones and nothing more — keywords, strings and comments — and names,
// types, numbers and punctuation stay the text colour. The tones themselves
// live in the stylesheet (`--gv-syn-*`, both themes, held to 4.5:1 on every
// line background by contrast-floors), never here: this file only says which
// of the three a token is.
//
// The tokenizer wants a hex colour per rule, so each tone has a stand-in hex
// that is only ever read back as a name — nothing paints these values.

export type SynKind = "kw" | "str" | "com";
export const SYN_KINDS: readonly SynKind[] = ["kw", "str", "com"];

/** Stand-ins, read back by `kindOf`; never a colour on screen. */
const STAND_IN = { text: "#010101", kw: "#010102", str: "#010103", com: "#010104" } as const;

const KIND_BY_STAND_IN = new Map<string, SynKind>([
  [STAND_IN.kw, "kw"],
  [STAND_IN.str, "str"],
  [STAND_IN.com, "com"],
]);

export function kindOf(color: string | undefined): SynKind | null {
  return color ? KIND_BY_STAND_IN.get(color.toLowerCase()) ?? null : null;
}

/** TextMate scopes per tone. A more specific selector wins over a shorter
 *  one, so the resets below take operators, template holes, property names
 *  and units back to the text colour from the broad `keyword` and `string`. */
const RULES: Array<[string[], string]> = [
  [["comment", "punctuation.definition.comment", "string.comment"], STAND_IN.com],
  [["string", "punctuation.definition.string", "string.template", "string.regexp", "constant.character.escape",
    "markup.inline.raw", "markup.raw", "markup.fenced_code"], STAND_IN.str],
  [["keyword", "storage", "storage.type", "storage.modifier", "keyword.control",
    "keyword.operator.new", "keyword.operator.expression", "keyword.operator.word", "keyword.operator.logical.python",
    "keyword.operator.wordlike", "variable.language", "constant.language", "markup.heading", "entity.name.section.markdown",
    "keyword.other.important"], STAND_IN.kw],
  [["keyword.operator", "keyword.other.unit", "punctuation", "meta.template.expression", "meta.embedded", "variable",
    "support.type.property-name", "entity.name.tag", "entity.other.attribute-name", "entity.name.function",
    "support.function", "meta.function-call"], STAND_IN.text],
];

/** The theme registration the tokenizer is handed. */
export const QUIET_THEME = {
  name: "ccdeck-quiet",
  type: "dark" as const,
  fg: STAND_IN.text,
  bg: "#000000",
  settings: [
    { settings: { foreground: STAND_IN.text, background: "#000000" } },
    ...RULES.map(([scope, foreground]) => ({ scope, settings: { foreground } })),
  ],
};

/** One line's spans: `[start, end, kind]`, sorted, never overlapping, with
 *  the text colour left out. */
export type LineSpans = Array<[number, number, SynKind]>;

/**
 * Tokenized lines as spans, neighbouring tokens of one tone joined. Takes the
 * tokenizer's `{ content, color }` tokens, so it stays testable without it.
 */
export function tokensToSpans(lines: ReadonlyArray<ReadonlyArray<{ content: string; color?: string }>>): LineSpans[] {
  return lines.map(tokens => {
    const out: LineSpans = [];
    let at = 0;
    for (const t of tokens) {
      const kind = kindOf(t.color);
      const end = at + t.content.length;
      if (kind) {
        const last = out[out.length - 1];
        if (last && last[2] === kind && last[1] === at) last[1] = end;
        else out.push([at, end, kind]);
      }
      at = end;
    }
    return out;
  });
}
