// V4's top bar, three looks (V4's Figma): the waiting chip
// draws the rail's Waiting glyph and no pulsing dot; the newer-version chip
// reads "{to} is ready"; the right group is a search field with its sentence
// and chord. Feedback keeps its word (#1853), though Figma draws a bare icon.
// Every handler, name and key stays as it was.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QUICK_OPEN_PLACEHOLDER_MSG, railItems } from "../rail-items";
import { en } from "../i18n/en";

const QUICK_OPEN_PLACEHOLDER = en[QUICK_OPEN_PLACEHOLDER_MSG];
import { railHint, UtilityRun } from "../components/EdgeRails";
import { WaitingStat } from "../components/TopbarReadouts";
import VersionChip from "../components/VersionChip";
import { KitIcon } from "../components/kit-icons";
import { versionNoticeLabel } from "../version-chip";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const noop = () => {};
const ref = () => ({ current: null });
const rails = railItems({
  providers: { kind: "reported", claude: true, codex: true },
  sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
  usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
  setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
  openSettings: noop, onFeedback: noop, toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() },
  openQuickOpen: noop, feedbackUnread: 0, openFeedbackConversations: noop,
});
const group = renderToStaticMarkup(createElement(UtilityRun, { items: [rails.search, ...rails.utilities] }));
const buttonOf = (html: string, id: string) => {
  const at = html.indexOf(`data-rail-item="${id}"`);
  expect(at, id).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", at), html.indexOf("</button>", at));
};

describe("the waiting chip", () => {
  const html = renderToStaticMarkup(createElement(WaitingStat, {
    waitingSessions: [{ id: "a", label: "web", waiting: { since: 0 } } as never],
    waitingCursorRef: { current: null }, focusSession: noop, now: 1000,
  }));

  it("draws the deck's Waiting glyph, 14px, and does not pulse", () => {
    expect(html).toMatch(/<svg class="alert-mark"[^>]*width="14" height="14"/);
    expect(html).not.toContain("ap-pulse");
    expect(html).toContain('<b>1</b><span class="count-word">waiting</span>');
  });

  it("keeps its name and its button", () => {
    expect(html).toContain('aria-label="1 session waiting for you"');
    expect(html).toContain('class="count-pill count-waiting waiting-stat"');
    // V4's top bar: it opens the queue popover, a menu.
    expect(html).toContain('aria-haspopup="menu"');
  });

  it("leaves no rule behind for the dot it stopped drawing", () => {
    expect(read("../styles/topbar-controls.css")).not.toMatch(/waiting-stat \.ap-pulse/);
    // The glyph leads the chip: its global rule's margin-left: auto is undone here.
    expect(strip(read("../styles/topbar-controls.css"))).toMatch(/\.topbar \.count-pill \.alert-mark \{ margin-left: 0; \}/);
  });
});

describe("the newer-version chip", () => {
  const render = (kind: "upgrade" | "restart") => renderToStaticMarkup(createElement(VersionChip, {
    readyAppUpdate: null, notice: { kind, from: "4.0.0", to: "4.0.1" } as never, noticeOpen: false,
    version: null, chipVersion: "4.0.0", versionChecking: false, now: 0,
    openReleaseNotes: noop, showNotice: noop, loadVersion: async () => {},
  }));

  it("reads '{to} is ready' with no leading v, after the kit's still Update icon", () => {
    // CHANGED ON PURPOSE (V4's Figma): the chip leads with the kit's Update
    // icon, not a dot.
    const updateIcon = renderToStaticMarkup(createElement(KitIcon, { name: "update" }));
    for (const kind of ["upgrade", "restart"] as const) {
      const html = render(kind);
      expect(html).toContain("4.0.1 is ready");
      expect(html).not.toMatch(/>v4\.0\.0</);
      expect(html).toContain(`<span class="v-icon" aria-hidden="true">${updateIcon}</span>`);
      expect(html).not.toContain("v-dot");
    }
  });

  it("carries the visible words at the start of its name (2.5.3)", () => {
    expect(versionNoticeLabel({ kind: "upgrade", from: "4.0.0", to: "4.0.1", open: false }).startsWith("4.0.1 is ready")).toBe(true);
    expect(render("upgrade")).toContain('aria-label="4.0.1 is ready. Running v4.0.0');
  });
});

