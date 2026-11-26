/**
 * Chat syntax highlighter: one small single-pass scanner per language that turns
 * a code block, or one diff line, into coloured tokens. In-house on purpose: no
 * dependency, a few kB, and capped (MAX_HIGHLIGHT_*) so a huge paste is drawn
 * plain. Lossless: the token texts joined give back the input exactly.
 */

export type HighlightLanguage = "js" | "json" | "py" | "sh" | "rust" | "go" | "css" | "html" | "yaml" | "diff" | "sql";
export type TokenKind = "com" | "str" | "num" | "kw" | "lit" | "key" | "tag" | "meta" | "add" | "del";
export interface Token { kind: TokenKind | null; text: string }

export const MAX_HIGHLIGHT_LINES = 400;
export const MAX_HIGHLIGHT_CHARS = 40_000;

type Kind = TokenKind | null;

// ---- Language lookup

const table = (rows: Record<HighlightLanguage, string>): ReadonlyMap<string, HighlightLanguage> =>
  new Map(Object.entries(rows).flatMap(([lang, names]) => names.split(" ").map(name => [name, lang as HighlightLanguage] as const)));

const ALIASES = table({
  js: "js javascript jsx mjs cjs ts typescript tsx mts cts", json: "json jsonc json5", py: "py python python3 py3",
  sh: "sh bash zsh shell console shellsession ksh", rust: "rust rs", go: "go golang", css: "css scss less",
  html: "html htm xml svg vue xhtml", yaml: "yaml yml", diff: "diff patch udiff", sql: "sql psql mysql sqlite postgres postgresql",
});
const EXTENSIONS = table({
  js: "js jsx ts tsx mjs cjs mts cts", json: "json jsonc json5", py: "py pyi pyw", sh: "sh bash zsh ksh", rust: "rs", go: "go",
  css: "css scss less", html: "html htm xhtml svg xml vue", yaml: "yaml yml", diff: "diff patch", sql: "sql",
});

