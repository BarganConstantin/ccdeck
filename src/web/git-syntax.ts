// Quiet syntax colours for the diff pane, loaded the first time a diff of a
// language the deck knows is drawn, and never before.
//
// Nothing here is in the page's main bundle except this file: the tokenizer
// (Shiki's core with its JavaScript regex engine) runs in a worker of its own,
// and each grammar is a chunk the page imports on first use and hands to the
// worker. Until the colours arrive — and for a language with no grammar here,
// and if anything fails — the diff is plain text, already on screen.
import type { LineSpans } from "./git-syntax-theme";

export type { LineSpans, SynKind } from "./git-syntax-theme";

/** The grammars the deck carries, each a chunk of its own. */
const GRAMMARS: Record<string, () => Promise<{ default: unknown[] }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
};

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  json: "json", jsonc: "json",
  css: "css",
  html: "html", htm: "html",
  md: "markdown", markdown: "markdown",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  cs: "csharp",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  yml: "yaml", yaml: "yaml",
  sql: "sql",
};

const BY_NAME: Record<string, string> = {
  ".bashrc": "shellscript", ".zshrc": "shellscript", ".profile": "shellscript", ".bash_profile": "shellscript",
};

/** The grammar a file is coloured with, by its name, or null for plain text. */
export function langOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (BY_NAME[name]) return BY_NAME[name];
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

let worker: Worker | null = null;
/** The worker could not start or died: plain text from here on. */
let broken = false;
let nextId = 1;
const pending = new Map<number, (spans: LineSpans[][] | null) => void>();
const sent = new Map<string, Promise<boolean>>();
/** Answers already in, so a file read again colours on its first frame. */
const done = new Map<string, LineSpans[][]>();
const DONE_CAP = 32;

function fail() {
  broken = true;
  worker?.terminate();
  worker = null;
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (broken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./git-syntax-worker.ts", import.meta.url), { type: "module" });
  } catch {
    fail();
    return null;
  }
  worker.onmessage = (e: MessageEvent<{ t: string; id: number; spans: LineSpans[][] | null }>) => {
    const resolve = pending.get(e.data.id);
    pending.delete(e.data.id);
    resolve?.(e.data.spans);
  };
  worker.onerror = fail;
  return worker;
}

/** Hand `lang`'s grammar to the worker, once. */
function sendGrammar(w: Worker, lang: string): Promise<boolean> {
  let p = sent.get(lang);
  if (!p) {
    p = GRAMMARS[lang]().then(m => { w.postMessage({ t: "lang", lang, grammars: m.default }); return true; }, () => false);
    sent.set(lang, p);
  }
  return p;
}

const keyOf = (lang: string, docs: readonly string[]) => `${lang}\0${docs.join("\u0001")}`;

/** The spans already worked out for these documents, or null. Synchronous,
 *  for the first frame of a diff read before. */
export function cachedSpans(lang: string | null, docs: readonly string[]): LineSpans[][] | null {
  return lang ? done.get(keyOf(lang, docs)) ?? null : null;
}

/**
 * Spans for each of `docs` (each a run of lines tokenized together, so a
 * comment or a string that spans lines is read whole), line by line, or null
 * for plain text: an unknown language, a worker that could not start, a
 * grammar that did not load.
 */
export async function highlightDocs(lang: string | null, docs: readonly string[]): Promise<LineSpans[][] | null> {
  if (!lang || !GRAMMARS[lang] || docs.length === 0) return null;
  const key = keyOf(lang, docs);
  const hit = done.get(key);
  if (hit) return hit;
  const w = ensureWorker();
  if (!w) return null;
  if (!(await sendGrammar(w, lang)) || broken) return null;
  const id = nextId++;
  const spans = await new Promise<LineSpans[][] | null>(resolve => {
    pending.set(id, resolve);
    w.postMessage({ t: "tok", id, lang, docs });
  });
  if (spans) {
    if (done.size >= DONE_CAP) done.delete(done.keys().next().value!);
    done.set(key, spans);
  }
  return spans;
}
