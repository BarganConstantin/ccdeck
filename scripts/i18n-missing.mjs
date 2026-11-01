#!/usr/bin/env node
// Finds English UI text that is still written into the components instead of
// the translation catalogs, so whoever translates an area can see what is left.
//
//   npm run i18n:missing                       counts per file, all of src/web/components
//   npm run i18n:missing -- src/web/components/Foo.tsx other/dir   only these
//   npm run i18n:missing -- --list <path>      also print every string with its line
//   npm run i18n:missing -- --json             machine-readable
//   npm run i18n:missing -- --logic [path]     the same for the .ts files under src/web that
//                                              build UI sentences (labels, notes, notices)
//
// What counts: JSX text, and a string literal in the user-visible attributes
// (title, aria-label, aria-description, placeholder, alt, label, summary) or
// inside a JSX {expression}, that reads as English (letters and a space, or a
// capitalised word) and is not already a t("key") call. What does not: product
// and technical names (scripts/i18n-allowlist.json), CSS classes and ids,
// import paths, anything that has no letters. It is a heuristic for an
// area's to-do list, never a CI gate: it exits 0.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const allow = JSON.parse(readFileSync(join(root, "scripts/i18n-allowlist.json"), "utf8"));
const WORDS = new Set(allow.words.map(w => w.toLowerCase()));
const ATTRS = new Set(["title", "aria-label", "aria-description", "aria-roledescription", "placeholder", "alt", "label", "summary"]);

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const targets = args.filter(a => !a.startsWith("--"));

function walk(path, out) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) if (name !== "__tests__" && name !== "node_modules" && name !== "i18n") walk(join(path, name), out);
  } else if (extname(path) === ".tsx" || (flags.has("--logic") && extname(path) === ".ts" && !path.endsWith(".d.ts") && !path.endsWith(".generated.ts"))) out.push(path);
  return out;
}

/** Does this string read as English a person sees? */
export function looksLikeEnglish(text) {
  const s = text.replace(/\s+/g, " ").trim();
  if (s.length < 2) return false;
  const letters = s.match(/[A-Za-z]/g);
  if (!letters || letters.length < 2) return false;
  if (/^[\w./:@#~\\-]+$/.test(s) && !/^[A-Z][a-z]{2,}$/.test(s)) return false; // an id, a path, a class, a key
  if (/^(https?:|\/|\.\/|\.\.\/|#|data:|var\(|rgb|hsl|calc\()/.test(s)) return false;
  const words = s.split(/[^A-Za-z]+/).filter(Boolean);
  if (words.every(w => WORDS.has(w.toLowerCase()))) return false;
  if (!/\s/.test(s) && !/^[A-Z][a-z]{2,}[.!?…:]?$/.test(s)) return false; // one lowercase token: a state, a unit
  return true;
}

/** A sentence-like string in logic code: two or more words, capitalised or ended with punctuation. */
function looksLikeSentence(text) {
  const s = text.replace(/\s+/g, " ").trim();
  if (!/\s/.test(s) || s.length < 6) return false;
  const words = s.split(/\s+/).filter(w => /[A-Za-z]{2,}/.test(w));
  if (words.length < 2) return false;
  if (!(/^[A-Z]/.test(s) || /[.!?…:]$/.test(s))) return false;
  if (/^(https?:|\/|\.)|=>|\$\{|[{};]|\b(function|const|return)\b/.test(s)) return false;
  if (words.every(w => WORDS.has(w.toLowerCase().replace(/[^a-z-]/g, "")))) return false;
  return true;
}

function scanLogic(file) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = [];
  function visit(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) {
      const p = node.parent;
      const skip = ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isCaseClause(p) || ts.isElementAccessExpression(p)
        || ts.isLiteralTypeNode(p) || ts.isEnumMember(p) || ts.isPropertySignature(p) || ts.isImportTypeNode(p)
        || (ts.isBinaryExpression(p) && /^[=!]==?$/.test(p.operatorToken.getText(sf)))
        || (ts.isCallExpression(p) && /^(console\.\w+|RegExp|require|describe|it|test|import)$/.test(p.expression.getText(sf)))
        || (ts.isCallExpression(p) && /(^|\.)(t|getItem|setItem|removeItem|querySelector|querySelectorAll|getElementById|addEventListener|removeEventListener|includes|startsWith|endsWith|split|replace|match)$/.test(p.expression.getText(sf)));
      const value = node.text ?? "";
      if (!skip && looksLikeSentence(value)) found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, kind: "logic", text: value.replace(/\s+/g, " ").trim().slice(0, 90) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

function scan(file) {
  if (flags.has("--logic") && !file.endsWith("x")) return scanLogic(file);
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const line = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const add = (node, value, kind) => { if (looksLikeEnglish(value)) found.push({ line: line(node), kind, text: value.replace(/\s+/g, " ").trim().slice(0, 90) }); };
  const insideT = node => { for (let p = node.parent; p; p = p.parent) if (ts.isCallExpression(p) && /^(t|useT\(\))$/.test(p.expression.getText(sf))) return true; return false; };

  function inJsx(node) { for (let p = node.parent; p; p = p.parent) if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p)) return true; return false; }

  function visit(node) {
    if (ts.isJsxText(node)) add(node, node.getText(sf), "text");
    else if (ts.isJsxAttribute(node) && ATTRS.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) add(init, init.text, "attr " + node.name.getText(sf));
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)) && inJsx(node) && !insideT(node)) {
      const p = node.parent;
      // attribute values were handled above; an import, a className and a key are not text
      if (ts.isJsxAttribute(p)) { /* handled */ }
      else if (ts.isJsxExpression(p) || ts.isConditionalExpression(p) || ts.isBinaryExpression(p) || ts.isParenthesizedExpression(p) || ts.isTemplateExpression(p)) {
        let attr = null;
        for (let q = p; q; q = q.parent) if (ts.isJsxAttribute(q)) { attr = q.name.getText(sf); break; }
        if (attr === null || ATTRS.has(attr)) add(node, node.text ?? "", attr ? "attr " + attr : "expr");
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return found;
}

const files = (targets.length ? targets : ["src/web/components"]).flatMap(t => walk(resolve(t), []));
const rows = files.map(f => ({ file: relative(root, f), hits: scan(f) })).filter(r => r.hits.length);
rows.sort((a, b) => b.hits.length - a.hits.length);

if (flags.has("--json")) console.log(JSON.stringify(rows.map(r => ({ file: r.file, count: r.hits.length, hits: r.hits })), null, 2));
else {
  for (const r of rows) {
    console.log(`${String(r.hits.length).padStart(4)}  ${r.file}`);
    if (flags.has("--list")) for (const h of r.hits) console.log(`        ${h.line}: [${h.kind}] ${h.text}`);
  }
  console.log(`\n${rows.reduce((n, r) => n + r.hits.length, 0)} strings in ${rows.length} of ${files.length} files`);
}
