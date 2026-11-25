// The Accounts panel's notice for a login claude-swap does not hold showed its
// own markup: "Claude Code is signed in to <b>a@b.c</b>, which isn't in your
// accounts." The catalog marks the address with <b>…</b> so every language can
// put the emphasis where its grammar puts the word, and the panel filled the
// address in as a node without reading the mark around it.
//
// What these pin: the mark is drawn, never shown, in every language; the
// address is a text node inside it, so one with "<b>", "</b>" or "&" in it
// reads exactly as it is and cannot open or close a mark of its own; the
// notice keeps its Add account press. The same holds for every sentence in the
// accounts surfaces that carries an address, and for every marked catalog
// string, which must be drawn through the helpers that read the marks.
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES } from "../i18n/registry";
import { translate } from "../i18n/translate";
import type { MessageKey, TFunction } from "../i18n";
import { tNodes } from "../accounts-rich";
import UnlistedLoginNotice, { unlistedSentence } from "../components/UnlistedLoginNotice";
import { WEB_DIR } from "./client-source";

// Every character a template or a mark could be confused by.
const TRICKY = "o'neil+<b>x</b>&amp;</b><c>y</c>{email}@very-long-subdomain.example-company.test";
const LONG = `${"firstname.middlename.lastname.".repeat(4)}team@extremely-long-department-name.example.test`;

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
/** What a reader sees: the markup's text, entities read back. */
const textOf = (html: string) => unescape(html.replace(/<[^>]*>/g, ""));
const draw = (nodes: ReactNode) => renderToStaticMarkup(createElement("span", null, nodes));
const tFor = (code: string): TFunction => {
  const catalog = LANGUAGES.find(l => l.code === code)!.catalog;
  return (key, vars) => translate(code, catalog, key, vars);
};
const raw = (code: string, key: string): unknown =>
  (LANGUAGES.find(l => l.code === code)!.catalog as Record<string, unknown>)[key];

/** The sentence a reader should see: the catalog text, marks dropped, address in. */
const expected = (template: string, email: string) =>
  template.replace(/<\/?(b|c)>/g, "").split("{email}").join(email);

describe("the unlisted-login notice", () => {
  it("draws the address as bold text, never the catalog's mark", () => {
    const html = renderToStaticMarkup(<UnlistedLoginNotice email={TRICKY} onAdd={() => {}} />);
    expect(html).toContain(`<strong>${escape(TRICKY)}</strong>`);
    expect(html.match(/<strong>/g)).toHaveLength(1);
    // Nothing from the address became an element, and no mark is left as text.
    expect(html).not.toMatch(/<b>|<code>/);
    const sentence = /<span class="ap-notice-text">([\s\S]*?)<\/span>/.exec(html)![1];
    expect(textOf(sentence)).toBe(`Claude Code is signed in to ${TRICKY}, which isn't in your accounts.`);
    expect(textOf(sentence.replace(escape(TRICKY), ""))).not.toMatch(/[<>]/);
  });

  it("keeps the Add account press beside the sentence", () => {
    const html = renderToStaticMarkup(<UnlistedLoginNotice email={LONG} onAdd={() => {}} />);
    expect(html).toMatch(/^<div class="ap-notice"><span class="ap-notice-text">[\s\S]*<\/span><button type="button" class="ap-notice-fix" title="[^"]+">Add account<\/button><\/div>$/);
    expect(html).toContain(`<strong>${escape(LONG)}</strong>`);
  });

  it("wraps a long address instead of widening the column", () => {
    const css = readFileSync(`${WEB_DIR}styles/accounts-panel.css`, "utf8");
    const rule = /\.ap-notice-text \{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/overflow-wrap: anywhere/);
    expect(rule).toMatch(/min-width: 0/);
    expect(/\.ap-notice-fix \{([^}]*)\}/.exec(css)![1]).toMatch(/flex: none/);
  });
});

// Every sentence in the accounts surfaces that carries an address.
const ADDRESS_KEYS = [
  "accounts.panel.unlisted",
  "accounts.add.againAs",
  "accounts.add.approveEmail",
  "accounts.add.addedKept",
  "accounts.add.addedRestored",
  "accounts.add.alreadyHere",
] as const;

describe("an address in a marked sentence, in every language", () => {
  for (const language of LANGUAGES) {
    it(`${language.code}: the mark is drawn and the address stays text`, () => {
      const t = tFor(language.code);
      for (const key of ADDRESS_KEYS) {
        const template = raw(language.code, key);
        expect(typeof template, `${language.code} ${key} is missing`).toBe("string");
        expect((template as string).split("{email}"), `${language.code} ${key}`).toHaveLength(2);
        const html = draw(key === "accounts.panel.unlisted" ? unlistedSentence(t, TRICKY) : tNodes(t, key, { email: TRICKY }));
        expect(textOf(html), `${language.code} ${key}`).toBe(expected(template as string, TRICKY));
        // The address is one text node, in the one element its mark draws.
        expect(html, `${language.code} ${key}`).toContain(`<strong>${escape(TRICKY)}</strong>`);
        expect(html.match(/<strong>/g), `${language.code} ${key}`).toHaveLength(1);
        expect(textOf(html.replace(escape(TRICKY), "")), `${language.code} ${key} shows a tag`).not.toMatch(/[<>]/);
      }
    });
  }
});

describe("every marked catalog string", () => {
  // Plain text whose angle brackets ARE the text: the JSON viewer's stand-in
  // for an empty string, drawn by the library as text.
  const LITERAL = new Set(["radar.json.lib.empty"]);
  const PLURAL = /\.(zero|one|two|few|many|other)$/;

  const marked = new Map<string, string>();
  for (const language of LANGUAGES) {
    for (const [key, value] of Object.entries(language.catalog as Record<string, unknown>)) {
      if (typeof value === "string" && /<\/?[A-Za-z]/.test(value) && !LITERAL.has(key)) marked.set(`${language.code} ${key}`, value);
    }
  }

  it("uses only <b> and <c>, each one closed", () => {
    expect(marked.size).toBeGreaterThan(0);
    const bad = [...marked].filter(([, v]) => /<\/?[A-Za-z][^>]*>/.test(v.replace(/<(b|c)>(.*?)<\/\1>/g, "$2")));
    expect(bad).toEqual([]);
  });

  it("is drawn through Rich, richParts or tNodes, where the marks are read", () => {
    const keys = new Set([...marked.keys()].map(k => k.split(" ")[1].replace(PLURAL, "")));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { if (name !== "__tests__" && name !== "i18n") walk(path); }
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(WEB_DIR);
    const plain: string[] = [];
    let seen = 0;
    for (const path of files) {
      readFileSync(path, "utf8").split("\n").forEach((line, i) => {
        for (const key of keys) {
          if (!line.includes(`"${key}"`)) continue;
          seen++;
          if (!/\b(Rich|richParts|tNodes)\b/.test(line)) plain.push(`${path.slice(WEB_DIR.length)}:${i + 1} ${key}`);
        }
      });
    }
    expect(seen).toBeGreaterThanOrEqual(keys.size);
    expect(plain).toEqual([]);
  });
});

// Type check only: the keys above are real.
const _keys: readonly MessageKey[] = ADDRESS_KEYS;
void _keys;
