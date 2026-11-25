// Chat's motion contract (components/chat/chat-motion.css). Chat used to be
// held still by a test that failed on any motion in chat.css; it moves now,
// and this file is what holds that motion to the deck's rules instead:
//
//   * every transition and animation of Chat is in chat-motion.css, none in
//     chat.css (v4-chat-view.test.ts) or in its components' inline styles;
//   * each one is timed in the motion tokens (--dur-*, --loop-*) and eased
//     with --ease, never a written-out duration or curve; the working mark's
//     frames are stepped (steps()), which is a frame count, not a curve;
//   * every rule that moves has a rule of the same selector in a
//     prefers-reduced-motion block that stops it, placed after it;
//   * an arrival never waits (no delay that would leave a blank gap) and is
//     only for lines put in while `.chat` says data-arrive;
//   * the one loop is the working mark's, and only while the session works.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { clientSources } from "./client-source";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const motion = strip(read("components/chat/chat-motion.css"));

/** The body of the at-rule that starts at `at` (its braces matched). */
function block(css: string, at: number): { body: string; end: number } {
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return { body: css.slice(open + 1, i), end: i + 1 };
  }
  throw new Error("unbalanced braces");
}

/** The sheet with every block of `kind` taken out, and their bodies. */
function without(css: string, kind: RegExp): { rest: string; bodies: string[] } {
  const bodies: string[] = [];
  let rest = css;
  for (let m = kind.exec(rest); m; m = kind.exec(rest)) {
    const { body, end } = block(rest, m.index);
    bodies.push(body);
    rest = rest.slice(0, m.index) + rest.slice(end);
    kind.lastIndex = 0;
  }
  return { rest, bodies };
}

const reduced = without(motion, /@media \(prefers-reduced-motion: reduce\)/g);
const starting = without(reduced.rest, /@starting-style/g);
const frames = without(starting.rest, /@keyframes [\w-]+/g);
/** The rules that are neither reduced-motion answers, starting styles nor keyframes. */
const moving = [...frames.rest.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, sel, body]) => ({ selector: sel.replace(/\s+/g, " ").trim(), body }))
  .filter(rule => /\b(transition|animation)\s*:/.test(rule.body));
const answers = reduced.bodies.flatMap(body => [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, sel, decl]) => ({ selector: sel.replace(/\s+/g, " ").trim(), body: decl })));
const declarations = (prop: string) => moving.flatMap(rule =>
  [...rule.body.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].map(m => ({ selector: rule.selector, value: m[1].replace(/\s+/g, " ").trim() })));

describe("Chat's motion lives in chat-motion.css", () => {
  it("moves something (a passing run means the sweep found its rules)", () => {
    expect(moving.length).toBeGreaterThanOrEqual(6);
    expect(reduced.bodies).toHaveLength(1);
  });

  it("is the only Chat sheet with keyframes, and no Chat component moves from an inline style", () => {
    expect(strip(read("components/chat/chat.css"))).not.toMatch(/@keyframes/);
    expect(strip(read("components/chat/chat-composer.css"))).not.toMatch(/@keyframes|animation\s*:/);
    const chat = clientSources().filter(path => /components[\\/]chat[\\/].*\.tsx$/.test(path));
    expect(chat.length).toBeGreaterThan(3);
    for (const path of chat) expect(readFileSync(path, "utf8"), path).not.toMatch(/(transition|animation)\s*:\s*["'`]/);
  });
});

describe("timed in the deck's motion tokens", () => {
  const timed = [...declarations("transition"), ...declarations("animation")];

  it("writes out no duration: every one is a --dur-* or --loop-* token", () => {
    expect(timed.length).toBeGreaterThan(0);
    for (const { selector, value } of timed) {
      expect(value, selector).not.toMatch(/\d(?:\.\d+)?m?s\b/);
      for (const part of value.split(/,(?![^(]*\))/)) expect(part, `${selector}: ${part}`).toMatch(/var\(--(?:dur|loop)-[\w-]+\)/);
    }
  });

  it("eases with --ease, or steps through frames; never a written-out curve", () => {
    for (const { selector, value } of timed) {
      expect(value, selector).not.toMatch(/(?<![-\w])(?:ease|ease-in|ease-out|ease-in-out|linear|cubic-bezier)(?![-\w])/);
      for (const part of value.split(/,(?![^(]*\))/)) expect(part, `${selector}: ${part}`).toMatch(/var\(--ease\)|steps\(\d+, jump-none\)/);
    }
  });

  it("never delays an arrival: a line is on its way from its first frame", () => {
    expect(motion).not.toMatch(/(?:transition|animation)-delay|--delay-/);
    expect(motion).not.toMatch(/fill-mode|backwards|both/);
  });

  it("loops once: the working mark, only while the session works and has not gone quiet", () => {
    const loops = declarations("animation").filter(d => /\binfinite\b/.test(d.value));
    expect(loops.map(d => d.selector)).toEqual(['.chat-progress[data-state="working"]:not([data-quiet]) .chat-progress-frames']);
  });

  it("starts an arrival only on lines put in while the column says so", () => {
    const arriving = moving.filter(rule => /opacity/.test(rule.body) && /\.chat-(col|response|activity-calls)/.test(rule.selector));
    expect(arriving.length).toBeGreaterThan(0);
    for (const rule of arriving) for (const one of rule.selector.split(",")) expect(one.trim(), one).toMatch(/^\.chat\[data-arrive\] /);
    expect(starting.bodies.join("")).toMatch(/opacity: 0; translate: 0 6px;/);
  });
});

describe("reduced motion", () => {
  it("every rule that moves is answered, selector for selector, by a rule that stops it", () => {
    const stopped = new Map<string, string>();
    for (const rule of answers) for (const one of rule.selector.split(/,(?![^(]*\))/)) stopped.set(one.trim(), rule.body);
    const missing: string[] = [];
    for (const rule of moving) {
      for (const one of rule.selector.split(/,(?![^(]*\))/)) {
        const body = stopped.get(one.trim());
        const kinds = ["transition", "animation"].filter(k => new RegExp(`\\b${k}\\s*:`).test(rule.body));
        if (!body || !kinds.every(k => new RegExp(`\\b${k}\\s*:\\s*none\\b`).test(body))) missing.push(`${one.trim()} (${kinds.join(", ")})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("comes after the rules it answers, so it wins the tie", () => {
    const at = motion.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(-1);
    expect(motion.slice(at + 1)).not.toMatch(/\b(transition|animation)\s*:(?!\s*none\b)/);
  });

  it("leaves the working mark still on ✻ (chat.css rests it there)", () => {
    const chat = strip(read("components/chat/chat.css"));
    expect(chat).toMatch(/\.chat-progress-frames \{[^}]*translate: 0 -64px;/);
    expect(chat).toMatch(/\.chat-progress-frames > span \{[^}]*height: 16px;/);
  });
});
