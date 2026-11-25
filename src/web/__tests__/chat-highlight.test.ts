import { describe, expect, it } from "vitest";
import {
  highlight, highlightLine, languageOf, languageOfPath, MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINES,
  type HighlightLanguage, type Token, type TokenKind,
} from "../components/chat/chat-highlight";

const LANGS: HighlightLanguage[] = ["js", "json", "py", "sh", "rust", "go", "css", "html", "yaml", "diff", "sql"];

const SAMPLES: Record<HighlightLanguage, string> = {
  js: 'import { a } from "./a";\nconst x = 0x1F + 1_000n + .5e-3; // note\n/* block */ let t = `multi\n${x} line`;\nif (a / b > 1) return null;\n',
  json: '{\n  "name": "deck", // jsonc\n  "n": -1.5e3,\n  "ok": [true, false, null]\n}\n',
  py: '@app.route("/x")\ndef f(a, *, b=None):\n    """doc\n    string"""\n    return rb\'\\x00\' + f"{a}"  # c\n',
  sh: '#!/bin/bash\nfor f in *.txt; do\n  echo "$f ${HOME}" \'raw $x\' $# 2>&1 # done\ndone\n',
  rust: '#[derive(Debug)]\nfn f<\'a>(s: &\'a str) -> char {\n    println!("{}", r#"raw "q""#);\n    let c = \'\\n\'; 1u32; /* a /* b */ c */\n    \'x\'\n}\n',
  go: 'package main\n\nfunc main() {\n\ts := `raw\nline`\n\tr := \'x\'\n\tfmt.Println(s, r, 0x1F, nil) // c\n}\n',
  css: '@media (max-width: 600px) {\n  .a > b:hover { color: #fff; margin: 0 1.5em !important; }\n}\n/* c */\n',
  html: '<!DOCTYPE html>\n<!-- c -->\n<a href="x" data-y=\'z\' hidden>t &amp; u</a>\n<script>if (a<b) x()</script>\n',
  yaml: '---\n# c\nkey: value # c\nlist:\n  - name: "q"\n    on: true\n    n: 12\nanchor: &a 1\nref: *a\n...\n',
  diff: 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n',
  sql: "SELECT a, \"Col\" FROM t -- c\nWHERE b = 'it''s' AND c IS NULL /* x */ LIMIT 10;\n",
};

/** Deterministic noise over the characters the scanners care about. */
function garbage(seed: number, length: number): string {
  const alphabet = "abcXYZ019_$#@!&*%:;,.(){}[]<>/\\'\"`-+= \t\n\r\u00e9\u4e2d\ud83d\ude00rbfiflet";
  let x = seed, out = "";
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += alphabet[x % alphabet.length];
  }
  return out;
}

const AWKWARD = [
  "", "\n", "\r\n", "a\r\nb\r\n", "\t\tindented\tline\t", "unicode \u00e9 \u4e2d\u6587 \ud83d\ude00\ud83d\udc4d\ud83c\udffd \u200b",
  '"unterminated', "'open", "`open\nstill", "/* open comment", "<!-- open", "<a href='x", "\\", "\\\\\\\"", "${",
  "#[", 'r#"', "'a", "--- a\n+++ b\n@@", "x: |\n  - y: 'z", ...[1, 2, 3, 4, 5].map(seed => garbage(seed, 400)),
];

function problems(tokens: Token[], input: string): string[] {
  const out: string[] = [];
  if (tokens.map(t => t.text).join("") !== input) out.push("not lossless");
  tokens.forEach((t, i) => {
    if (t.text === "") out.push(`empty token at ${i}`);
    if (i > 0 && tokens[i - 1].kind === t.kind) out.push(`unmerged ${String(t.kind)} at ${i}`);
  });
  return out;
}

