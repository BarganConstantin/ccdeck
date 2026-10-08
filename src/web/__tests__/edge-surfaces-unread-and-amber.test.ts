// Browser watch's unread count on the window's edge, and amber kept for the
// waiting count alone (2026-10-08).
//
// The count rode on the topbar's eye as `.bw-badge`, and on the phone's ⋯ while
// the eye was folded into it. The eye is on the right stripe now, so the count
// is `.rail-badge` after its word, in the chrome's resting grey: a count, not
// an alarm. On a phone the dock's More wears the same badge while Browser
// watch is behind it, and its row says how many are unread. The number is in
// every accessible name that stands for it, because the badge itself is
// aria-hidden.
//
// AMBER IS THE WAITING COUNT'S. DESIGN.md's signature pattern reserves --warn
// for "blocked on you", and the redesign added two surfaces that could have
// borrowed it — the queue of names beside the count, and the edges — so this
// holds both to neutral: an amber name would be a row of alarms, and an amber
// badge would teach the reader to look past amber.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { railItems } from "../rail-items";
import { EdgeDock, EdgeRail } from "../components/EdgeRails";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const edges = strip(read("../styles/edge-rails.css"));
const controls = strip(read("../styles/topbar-controls.css"));
const rails = read("../components/EdgeRails.tsx");

const noop = () => {};
const ref = () => ({ current: null });
const itemsWith = (watchUnseen: number, watchOn = false) => railItems({
  providers: { kind: "reported", claude: true, codex: true },
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn, watchUnseen, setBrowserWatchOpen: noop,
  openSettings: noop, onFeedback: noop, toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
});
const rightStripe = (unseen: number) => renderToStaticMarkup(createElement(EdgeRail, {
  side: "right", label: "Right panels", groups: itemsWith(unseen).right,
}));
const phoneDock = (unseen: number) => {
  const r = itemsWith(unseen);
  return renderToStaticMarkup(createElement(EdgeDock, {
    items: [...r.left, ...r.right[0], r.utilities[0]], more: [...r.right[1], r.utilities[1]],
  }));
};
/** A button's opening tag and body, found by the start of its accessible name. */
const buttonNamed = (html: string, name: string) => {
  const at = html.indexOf(`aria-label="${name}`);
  expect(at, name).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
};

/** Every rule in a sheet, as selector and declarations. */
const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, decls]) => ({ sel: sel.trim(), decls }));

describe("Browser watch's unread count on the right stripe", () => {
  it("is drawn after the word as .rail-badge, and only when something is unread", () => {
    const button = buttonNamed(rightStripe(2), "Browser watch");
    expect(button).toMatch(/<span class="rail-word"[^>]*>Browser watch<\/span><span class="rail-badge" aria-hidden="true">2<\/span>$/);
    expect(buttonNamed(rightStripe(0), "Browser watch")).not.toContain("rail-badge");
  });

  it("is in the button's accessible name, since the badge itself is hidden", () => {
    expect(buttonNamed(rightStripe(2), "Browser watch")).toMatch(/aria-label="Browser watch, not watching, 2 unread"/);
    expect(buttonNamed(rightStripe(0), "Browser watch")).toMatch(/aria-label="Browser watch, not watching"/);
  });

  it("is a count in the chrome's resting grey, never amber", () => {
    const badge = rules(edges).find(r => r.sel === ".rail-badge");
    expect(badge, "no .rail-badge rule").toBeTruthy();
    expect(badge!.decls).toMatch(/background: var\(--muted\);/);
    expect(badge!.decls).toMatch(/color: var\(--bg\);/);
    expect(badge!.decls).not.toMatch(/--warn/);
  });
});

describe("Browser watch's unread count in the phone's dock", () => {
  it("rides on More while Browser watch is behind it, and is in More's name", () => {
    const more = buttonNamed(phoneDock(3), "More:");
    expect(more).toMatch(/aria-label="More: Usage history, Browser watch, not watching, 3 unread, Send feedback"/);
    expect(more).toMatch(/<span class="rail-badge" aria-hidden="true">3<\/span>$/);
    expect(buttonNamed(phoneDock(0), "More:")).not.toContain("rail-badge");
  });

  it("says how many are unread on Browser watch's own row in the menu", () => {
    // The menu is drawn only while it is open, so its row is read off the source.
    expect(rails).toMatch(/item\.badge \? `\$\{item\.menu \?\? item\.label\} · \$\{item\.badge\} unread` : item\.menu \?\? item\.label/);
  });
});

describe("amber is the waiting count's and nothing else's", () => {
  it("is nowhere on the edges: the stripes, the dock, the badge, the utilities or the hint", () => {
    expect(edges).not.toMatch(/--warn/);
  });

  it("is nowhere in the queue of names beside the count", () => {
    const queue = rules(controls).filter(r => /\.(?:wait-names|wait-list|wait-entry|we-name|we-meta|wait-more|wait-ruler)\b/.test(r.sel));
    expect(queue.length, "the queue's rules are gone from topbar-controls.css").toBeGreaterThan(5);
    for (const { sel, decls } of queue) expect(decls, sel).not.toMatch(/--warn/);
  });

  it("is on the count itself, which keeps it", () => {
    const count = rules(controls).find(r => r.sel === ".topbar .waiting-stat");
    expect(count!.decls).toMatch(/color: var\(--warn\);/);
  });
});
