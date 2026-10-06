// Quiet syntax colours for the diff: three tones and nothing else, the right
// tokens in each, every grammar loaded only when a diff first needs it, and
// the tokenizer kept off the page's main thread.
import { describe, expect, it } from "vitest";
import { codeToTokensBase, createShikiPrimitiveAsync } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { cachedSpans, highlightDocs, langOf } from "../git-syntax";
import { kindOf, QUIET_THEME, SYN_KINDS, tokensToSpans } from "../git-syntax-theme";
import { sourceOf } from "./client-source";

async function tokenize(lang: string, code: string) {
  const p = await createShikiPrimitiveAsync({ themes: [QUIET_THEME], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) });
  const grammars = (await import(`shiki/langs/${lang}.mjs`)).default;
  await p.loadLanguage(...grammars);
  const lines = code.split("\n");
  const spans = tokensToSpans(codeToTokensBase(p, code, { lang, theme: QUIET_THEME.name }));
  /** Each line's coloured words, as `kind:text`. */
  return spans.map((line, i) => line.map(([s, e, k]) => `${k}:${lines[i].slice(s, e)}`));
}

describe("which file gets which grammar", () => {
  it("goes by extension, and by name for shell profiles", () => {
    expect(langOf("src/web/App.tsx")).toBe("tsx");
    expect(langOf("src/server/git-reads.mjs")).toBe("javascript");
    expect(langOf("lib/types.d.ts")).toBe("typescript");
    expect(langOf("README.md")).toBe("markdown");
    expect(langOf(".github/workflows/ci.yml")).toBe("yaml");
    expect(langOf("home/.bashrc")).toBe("shellscript");
    expect(langOf("app/Main.CS")).toBe("csharp");
  });

  it("answers plain text for anything else", () => {
    expect(langOf("data/products.csv")).toBeNull();
    expect(langOf("Makefile")).toBeNull();
    expect(langOf(".gitignore")).toBeNull();
  });

  it("colours nothing without a grammar, at once and without a worker", async () => {
    expect(await highlightDocs(null, ["a,b,c"])).toBeNull();
    expect(await highlightDocs("cobol", ["MOVE A TO B."])).toBeNull();
    expect(cachedSpans("typescript", ["const a = 1;"])).toBeNull();
  });
});

describe("the quiet theme", () => {
  it("has three tones, each a stand-in read back by name", () => {
    expect(SYN_KINDS).toEqual(["kw", "str", "com"]);
    const used = new Set(QUIET_THEME.settings.map(s => s.settings.foreground));
    expect([...used].map(kindOf).filter(Boolean).sort()).toEqual(["com", "kw", "str"]);
    // The text tone is not a span: it is the line's own colour.
    expect(kindOf(QUIET_THEME.fg)).toBeNull();
  });

  it("joins neighbouring tokens of one tone and leaves the text tone out", () => {
    const [kw, str, text] = ["#010102", "#010103", "#010101"];
    expect(tokensToSpans([[{ content: "const", color: kw }, { content: " a = ", color: text }, { content: "\"x", color: str }, { content: "\"", color: str }]]))
      .toEqual([[[0, 5, "kw"], [10, 13, "str"]]]);
  });

  it("colours keywords, strings and comments in TypeScript, and nothing else", async () => {
    const lines = await tokenize("typescript", [
      "import { Router } from \"express\";",
      "// a comment",
      "export const limit = 30 * 1000; /* block",
      " still a comment */ const t = `a ${limit} b`;",
      "function f(a: string): number { return a.length; }",
    ].join("\n"));
    expect(lines[0]).toEqual(["kw:import", "kw:from", "str:\"express\""]);
    expect(lines[1]).toEqual(["com:// a comment"]);
    // Operators, numbers and names stay the text colour.
    expect(lines[2]).toEqual(["kw:export", "kw:const", "com:/* block"]);
    // A template literal's hole is code again.
    expect(lines[3]).toEqual(["com: still a comment */", "kw:const", "str:`a ", "str: b`"]);
    expect(lines[4]).toEqual(["kw:function", "kw:return"]);
  });

  it("keeps a JSON file's keys the text colour and its string values a string", async () => {
    const lines = await tokenize("json", "{\n  \"name\": \"ccdeck\",\n  \"private\": true\n}");
    expect(lines[1]).toEqual(["str:\"ccdeck\""]);
    expect(lines[2]).toEqual(["kw:true"]);
  });

  it("reads Python and a shell script with the same three tones", async () => {
    expect((await tokenize("python", "def f(x):\n    return \"y\"  # why"))).toEqual([["kw:def"], ["kw:return", "str:\"y\"", "com:# why"]]);
    expect((await tokenize("shellscript", "if [ -f x ]; then echo \"hi\"; fi # done"))[0]).toEqual(["kw:if", "kw:then", "str:\"hi\"", "kw:fi", "com:# done"]);
  });
});

describe("what reaches the page", () => {
  const client = sourceOf("git-syntax.ts");
  const worker = sourceOf("git-syntax-worker.ts");

  it("imports every grammar lazily, each its own chunk", () => {
    expect(client).not.toMatch(/^import\s+(?!type)[^;]*from\s+["']shiki/m);
    const lazy = [...client.matchAll(/import\("shiki\/langs\/([a-z]+)\.mjs"\)/g)].map(m => m[1]);
    expect(lazy.sort()).toEqual(["csharp", "css", "go", "html", "java", "javascript", "json", "jsx", "markdown", "python", "rust", "shellscript", "sql", "tsx", "typescript", "yaml"]);
  });

  it("runs the tokenizer in a worker, with the fine-grained core and the JavaScript engine only", () => {
    expect(client).toContain('new Worker(new URL("./git-syntax-worker.ts", import.meta.url)');
    expect(worker).toMatch(/from "shiki\/core"/);
    expect(worker).toMatch(/from "shiki\/engine\/javascript"/);
    for (const heavy of ["shiki/bundle", "shiki/wasm", "engine/oniguruma", "from \"shiki\""]) expect(worker).not.toContain(heavy);
    // No dynamic import in the worker: it is built as one script, and the
    // grammars come to it from the page.
    expect(worker).not.toMatch(/import\(/);
  });

  it("names no colour: the tones are the stylesheet's", () => {
    for (const src of [client, worker]) expect(src).not.toMatch(/#[0-9a-f]{6}\b(?!.*stand-in)/i);
  });
});