const all = (code: string, lang: HighlightLanguage): Token[] => {
  const tokens = highlight(code, lang);
  if (!tokens) throw new Error("highlight returned null");
  return tokens;
};
const coloured = (code: string, lang: HighlightLanguage) => all(code, lang).filter(t => t.kind).map(t => [t.kind, t.text]);
const textsOf = (code: string, lang: HighlightLanguage, kind: TokenKind) =>
  all(code, lang).filter(t => t.kind === kind).map(t => t.text);

describe("languageOf", () => {
  it("maps every alias", () => {
    const expected: Record<HighlightLanguage, string> = {
      js: "js javascript jsx mjs cjs ts typescript tsx mts cts",
      json: "json jsonc json5",
      py: "py python python3 py3",
      sh: "sh bash zsh shell console shellsession ksh",
      rust: "rust rs",
      go: "go golang",
      css: "css scss less",
      html: "html htm xml svg vue xhtml",
      yaml: "yaml yml",
      diff: "diff patch udiff",
      sql: "sql psql mysql sqlite postgres postgresql",
    };
    for (const [lang, names] of Object.entries(expected)) {
      for (const name of names.split(" ")) expect([name, languageOf(name)]).toEqual([name, lang]);
    }
  });

  it("reads only the first word, case-insensitive, trimmed of braces and a dot", () => {
    expect(languageOf("TypeScript")).toBe("js");
    expect(languageOf("ts title=a.ts")).toBe("js");
    expect(languageOf("bash title=x")).toBe("sh");
    expect(languageOf("  PY3  ")).toBe("py");
    expect(languageOf("{.python}")).toBe("py");
    expect(languageOf("{.python .numberLines}")).toBe("py");
    expect(languageOf(".rs")).toBe("rust");
    expect(languageOf("js{1,3}")).toBe("js");
  });

  it("returns null when unknown or empty", () => {
    for (const info of [undefined, "", "   ", "text", "c++", "markdown", "toString", "constructor", "__proto__"]) {
      expect(languageOf(info)).toBeNull();
    }
  });
});

describe("languageOfPath", () => {
  it("maps extensions", () => {
    const cases: [string, HighlightLanguage | null][] = [
      ["src/a.tsx", "js"], ["a.d.ts", "js"], ["x.mjs", "js"], ["b.JSX", "js"], ["x/Cargo.toml", null], ["a.yml", "yaml"],
      ["Dockerfile", null], ["run.sh", "sh"], ["q.sql", "sql"], ["README.md", null], ["s.scss", "css"], ["i.htm", "html"],
      ["i.html", "html"], ["i.svg", "html"], ["i.xml", "html"], ["App.vue", "html"], ["a.json", "json"], ["a.jsonc", "json"],
      ["a.json5", "json"], ["a.py", "py"], ["a.pyi", "py"], ["main.rs", "rust"], ["main.go", "go"], ["a.bash", "sh"],
      ["a.zsh", "sh"], ["fix.diff", "diff"], ["fix.patch", "diff"], ["C:\\work\\a.ts", "js"], [".gitignore", null], ["", null],
    ];
    for (const [path, lang] of cases) expect([path, languageOfPath(path)]).toEqual([path, lang]);
  });
});