/** A fence info string ("ts", "TypeScript", "bash title=x", "{.python}") → language, or null when unknown. */
export function languageOf(info: string | undefined): HighlightLanguage | null {
  const first = (info ?? "").trim().split(/\s/, 1)[0] ?? "";
  const word = (/^[{.]*([\w+#-]*)/.exec(first)?.[1] ?? "").toLowerCase().replace(/^language-/, "");
  return ALIASES.get(word) ?? null;
}

/** A file path's extension → language, or null ("src/a.tsx" → "js", "Dockerfile" → null). */
export function languageOfPath(path: string): HighlightLanguage | null {
  const base = path.trim().slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? null : EXTENSIONS.get(base.slice(dot + 1).toLowerCase()) ?? null;
}

// ---- Output

/** Collects tokens: text between coloured spans goes out plain; neighbours of one kind merge. */
class Sink {
  readonly tokens: Token[] = [];
  private pos = 0;
  constructor(private readonly src: string) {}
  /** Colours src[from, to) (a null kind leaves it in the plain run) and returns `to`. */
  put(kind: Kind, from: number, to: number): number {
    const start = Math.max(from, this.pos), end = Math.min(to, this.src.length);
    if (kind === null || end <= start) return to;
    if (start > this.pos) this.add(null, this.src.slice(this.pos, start));
    this.add(kind, this.src.slice(start, end));
    this.pos = end;
    return to;
  }
  done(): Token[] {
    if (this.pos < this.src.length) this.add(null, this.src.slice(this.pos));
    return this.tokens;
  }
  private add(kind: Kind, text: string): void {
    const last = this.tokens[this.tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else this.tokens.push({ kind, text });
  }
}

// ---- Shared helpers (an out-of-range read gives undefined, which every char test rejects)

const words = (list: string): ReadonlySet<string> => new Set(list.split(" ").filter(Boolean));
const isDigit = (c: string) => c >= "0" && c <= "9";
const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isWordStart = (c: string) => isAlpha(c) || c === "_" || c >= "\x80";
const isWord = (c: string) => isWordStart(c) || isDigit(c);
const isHex = (c: string) => isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
const isSpace = (c: string) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";

function wordEnd(src: string, i: number, extra = ""): number {
  while (i < src.length && (isWord(src[i]) || extra.includes(src[i]))) i++;
  return i;
}

/** Skips spaces and tabs (and line breaks when `nl`). */
function skipBlank(src: string, i: number, nl = false): number {
  while (src[i] === " " || src[i] === "\t" || (nl && (src[i] === "\n" || src[i] === "\r"))) i++;
  return i;
}

/** End of the line holding i, before its "\n" (and the "\r" of a CRLF). */
function lineEnd(src: string, i: number): number {
  let j = src.indexOf("\n", i);
  if (j < 0) j = src.length;
  return j > i && src[j - 1] === "\r" ? j - 1 : j;
}

/** Index after the next `close` from i, or the input's end. */
function until(src: string, i: number, close: string): number {
  const j = src.indexOf(close, i);
  return j < 0 ? src.length : j + close.length;
}

/** End of the string whose quote is at i. esc: backslash escapes; dbl: a doubled quote escapes. */
function quoted(src: string, i: number, multi: boolean, esc = true, dbl = false): number {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === "\\" && esc) j++;
    else if (c === q) {
      if (!dbl || src[j + 1] !== q) return j + 1;
      j++;
    } else if (c === "\n" && !multi) return src[j - 1] === "\r" && j - 1 > i ? j - 1 : j;
  }
  return src.length;
}

const NUM = /0[xX][\da-fA-F_]*|0[bB][01_]*|0[oO][0-7_]*|(?:\d[\d_]*(?:\.(?![.A-Za-z_$])[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?/y;

/** End of the number at i; with `suffix`, trailing word chars (1u32, 10n, 2j) join it. */
function numEnd(src: string, i: number, suffix = true): number {
  NUM.lastIndex = i;
  let j = NUM.test(src) ? NUM.lastIndex : i + 1;
  if (suffix) while (isWord(src[j])) j++;
  return j;
}

/** True when only spaces or tabs stand between the line start and i. */
function atLineStart(src: string, i: number): boolean {
  let j = i - 1;
  while (src[j] === " " || src[j] === "\t") j--;
  return j < 0 || src[j] === "\n";
}

// ---- C-like grammars (js, json, py, rust, go, sql)

interface Quote { kind: TokenKind; multi: boolean; esc: boolean; dbl?: boolean }
interface Grammar {
  kw: ReadonlySet<string>;
  lit: ReadonlySet<string>;
  comments: "c" | "hash" | "sql"; // c: "//" and "/* */"; hash: "#"; sql: "--" and "/* */"
  quotes: Readonly<Record<string, Quote>>;
  ident?: string; // extra identifier chars ("$" in js)
  dotProp?: boolean; // a word right after a single "." is a property, never a keyword
  nested?: boolean; // block comments nest (rust)
  fold?: boolean; // case-insensitive keywords (sql)
  extra?: (src: string, i: number, s: Sink) => number; // tried first: the end index, or -1
}

function scanCode(src: string, s: Sink, g: Grammar): void {
  for (let i = 0; i < src.length; ) {
    let j = g.extra ? g.extra(src, i, s) : -1;
    if (j < 0) j = codeToken(src, i, s, g);
    i = Math.max(j, i + 1);
  }
}

function codeToken(src: string, i: number, s: Sink, g: Grammar): number {
  const c = src[i], d = src[i + 1], q = g.quotes[c], ident = g.ident ?? "";
  if (c === "/" && d === "*" && g.comments !== "hash") return s.put("com", i, g.nested ? nestedEnd(src, i) : until(src, i + 2, "*/"));
  if ((g.comments === "c" && c === "/" && d === "/") || (g.comments === "hash" && c === "#") || (g.comments === "sql" && c === "-" && d === "-")) {
    return s.put("com", i, lineEnd(src, i));
  }
  if (q) return s.put(q.kind, i, quoted(src, i, q.multi, q.esc, q.dbl));
  if (isDigit(c) || (c === "." && isDigit(d) && !isWord(src[i - 1]) && src[i - 1] !== ".")) return s.put("num", i, numEnd(src, i));
  if (!isWordStart(c) && !(ident !== "" && ident.includes(c))) return i + 1;
  const j = wordEnd(src, i, ident);
  if (g.dotProp && src[i - 1] === "." && src[i - 2] !== ".") return j;
  const w = g.fold ? src.slice(i, j).toLowerCase() : src.slice(i, j);
  return s.put(g.kw.has(w) ? "kw" : g.lit.has(w) ? "lit" : null, i, j);
}

/** End of a nesting block comment opened at i. */
function nestedEnd(src: string, i: number): number {
  let depth = 0;
  for (let j = i; j < src.length - 1; j++) {
    if (src[j] === "/" && src[j + 1] === "*") { depth++; j++; }
    else if (src[j] === "*" && src[j + 1] === "/") { j++; if (--depth === 0) return j + 1; }
  }
  return src.length;
}

const LINE_STR: Quote = { kind: "str", multi: false, esc: true };

const JS: Grammar = {
  kw: words("break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch this throw try typeof var void while with yield async await of static get set as from type interface enum implements private protected public readonly declare namespace abstract keyof satisfies infer is"),
  lit: words("true false null undefined NaN Infinity"),
  comments: "c", ident: "$", dotProp: true,
  quotes: { '"': LINE_STR, "'": LINE_STR, "`": { kind: "str", multi: true, esc: true } },
};

const JSON_LIT = words("true false null");
const colonAt = (src: string, i: number) => src[skipBlank(src, i, true)] === ":";

/** JSON: a string or bare word followed by ":" is a key; "-1" is one number. */
function jsonExtra(src: string, i: number, s: Sink): number {
  const c = src[i];
  if (c === '"' || c === "'") {
    const j = quoted(src, i, false);
    return s.put(colonAt(src, j) ? "key" : "str", i, j);
  }
  if (c === "-" && isDigit(src[i + 1])) return s.put("num", i, numEnd(src, i + 1));
  if (!isWordStart(c) && c !== "$") return -1;
  const j = wordEnd(src, i, "$");
  return !JSON_LIT.has(src.slice(i, j)) && colonAt(src, j) ? s.put("key", i, j) : -1;
}

const JSON_G: Grammar = { kw: words(""), lit: JSON_LIT, comments: "c", quotes: {}, extra: jsonExtra };

const PY_PREFIX = words("r u b f br rb fr rf");

/** Python: decorators, prefixed strings (rb"", f'') and triple-quoted strings. */
function pyExtra(src: string, i: number, s: Sink): number {
  const c = src[i];
  if (c === "@" && isWordStart(src[i + 1]) && atLineStart(src, i)) return s.put("meta", i, wordEnd(src, i + 1, "."));
  let q = i;
  if (isAlpha(c)) {
    q = wordEnd(src, i);
    if (q - i > 2 || !PY_PREFIX.has(src.slice(i, q).toLowerCase())) return -1;
  }
  const qc = src[q];
  if (qc !== '"' && qc !== "'") return -1;
  if (src[q + 1] !== qc || src[q + 2] !== qc) return s.put("str", i, quoted(src, q, false));
  for (let j = q + 3; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === qc && src[j + 1] === qc && src[j + 2] === qc) return s.put("str", i, j + 3);
  }
  return s.put("str", i, src.length);
}

const PY: Grammar = {
  kw: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case"),
  lit: words("True False None"),
  comments: "hash", dotProp: true, quotes: {}, extra: pyExtra,
};

const RUST_RAW = /[bc]?r(#*)"/y;
const RUST_CHAR = /'(?:\\x[\da-fA-F]{2}|\\u\{[\da-fA-F]{1,6}\}|\\.|[^\\'\r\n])'/uy;

/** End of the char literal at i, or -1 (a lifetime such as 'a). */
function rustChar(src: string, i: number): number {
  RUST_CHAR.lastIndex = i;
  return RUST_CHAR.test(src) ? RUST_CHAR.lastIndex : -1;
}

/** End of a #[…] / #![…] attribute at i, on its line. */
function attributeEnd(src: string, i: number): number {
  const end = lineEnd(src, i);
  let depth = 0;
  for (let j = i; j < end; j++) {
    if (src[j] === "[") depth++;
    else if (src[j] === "]" && --depth === 0) return j + 1;
    else if (src[j] === '"') j = quoted(src, j, false) - 1;
  }
  return end;
}

/** Rust: char literals vs lifetimes, raw and byte strings, attributes and macros. */
function rustExtra(src: string, i: number, s: Sink): number {
  const c = src[i], d = src[i + 1];
  if (c === "'") {
    const j = rustChar(src, i);
    if (j > 0) return s.put("str", i, j);
    return isWordStart(d) ? wordEnd(src, i + 1) : i + 1; // a lifetime stays plain
  }
  if (c === "#" && (d === "[" || (d === "!" && src[i + 2] === "["))) return s.put("meta", i, attributeEnd(src, i));
  if (!isWordStart(c)) return -1;
  if (c === "b" || c === "c" || c === "r") {
    RUST_RAW.lastIndex = i;
    const m = RUST_RAW.exec(src);
    if (m) return s.put("str", i, until(src, RUST_RAW.lastIndex, `"${m[1]}`));
    if (c !== "r" && d === '"') return s.put("str", i, quoted(src, i + 1, true));
    const j = c === "b" && d === "'" ? rustChar(src, i + 1) : -1;
    if (j > 0) return s.put("str", i, j);
  }
  const j = wordEnd(src, i);
  return src[j] === "!" && src[j + 1] !== "=" ? s.put("meta", i, j + 1) : -1;
}

const RUST: Grammar = {
  kw: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
  lit: words("true false"),
  comments: "c", nested: true, quotes: { '"': { kind: "str", multi: true, esc: true } }, extra: rustExtra,
};

const GO: Grammar = {
  kw: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
  lit: words("true false nil iota"),
  comments: "c", dotProp: true,
  quotes: { '"': LINE_STR, "'": LINE_STR, "`": { kind: "str", multi: true, esc: false } },
};

const SQL: Grammar = {
  kw: words("select from where and or not insert into values update set delete create table alter drop index on join left right inner outer full cross group by order having limit offset as distinct union all exists in is like between case when then else end primary key foreign references default unique check constraint view begin commit rollback transaction with returning if replace"),
  lit: words("null true false"),
  comments: "sql", fold: true,
  quotes: {
    "'": { kind: "str", multi: true, esc: false, dbl: true },
    '"': { kind: "key", multi: false, esc: false, dbl: true },
    "`": { kind: "key", multi: false, esc: false },
  },
};

// ---- Shell

const SH_KW = words("if then else elif fi for while until do done case esac in function select return local export readonly declare unset source alias");
const isShWord = (c: string) => !" \t\n\r\f\v;&|()<>'\"`$=\\".includes(c);

/** End of a "$name", "${…}", "$1", "$?" or "$(" at i (never past `limit`); i + 1 for a lone "$". */
function shVar(src: string, i: number, limit: number): number {
  const d = src[i + 1];
  if (d === "{") {
    let j = i + 2;
    while (j < limit && src[j] !== "}" && src[j] !== "\n") j++;
    return j < limit && src[j] === "}" ? j + 1 : j;
  }
  if (d === "(") return src[i + 2] === "(" ? i + 3 : i + 2;
  if (isWordStart(d)) return Math.min(wordEnd(src, i + 1), limit);
  return i + 1 < limit && "0123456789?#$!@*-".includes(d) ? i + 2 : i + 1;
}

/** A double-quoted string at i, its $variables as meta. */
function shDouble(src: string, i: number, s: Sink): number {
  const end = quoted(src, i, true);
  const stop = end - 1 > i && src[end - 1] === '"' ? end - 1 : end;
  let from = i;
  for (let j = i + 1; j < stop; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "$") {
      const v = shVar(src, j, stop);
      if (v > j + 1) {
        s.put("str", from, j);
        from = s.put("meta", j, v);
        j = v - 1;
      }
    }
  }
  return s.put("str", from, end);
}

function scanSh(src: string, s: Sink): void {
  const n = src.length;
  for (let i = 0; i < n; ) {
    const c = src[i];
    let j = i + 1;
    if (c === "#" && (i === 0 || isSpace(src[i - 1]))) j = s.put("com", i, lineEnd(src, i));
    else if (c === "'") j = s.put("str", i, quoted(src, i, true, false));
    else if (c === '"') j = shDouble(src, i, s);
    else if (c === "$") j = s.put("meta", i, shVar(src, i, n));
    else if (c === "\\") j = i + 2;
    else if (isShWord(c)) {
      while (j < n && isShWord(src[j])) j++;
      const w = src.slice(i, j);
      s.put(SH_KW.has(w) ? "kw" : /^\d+$/.test(w) ? "num" : null, i, j);
    }
    i = Math.max(j, i + 1);
  }
}

// ---- CSS

const isCssWord = (c: string) => isWord(c) || c === "-";

function scanCss(src: string, s: Sink): void {
  let depth = 0, decl = false; // decl: the next word may be a property name
  let stop = -1; // the next "{", ";" or "}" (cached, so the lookahead stays linear)
  for (let i = 0; i < src.length; ) {
    const c = src[i], d = src[i + 1];
    let j = i + 1, next = false;
    if (c === "/" && d === "*") { j = s.put("com", i, until(src, i + 2, "*/")); next = decl; }
    else if (c === "/" && d === "/" && (i === 0 || isSpace(src[i - 1]))) { j = s.put("com", i, lineEnd(src, i)); next = decl; }
    else if (isSpace(c)) next = decl;
    else if (c === "{") { depth++; next = true; }
    else if (c === "}") { depth = Math.max(0, depth - 1); next = depth > 0; }
    else if (c === ";") next = depth > 0;
    else if (c === '"' || c === "'") j = s.put("str", i, quoted(src, i, false));
    else if (c === "@" && isWordStart(d)) j = s.put("kw", i, wordEnd(src, i + 1, "-"));
    else if (c === "!") {
      const k = skipBlank(src, i + 1);
      if (src.slice(k, k + 9).toLowerCase() === "important" && !isCssWord(src[k + 9])) j = s.put("kw", i, k + 9);
    } else if (c === "#" && depth > 0) {
      let k = i + 1;
      while (isHex(src[k])) k++;
      if ([4, 5, 7, 9].includes(k - i) && !isCssWord(src[k])) j = s.put("num", i, k);
    } else if (isDigit(c) || (c === "." && isDigit(d))) {
      j = numEnd(src, i, false);
      while (isAlpha(src[j]) || src[j] === "%") j++;
      s.put("num", i, j);
    } else if (isWordStart(c) || (c === "-" && (isWordStart(d) || d === "-"))) {
      j = wordEnd(src, i, "-");
      if (decl && src[skipBlank(src, j)] === ":") {
        if (stop < j) for (stop = j; stop < src.length && !"{;}".includes(src[stop]); stop++);
        if (src[stop] !== "{") s.put("key", i, j); // "a:hover {" is a nested selector
      }
    }
    decl = next;
    i = Math.max(j, i + 1);
  }
}

// ---- HTML / XML

const ENTITY = /&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{0,31});/iy;
const isTagChar = (c: string) => isWord(c) || c === "-" || c === ":" || c === ".";

/** Where a script/style body ends: at its closing tag, or the input's end. */
function rawTextEnd(src: string, from: number, name: string): number {
  for (let k = src.indexOf("</", from); k >= 0; k = src.indexOf("</", k + 2)) {
    if (src.slice(k + 2, k + 2 + name.length).toLowerCase() === name) return k;
  }
  return src.length;
}

/** A start or end tag from its "<"; returns the index after it (after the body for script/style). */
function htmlTag(src: string, i: number, s: Sink): number {
  const n = src.length, endTag = src[i + 1] === "/", a = i + (endTag ? 2 : 1);
  let j = a;
  while (j < n && isTagChar(src[j])) j++;
  s.put("tag", a, j);
  const name = src.slice(a, j).toLowerCase();
  let value = false, closed = false;
  while (j < n && !closed && src[j] !== "<") {
    const c = src[j];
    if (c === ">") { closed = true; j++; }
    else if (c === '"' || c === "'") { j = s.put("str", j, until(src, j + 1, c)); value = false; }
    else if (c === "=") { value = true; j++; }
    else if (isSpace(c) || c === "/") j++;
    else {
      let k = j + 1;
      if (value) while (k < n && !isSpace(src[k]) && src[k] !== ">") k++;
      else {
        while (k < n && !isSpace(src[k]) && !"=<>/\"'".includes(src[k])) k++;
        s.put("key", j, k);
      }
      j = k;
      value = false;
    }
  }
  const raw = closed && !endTag && (name === "script" || name === "style") && src[j - 2] !== "/";
  return raw ? rawTextEnd(src, j, name) : j;
}

function scanHtml(src: string, s: Sink): void {
  for (let i = 0; i < src.length; ) {
    const c = src[i], d = src[i + 1];
    let j = i + 1;
    if (c === "<" && src.startsWith("<!--", i)) j = s.put("com", i, until(src, i + 4, "-->"));
    else if (c === "<" && (d === "!" || d === "?")) j = s.put("meta", i, until(src, i + 2, ">"));
    else if (c === "<" && (isAlpha(d) || (d === "/" && isAlpha(src[i + 2])))) j = htmlTag(src, i, s);
    else if (c === "&") {
      ENTITY.lastIndex = i;
      if (ENTITY.test(src)) j = s.put("lit", i, ENTITY.lastIndex);
    }
    i = Math.max(j, i + 1);
  }
}

// ---- YAML (line by line)

const YAML_LIT = words("true false null yes no on off ~");
const YAML_NUM = /^[-+]?(?:0x[\da-f]+|0o[0-7]+|(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|\.inf|\.nan)$/i;
const isYamlChar = (c: string) => c !== undefined && !isSpace(c) && !",[]{}".includes(c);
const isKeyColon = (src: string, q: number, e: number) => src[q] === ":" && (q + 1 >= e || isSpace(src[q + 1]));

/** Colours a mapping key at p (bare or quoted); returns where the value part starts. */
function yamlKey(src: string, p: number, e: number, s: Sink): number {
  const c = src[p];
  if (c === '"' || c === "'") {
    const j = quoted(src, p, false, c === '"', c === "'");
    return isKeyColon(src, skipBlank(src, j), e) ? s.put("key", p, j) : p;
  }
  if (p >= e || "#[]{},&*!|>%@`".includes(c)) return p;
  for (let q = p; q < e; q++) {
    if (src[q] === "#" && isSpace(src[q - 1])) return p;
    if (isKeyColon(src, q, e)) {
      let k = q;
      while (k > p && (src[k - 1] === " " || src[k - 1] === "\t")) k--;
      return s.put("key", p, k);
    }
  }
  return p;
}

/** A scalar is a whole value when only a comment, "," "]" or "}" follows it. */
function yamlWhole(src: string, j: number, e: number): boolean {
  const k = skipBlank(src, j);
  return k >= e || ",]}".includes(src[k]) || (src[k] === "#" && k > j);
}

function yamlValue(src: string, p: number, e: number, s: Sink): void {
  let start = true; // at the start of a scalar
  for (let i = p; i < e; ) {
    const c = src[i];
    let j = i + 1;
    if (c === "#" && (i === 0 || isSpace(src[i - 1]))) j = s.put("com", i, e);
    else if ((c === ":" && (i + 1 >= e || isSpace(src[i + 1]))) || c === "[" || c === "{" || c === ",") start = true;
    else if (isSpace(c) || c === "]" || c === "}") { /* separators keep `start` */ }
    else if (c === '"' || c === "'") { j = s.put("str", i, quoted(src, i, false, c === '"', c === "'")); start = false; }
    else if ((c === "&" || c === "*" || c === "!") && isYamlChar(src[i + 1])) {
      while (j < e && isYamlChar(src[j])) j++;
      s.put("meta", i, j); // an anchor or tag keeps `start`: the value follows it
    } else {
      while (j < e && isYamlChar(src[j]) && !isKeyColon(src, j, e)) j++;
      if (start && yamlWhole(src, j, e)) {
        const w = src.slice(i, j);
        s.put(YAML_LIT.has(w.toLowerCase()) ? "lit" : YAML_NUM.test(w) ? "num" : null, i, j);
      }
      start = false;
    }
    i = Math.max(j, i + 1);
  }
}

function scanYaml(src: string, s: Sink): void {
  for (let i = 0; i < src.length; ) {
    const e = lineEnd(src, i);
    let p: number;
    if ((src.startsWith("---", i) || src.startsWith("...", i)) && (i + 3 >= e || isSpace(src[i + 3]))) p = s.put("meta", i, i + 3);
    else {
      p = skipBlank(src, i);
      while (src[p] === "-" && (p + 1 >= e || src[p + 1] === " " || src[p + 1] === "\t")) p = skipBlank(src, p + 1);
      p = yamlKey(src, p, e, s);
    }
    yamlValue(src, p, e, s);
    const nl = src.indexOf("\n", e);
    i = nl < 0 ? src.length : nl + 1;
  }
}

// ---- Diff (whole lines; the line break stays plain)

function diffKind(src: string, i: number, e: number): Kind {
  const head = (p: string) => src.startsWith(p, i) && (i + 3 >= e || src[i + 3] === " " || src[i + 3] === "\t");
  if (head("+++") || head("---") || src.startsWith("@@", i) || src.startsWith("diff ", i) || src.startsWith("index ", i)) return "meta";
  return src[i] === "+" ? "add" : src[i] === "-" ? "del" : null;
}

function scanDiff(src: string, s: Sink): void {
  for (let i = 0; i < src.length; ) {
    const e = lineEnd(src, i);
    s.put(diffKind(src, i, e), i, e);
    const nl = src.indexOf("\n", e);
    i = nl < 0 ? src.length : nl + 1;
  }
}

// ---- Entry points

const SCAN: Readonly<Record<HighlightLanguage, (src: string, s: Sink) => void>> = {
  js: (src, s) => scanCode(src, s, JS), json: (src, s) => scanCode(src, s, JSON_G), py: (src, s) => scanCode(src, s, PY),
  rust: (src, s) => scanCode(src, s, RUST), go: (src, s) => scanCode(src, s, GO), sql: (src, s) => scanCode(src, s, SQL),
  sh: scanSh, css: scanCss, html: scanHtml, yaml: scanYaml, diff: scanDiff,
};

function tokenize(src: string, lang: HighlightLanguage): Token[] {
  const s = new Sink(src);
  if (Object.hasOwn(SCAN, lang)) SCAN[lang](src, s);
  return s.done();
}

/** More than MAX_HIGHLIGHT_LINES lines (a final line break does not open a new line). */
function tooManyLines(code: string): boolean {
  let breaks = 0;
  for (let i = code.indexOf("\n"); i >= 0 && i < code.length - 1; i = code.indexOf("\n", i + 1)) {
    if (++breaks >= MAX_HIGHLIGHT_LINES) return true;
  }
  return false;
}

/** The code as tokens, or null when it is over MAX_HIGHLIGHT_LINES lines or MAX_HIGHLIGHT_CHARS characters. */
export function highlight(code: string, lang: HighlightLanguage): Token[] | null {
  return code.length > MAX_HIGHLIGHT_CHARS || tooManyLines(code) ? null : tokenize(code, lang);
}

/** One line on its own (diff lines; no state carries between lines). Over MAX_HIGHLIGHT_CHARS it is one plain token. */
export function highlightLine(line: string, lang: HighlightLanguage): Token[] {
  return line.length > MAX_HIGHLIGHT_CHARS ? [{ kind: null, text: line }] : tokenize(line, lang);
}