describe("the right group", () => {
  it("draws Search as a field: the sentence and the platform's chord, one button", () => {
    const search = buttonOf(group, "quick-open");
    expect(search).toContain("rail-btn-field");
    // CHANGED ON PURPOSE (the UI in every language): the sentence is a key,
    // and English maps it to the same words.
    expect(search).toContain(QUICK_OPEN_PLACEHOLDER);
    expect(QUICK_OPEN_PLACEHOLDER_MSG).toBe("board.quick.placeholder");
    expect(QUICK_OPEN_PLACEHOLDER).toBe("Open a session or run a command");
    expect(search).toContain(`<kbd class="kbd">${rails.search.key!.cap}</kbd>`);
    // Named by the sentence it shows (WCAG 2.5.3, label in name).
    expect(search).toContain(`aria-label="${QUICK_OPEN_PLACEHOLDER}"`);
    expect(search).toContain('aria-haspopup="dialog"');
  });

  it("draws Feedback as V4's bare 28x28 icon, still named and hinted by its word", () => {
    // Figma draws Feedback icon-only; #1853's visible word is now the hint's
    // (the tooltip says "Feedback") and the button's accessible name still
    // contains it ("Send feedback").
    const feedback = buttonOf(group, "feedback");
    expect(feedback).not.toContain("rail-word");
    expect(feedback).toContain("rail-btn-icon");
    expect(feedback).not.toContain("rail-btn-field");
    expect(feedback).toMatch(/aria-label="Send feedback"/);
    expect(rails.utilities[1].barLook).toBe("icon");
    expect(railHint({ ...rails.utilities[1] }, true, false)?.label).toBe("Feedback");
  });

  it("gives the field a hint in its own words, and names it by them", () => {
    // The button hands the field's sentence over as the hint's name.
    const src = read("../components/EdgeRails.tsx");
    expect(src).toMatch(/railHint\(hinted, singleKeys, variant !== "stripe" && !iconOnly\)/);
    expect(src).toMatch(/aria-label=\{fieldText \?\? item\.ariaLabel\}/);
    const field = railHint({ ...rails.search, label: QUICK_OPEN_PLACEHOLDER, hint: undefined }, false, true);
    expect(field?.label).toBe(QUICK_OPEN_PLACEHOLDER);
    expect(field?.keys).toBe(rails.search.key!.cap);
    expect(rails.search.barLook).toBe("field");
    expect(rails.search.fieldText).toBe(QUICK_OPEN_PLACEHOLDER);
  });

  it("leaves Settings as it was, with its word", () => {
    expect(buttonOf(group, "settings")).toContain('<span class="rail-word">Settings</span>');
  });

  it("sizes the field from Figma, in tokens, and gives the room back when narrow", () => {
    const css = strip(read("../styles/edge-rails.css"));
    const field = css.match(/\.rail-btn-bar\.rail-btn-field \{([^}]*)\}/)![1];
    expect(field).toMatch(/width: 264px/);
    expect(field).toMatch(/height: 28px/);
    expect(field).toMatch(/var\(--bg-soft\)/);
    expect(field).toMatch(/var\(--line-soft\)/);
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a field is a control, at 4.
    expect(field).toMatch(/var\(--r-ctl\)/);
    expect(field).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(strip(read("../styles/edge-rails.css")).match(/\.rail-btn-bar\.rail-btn-icon \{([^}]*)\}/)![1]).toMatch(/width: 28px;[\s\S]*height: 28px/);
    expect(css).toMatch(/@media \(max-width: 1279px\) \{\s*\.rail-btn-bar\.rail-btn-field \{ width: 200px/);
    expect(css).toMatch(/@media \(max-width: 899px\)/);
  });
});