describe("lossless, non-empty, merged tokens", () => {
  it("holds for every language over awkward inputs and every sample", () => {
    const inputs = [...AWKWARD, ...Object.values(SAMPLES)];
    const failures: string[] = [];
    for (const lang of LANGS) {
      for (const input of inputs) {
        const whole = highlight(input, lang);
        if (!whole) failures.push(`${lang}: null for ${JSON.stringify(input.slice(0, 30))}`);
        else for (const p of problems(whole, input)) failures.push(`${lang} highlight ${JSON.stringify(input.slice(0, 30))}: ${p}`);
        for (const line of input.split("\n")) {
          for (const p of problems(highlightLine(line, lang), line)) failures.push(`${lang} line ${JSON.stringify(line.slice(0, 30))}: ${p}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("gives [] for the empty string and the same tokens on every call", () => {
    for (const lang of LANGS) {
      expect(highlight("", lang)).toEqual([]);
      expect(highlightLine("", lang)).toEqual([]);
    }
    const first = LANGS.map(lang => highlight(SAMPLES[lang], lang));
    const again = [...LANGS].reverse().map(lang => highlight(SAMPLES[lang], lang)).reverse();
    expect(again).toEqual(first);
  });

  it("merges neighbours of one kind", () => {
    expect(all('"a""b"', "js")).toEqual([{ kind: "str", text: '"a""b"' }]);
    expect(all("x + y", "js")).toEqual([{ kind: null, text: "x + y" }]);
  });
});

describe("unterminated strings and comments", () => {
  const tail = (code: string, lang: HighlightLanguage) => all(code, lang).at(-1);
  it("run to the end of the input", () => {
    expect(tail("x = /* open\nstill open", "js")).toEqual({ kind: "com", text: "/* open\nstill open" });
    expect(tail("x = `open\nstill", "js")).toEqual({ kind: "str", text: "`open\nstill" });
    expect(tail('x = "open', "js")).toEqual({ kind: "str", text: '"open' });
    expect(tail('s = """open\nstill', "py")).toEqual({ kind: "str", text: '"""open\nstill' });
    expect(tail("let s = \"open\nstill", "rust")).toEqual({ kind: "str", text: "\"open\nstill" });
    expect(tail("a /* x /* y */ still", "rust")).toEqual({ kind: "com", text: "/* x /* y */ still" });
    expect(tail("s := `open\nstill", "go")).toEqual({ kind: "str", text: "`open\nstill" });
    expect(tail("echo 'open\nstill", "sh")).toEqual({ kind: "str", text: "'open\nstill" });
    expect(tail("a { /* open", "css")).toEqual({ kind: "com", text: "/* open" });
    expect(tail("<p><!-- open\nstill", "html")).toEqual({ kind: "com", text: "<!-- open\nstill" });
    expect(tail("<a href='open\nstill", "html")).toEqual({ kind: "str", text: "'open\nstill" });
    expect(tail("SELECT 'open\nstill", "sql")).toEqual({ kind: "str", text: "'open\nstill" });
    expect(tail('{"a": "open', "json")).toEqual({ kind: "str", text: '"open' });
    expect(tail('k: "open', "yaml")).toEqual({ kind: "str", text: '"open' });
  });

  it("run to the end of the line with highlightLine, and nothing carries to the next line", () => {
    expect(highlightLine('"""open', "py")).toEqual([{ kind: "str", text: '"""open' }]);
    expect(highlightLine("/* open", "js")).toEqual([{ kind: "com", text: "/* open" }]);
    expect(highlightLine("x = 1", "py")).toEqual([{ kind: null, text: "x = " }, { kind: "num", text: "1" }]);
  });

  it("single-line strings stop at the line break", () => {
    expect(textsOf('a = "open\nb = 1', "js", "str")).toEqual(['"open']);
    expect(textsOf("a = 'open\r\nb = 1", "py", "str")).toEqual(["'open"]);
  });
});

describe("caps and speed", () => {
  it("returns null over the line and char caps", () => {
    const line = "x = 1";
    expect(highlight(Array(MAX_HIGHLIGHT_LINES).fill(line).join("\n"), "py")).not.toBeNull();
    expect(highlight(`${line}\n`.repeat(MAX_HIGHLIGHT_LINES), "py")).not.toBeNull();
    expect(highlight(Array(MAX_HIGHLIGHT_LINES + 1).fill(line).join("\n"), "py")).toBeNull();
    expect(highlight("a".repeat(MAX_HIGHLIGHT_CHARS), "js")).not.toBeNull();
    expect(highlight("a".repeat(MAX_HIGHLIGHT_CHARS + 1), "js")).toBeNull();
  });

  it("highlightLine never returns null; an over-long line is one plain token", () => {
    const long = '"'.repeat(MAX_HIGHLIGHT_CHARS + 5);
    expect(highlightLine(long, "js")).toEqual([{ kind: null, text: long }]);
  });

  it("highlights 400 lines of ~100 chars of JS in under 100 ms", () => {
    const row = 'const value_1 = compute("text", 0x1F, 3.5e2) /* c */ + other.prop; // a trailing comment here ok';
    const code = Array(400).fill(row).join("\n");
    expect(row.length).toBeGreaterThanOrEqual(95);
    highlight(code, "js");
    const t0 = performance.now();
    const tokens = highlight(code, "js");
    expect(performance.now() - t0).toBeLessThan(100);
    expect(tokens?.map(t => t.text).join("")).toBe(code);
  });

  it("stays linear on adversarial runs in every language", () => {
    const size = 39_000;
    const runs = ["\\", '"', "'", "`", "/*", "${", "<a ", "&#", "#[", "r#", "'a", ": ", '"\\', "- ", "@@", "$(", "{\"", "1", "a"]
      .map(unit => unit.repeat(Math.floor(size / unit.length)));
    for (const lang of LANGS) {
      const t0 = performance.now();
      for (const run of runs) {
        const tokens = highlightLine(run, lang);
        expect(tokens.map(t => t.text).join("")).toBe(run);
      }
      expect([lang, performance.now() - t0 < 1000]).toEqual([lang, true]);
    }
  });
});

describe("whole-word keywords", () => {
  it("matches keywords only as whole words", () => {
    expect(textsOf("classy $if if_ _if iffy class", "js", "kw")).toEqual(["class"]);
    expect(textsOf("obj.class + a.default", "js", "kw")).toEqual([]);
    expect(textsOf("...new Set()", "js", "kw")).toEqual(["new"]);
    expect(textsOf("classy definitely def", "py", "kw")).toEqual(["def"]);
    expect(textsOf("re.match(x)", "py", "kw")).toEqual([]);
    expect(textsOf("fnord fn letter", "rust", "kw")).toEqual(["fn"]);
    expect(textsOf("gofunc func", "go", "kw")).toEqual(["func"]);
    expect(textsOf("selected SELECT", "sql", "kw")).toEqual(["SELECT"]);
    expect(coloured("echo $if if", "sh")).toEqual([["meta", "$if"], ["kw", "if"]]);
  });
});

describe("spot checks", () => {
  it("js", () => {
    const t = coloured('const x = "a"; // hi', "js");
    expect(t).toContainEqual(["kw", "const"]);
    expect(t).toContainEqual(["str", '"a"']);
    expect(t).toContainEqual(["com", "// hi"]);
    expect(textsOf("0x1F 1_000n 1.5e-3 .5 0b101 0o17", "js", "num")).toEqual(["0x1F", "1_000n", "1.5e-3", ".5", "0b101", "0o17"]);
    expect(textsOf("true null undefined NaN Infinity", "js", "lit")).toHaveLength(5);
    expect(all("a / b / c", "js")).toEqual([{ kind: null, text: "a / b / c" }]);
    expect(textsOf("t = `a\n${b}\nc`", "js", "str")).toEqual(["`a\n${b}\nc`"]);
  });

  it("json keys and values", () => {
    const t = coloured('{"a": 1, "b": "c", "d": [true, null], "e" : -2.5e3} // c', "json");
    expect(t).toEqual([
      ["key", '"a"'], ["num", "1"], ["key", '"b"'], ["str", '"c"'], ["key", '"d"'], ["lit", "true"], ["lit", "null"],
      ["key", '"e"'], ["num", "-2.5e3"], ["com", "// c"],
    ]);
    expect(coloured("{\n  \"k\"\n  : 1 /* x */ }", "json")).toEqual([["key", '"k"'], ["num", "1"], ["com", "/* x */"]]);
  });

  it("python", () => {
    const code = 'x = """a\nb"""\n# c\n@app.route("/")\ndef f(): return None\ny = rb\'\\x00\' + F"{a}" + u\'z\'';
    const t = coloured(code, "py");
    expect(t).toContainEqual(["str", '"""a\nb"""']);
    expect(t).toContainEqual(["com", "# c"]);
    expect(t).toContainEqual(["meta", "@app.route"]);
    expect(t).toContainEqual(["kw", "def"]);
    expect(t).toContainEqual(["lit", "None"]);
    expect(t).toContainEqual(["str", "rb'\\x00'"]);
    expect(t).toContainEqual(["str", 'F"{a}"']);
    expect(t).toContainEqual(["str", "u'z'"]);
    expect(textsOf("a @ b", "py", "meta")).toEqual([]);
  });

  it("rust lifetimes stay plain, char literals are strings", () => {
    const t = coloured("fn f<'a>(x: &'a str, y: &'static str) -> char { 'a' }", "rust");
    expect(t.filter(([k]) => k === "str")).toEqual([["str", "'a'"]]);
    expect(t).not.toContainEqual(["kw", "static"]);
    expect(textsOf("let c = '\\n'; let u = '\\u{1F600}'; let b = b'x'; let e = '\ud83d\ude00';", "rust", "str"))
      .toEqual(["'\\n'", "'\\u{1F600}'", "b'x'", "'\ud83d\ude00'"]);
    const m = coloured('#[derive(Debug, Clone)]\nprintln!("{}", 1u32); x != y; let s = r#"a "q" b"#; let b = b"x"; 2.0f64', "rust");
    expect(m).toContainEqual(["meta", "#[derive(Debug, Clone)]"]);
    expect(m).toContainEqual(["meta", "println!"]);
    expect(m).toContainEqual(["num", "1u32"]);
    expect(m).toContainEqual(["str", 'r#"a "q" b"#']);
    expect(m).toContainEqual(["str", 'b"x"']);
    expect(m).toContainEqual(["num", "2.0f64"]);
    expect(textsOf("0..10", "rust", "num")).toEqual(["0", "10"]);
    expect(textsOf("#![allow(x)] #[doc = \"]\"] fn", "rust", "meta")).toEqual(['#![allow(x)]', '#[doc = "]"]']);
  });

  it("go", () => {
    const t = coloured("func main() { s := `raw`; r := 'x'; return nil } // c", "go");
    expect(t).toEqual([
      ["kw", "func"], ["str", "`raw`"], ["str", "'x'"], ["kw", "return"], ["lit", "nil"], ["com", "// c"],
    ]);
  });

  it("sh comments, variables and words", () => {
    expect(coloured("echo $HOME # c", "sh")).toEqual([["meta", "$HOME"], ["com", "# c"]]);
    expect(all("a#b", "sh")).toEqual([{ kind: null, text: "a#b" }]);
    expect(coloured("echo $# x", "sh")).toEqual([["meta", "$#"]]);
    expect(coloured('if [ -f x ]; then echo "hi $USER!"; fi', "sh")).toEqual([
      ["kw", "if"], ["kw", "then"], ["str", '"hi '], ["meta", "$USER"], ["str", '!"'], ["kw", "fi"],
    ]);
    expect(coloured("echo ${VAR:-x} $(pwd) $1 2>&1", "sh")).toEqual([
      ["meta", "${VAR:-x}"], ["meta", "$("], ["meta", "$1"], ["num", "2"], ["num", "1"],
    ]);
    expect(coloured("echo \\\"not a string\\\" \\#x", "sh")).toEqual([]);
  });

  it("css", () => {
    const t = coloured(".a { color: #fff; margin: 0 1.5em; width: 50% !important; --gap: 2px }", "css");
    expect(t).toEqual([
      ["key", "color"], ["num", "#fff"], ["key", "margin"], ["num", "0"], ["num", "1.5em"], ["key", "width"], ["num", "50%"],
      ["kw", "!important"], ["key", "--gap"], ["num", "2px"],
    ]);
    expect(coloured("@media (max-width: 600px) { a:hover { b: 'x' } } /* c */", "css")).toEqual([
      ["kw", "@media"], ["num", "600px"], ["key", "b"], ["str", "'x'"], ["com", "/* c */"],
    ]);
    expect(coloured("#fade { x: 1 }", "css")).toEqual([["key", "x"], ["num", "1"]]);
    expect(coloured("a{color:red;top:0}", "css")).toEqual([["key", "color"], ["key", "top"], ["num", "0"]]);
  });

  it("html", () => {
    expect(coloured('<a href="x">t</a>', "html")).toEqual([["tag", "a"], ["key", "href"], ["str", '"x"'], ["tag", "a"]]);
    expect(coloured("<!DOCTYPE html><!-- c --><p class=big data-x='1' hidden/>&amp;&#39;&nope", "html")).toEqual([
      ["meta", "<!DOCTYPE html>"], ["com", "<!-- c -->"], ["tag", "p"], ["key", "class"], ["key", "data-x"], ["str", "'1'"],
      ["key", "hidden"], ["lit", "&amp;&#39;"],
    ]);
    expect(coloured("<script>if (a<b) x()</script><b>", "html")).toEqual([["tag", "script"], ["tag", "script"], ["tag", "b"]]);
    expect(coloured("a < b", "html")).toEqual([]);
  });

  it("yaml", () => {
    expect(all("key: value # c", "yaml")).toEqual([
      { kind: "key", text: "key" }, { kind: null, text: ": value " }, { kind: "com", text: "# c" },
    ]);
    const t = coloured('---\nlist:\n  - name: "q"\n    on: true\n    n: 12\nanchor: &a 1\nref: *a\ntitle: yes we can\n"quoted key": ~\n...', "yaml");
    expect(t).toEqual([
      ["meta", "---"], ["key", "list"], ["key", "name"], ["str", '"q"'], ["key", "on"], ["lit", "true"], ["key", "n"], ["num", "12"],
      ["key", "anchor"], ["meta", "&a"], ["num", "1"], ["key", "ref"], ["meta", "*a"], ["key", "title"], ["key", '"quoted key"'],
      ["lit", "~"], ["meta", "..."],
    ]);
    expect(coloured("url: http://x.y/z # c\ntags: [a, 1, no]", "yaml")).toEqual([
      ["key", "url"], ["com", "# c"], ["key", "tags"], ["num", "1"], ["lit", "no"],
    ]);
    expect(textsOf("a#b: c", "yaml", "com")).toEqual([]);
  });

  it("diff lines", () => {
    const code = "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx\n+++i;\r\n";
    expect(all(code, "diff")).toEqual([
      { kind: "meta", text: "diff --git a/x b/x" },
      { kind: null, text: "\n" }, { kind: "meta", text: "index 1..2" }, { kind: null, text: "\n" },
      { kind: "meta", text: "--- a/x" }, { kind: null, text: "\n" }, { kind: "meta", text: "+++ b/x" }, { kind: null, text: "\n" },
      { kind: "meta", text: "@@ -1 +1 @@" }, { kind: null, text: "\n" }, { kind: "del", text: "-old" }, { kind: null, text: "\n" },
      { kind: "add", text: "+new" }, { kind: null, text: "\n ctx\n" }, { kind: "add", text: "+++i;" }, { kind: null, text: "\r\n" },
    ]);
    expect(highlightLine("+added", "diff")).toEqual([{ kind: "add", text: "+added" }]);
    expect(highlightLine("-removed", "diff")).toEqual([{ kind: "del", text: "-removed" }]);
    expect(highlightLine(" same", "diff")).toEqual([{ kind: null, text: " same" }]);
  });

  it("sql", () => {
    expect(coloured("SELECT * FROM t WHERE a = 'x' -- c", "sql")).toEqual([
      ["kw", "SELECT"], ["kw", "FROM"], ["kw", "WHERE"], ["str", "'x'"], ["com", "-- c"],
    ]);
    expect(coloured("select \"Col\", NULL, 'it''s', true, 42 from t /* c */", "sql")).toEqual([
      ["kw", "select"], ["key", '"Col"'], ["lit", "NULL"], ["str", "'it''s'"], ["lit", "true"], ["num", "42"], ["kw", "from"],
      ["com", "/* c */"],
    ]);
  });
});
