// V4's top bar as its Figma draws it (the counts, the chips, the queue
// popover, the selected ribbon's removal). The bar is 40 tall on --panel over a
// --line rule; the start group is the wordmark and three count pills, then the
// chips only when needed; the end group is the version chip only when needed, the
// Layout switch, Search and a 28x28 Feedback icon. No Settings, no ribbon.
//
// Read from the sheet and the sources, the way the suite reads them; the
// popover is portalled, so its behaviour is pinned in the source and its look in
// the sheet.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";
import { blockedSessions } from "../ambient-counts";
import { incidentOf, type ProviderStatus } from "../provider-status";
import { IncidentChips } from "../components/ProviderIncidents";
import { QUEUE_EXIT_MS, WaitingStat } from "../components/TopbarReadouts";
import { CHIP_EXIT_MS } from "../components/ChipPresence";
import { sessionCounts } from "../topbar-counts";
import { en } from "../i18n/en";
import { versionChipNeeded } from "../version-chip";
import type { AgentNodeData } from "../types";

const web = fileURLToPath(new URL("..", import.meta.url));
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}
const decl = (selector: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(rule(selector));
  return m ? m[1].replace(/\s+/g, " ") : null;
};
const tokens = readFileSync(join(web, "styles/tokens.css"), "utf8");
const readouts = sourceOf("components/TopbarReadouts.tsx");
const app = sourceOf("App.tsx");

describe("the bar: 40 high, --panel, a rule under it, 12 and 8 at the sides", () => {
  it("is as tall as the height token, which is 40 at Compact and in the desktop chrome", () => {
    expect(css).toMatch(/grid-template-rows:\s*var\(--topbar-h\)\s+auto\s+1fr/);
    expect(readFileSync(join(web, "styles/reading.css"), "utf8")).toMatch(/--topbar-h:\s*40px;/);
    expect(readFileSync(join(web, "styles/desktop-titlebar.css"), "utf8")).toContain('[data-desktop-chrome="true"] { --topbar-h: 40px; }');
    expect(readFileSync(join(web, "../../desktop/window-chrome.mjs"), "utf8")).toContain("TITLEBAR_HEIGHT = 40;");
  });
  it("fills with --panel, flat, over a 1px --line rule, justify-between", () => {
    expect(decl(".topbar", "background")).toBe("var(--panel)");
    expect(decl(".topbar", "border-bottom")).toBe("1px solid var(--line)");
    expect(decl(".topbar", "justify-content")).toBe("space-between");
    // 12 at the start and 8 at the end; the pixel on top is the rule's twin, so
    // a 28px control sits on whole pixels (the frame sets no vertical padding).
    expect(decl(".topbar", "padding")).toBe("1px 8px 0 12px");
  });
  it("draws two groups: the start and the end", () => {
    expect(readouts).toContain('<div className="readout">');
    expect(readouts).toContain('<div className="tb-end">');
    expect(decl(".topbar .counts", "gap")).toBe("8px");
    expect(decl(".topbar .tb-end", "gap")).toBe("8px");
  });
  it("has no Settings and no selected ribbon on it", () => {
    expect(app).not.toContain("SelectedRibbon");
    expect(app).not.toContain("WaitingNames");
    expect(existsSync(join(web, "components/SelectedRibbon.tsx"))).toBe(false);
    expect(existsSync(join(web, "styles/selection-ribbon.css"))).toBe(false);
    expect(css).not.toContain(".selected-ribbon");
    expect(app).toMatch(/<UtilityRun items=\{\[rails\.search, \.\.\.rails\.topUtilities\]\}/);
    // The top bar's utilities are Feedback alone; Settings is at the Panel bar's foot.
    expect(sourceOf("rail-items.tsx")).toMatch(/topUtilities: \[feedback\]/);
  });
});

describe("the desktop app's title bar: the menu 8 in, the wordmark 44, the traffic lights' 80", () => {
  const chrome = ':root[data-desktop-chrome="true"]';
  it("packs the start group from the left and leaves the space only before the end group", () => {
    expect(decl(`${chrome} .topbar`, "padding-left")).toBe("8px");
    expect(decl(`${chrome} .topbar`, "gap")).toBe("12px");
    expect(decl(`${chrome} .topbar .tb-end`, "margin-left")).toBe("auto");
  });
  it("draws the app menu as the kit's 28 icon button with the More icon, 8 from the wordmark", () => {
    expect(decl(".desktop-menu.btn", "width")).toBe("28px");
    expect(decl(".desktop-menu.btn", "height")).toBe("28px");
    expect(decl(".desktop-menu.btn", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".desktop-menu.btn", "color")).toBe("var(--muted)");
    // 8 + 28 + (12 - 4) = 44, where the wordmark stands.
    expect(decl(".desktop-menu.btn", "margin-right")).toBe("-4px");
    const bar = sourceOf("components/DesktopTitlebar.tsx");
    expect(bar).toContain("<KitIcon name=\"more\" />");
    expect(bar).not.toContain("<svg");
  });
  it("starts 80 in on macOS, after the traffic lights", () => {
    expect(decl(`${chrome}[data-desktop-platform="darwin"] .topbar`, "padding-left")).toBe("var(--traffic-lights-w)");
    expect(decl(`${chrome}[data-desktop-platform="darwin"] .topbar`, "--traffic-lights-w")).toBe("80px");
  });
});

describe("the three counts", () => {
  it("are 24 tall pills: waiting outlined in --warn, working and done plain", () => {
    expect(decl(".topbar .count-pill", "height")).toBe("24px");
    expect(decl(".topbar .count-pill", "border")).toBe("0");
    expect(decl(".topbar .count-pill", "gap")).toBe("4px");
    expect(decl(".topbar .count-pill", "padding")).toBe("0 4px");
    expect(decl(".topbar .count-pill", "border-radius")).toBe("var(--r-pill)");
    expect(decl(".topbar .count-pill.waiting-stat", "border")).toBe("1px solid var(--warn)");
    expect(decl(".topbar .count-pill.waiting-stat", "padding")).toBe("0 8px 0 6px");
    expect(decl(".topbar .count-pill.waiting-stat", "color")).toBe("var(--warn)");
    expect(decl(".topbar .count-pill b", "font-family")).toBe("var(--font-mono)");
    expect(decl(".topbar .count-pill b", "font-weight")).toBe("600");
    expect(decl(".topbar .count-pill b", "color")).toBe("var(--text)");
    expect(decl(".topbar .count-pill.waiting-stat b", "color")).toBe("var(--warn)");
    expect(decl(".topbar .count-pill", "color")).toBe("var(--text-secondary)");
  });
  it("are drawn in the order waiting, working, done, right after the wordmark", () => {
    const brand = readouts.indexOf('<div className="brand">');
    const counts = readouts.indexOf('<div className="counts">');
    const status = readouts.indexOf("<StatusStrip");
    expect(brand).toBeGreaterThan(-1);
    expect(counts).toBeGreaterThan(brand);
    expect(status).toBeGreaterThan(counts);
    const block = readouts.slice(counts, status);
    expect(block.indexOf("<WaitingStat")).toBeGreaterThan(-1);
    expect(block.indexOf('kind="working"')).toBeGreaterThan(block.indexOf("<WaitingStat"));
    expect(block.indexOf('kind="done"')).toBeGreaterThan(block.indexOf('kind="working"'));
  });
  it("count sessions by the words their cards wear", () => {
    const root = (id: string, over: Partial<AgentNodeData>) =>
      ({ id, sessionId: id, kind: "root", state: "active", label: id, ...over }) as unknown as AgentNodeData;
    const agents = [
      root("a", {}),
      root("b", {}),
      root("c", { state: "done" }),
      root("d", { waiting: { kind: "permission", since: 1, message: "ok" } as never }),
      root("e", { state: "err" }),
      { ...root("sub", {}), kind: "subagent" } as AgentNodeData,
    ];
    expect(sessionCounts(agents)).toEqual({ waiting: 1, working: 2, done: 1 });
    expect(blockedSessions(agents).map(w => w.id)).toEqual(["d"]);
  });
  it("keep the waiting pill when nothing waits, as a quiet readout that opens nothing", () => {
    const html = renderToStaticMarkup(createElement(WaitingStat, {
      waitingSessions: [], waitingCursorRef: { current: null }, focusSession: () => {}, now: 0,
    }));
    expect(html).toContain('class="count-pill count-waiting"');
    expect(html).toContain("<b>0</b>");
    expect(html).not.toContain("<button");
  });
});

describe("the version chip, only when needed", () => {
  it("is drawn for a ready update or a drift notice and for nothing else", () => {
    expect(versionChipNeeded({ readyAppUpdate: null, notice: null })).toBe(false);
    expect(versionChipNeeded({ readyAppUpdate: { version: "4.0.1" }, notice: null })).toBe(true);
    expect(versionChipNeeded({ readyAppUpdate: null, notice: { to: "4.0.1" } })).toBe(true);
    const chip = sourceOf("components/VersionChip.tsx");
    expect(chip).toContain("if (!versionChipNeeded({ readyAppUpdate, notice })) return null;");
    expect(chip).not.toMatch(/className=\{versionChecking/);
    expect(chip).toContain("{`${notice.to} is ready`}");
  });
  it("is 24 tall, r6, --accent-16, no stroke, padded 0 6, 4 apart, a 14px icon first", () => {
    expect(decl(".topbar button.v", "height")).toBe("24px");
    expect(decl(".topbar button.v", "border")).toBe("0");
    expect(decl(".topbar button.v", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".topbar button.v", "padding")).toBe("0 6px");
    expect(decl(".topbar button.v", "gap")).toBe("4px");
    expect(decl(".topbar button.v:is(.stale, .ready)", "background")).toBe("var(--accent-16)");
    expect(decl(".topbar button.v .v-icon", "width")).toBe("14px");
    // The icon is the kit's, in the accent: Update on a newer version, Restart
    // on the app's ready update, which is the one chip "Restart to finish".
    expect(decl(".topbar button.v .v-icon", "color")).toBe("var(--accent)");
    const chip = sourceOf("components/VersionChip.tsx");
    expect(chip).toContain('<span className="v-icon" aria-hidden><KitIcon name="update" /></span>');
    expect(chip).toContain('<span className="v-icon" aria-hidden><KitIcon name="restart" /></span>');
    expect(en["shell.desktop.restartToFinish"]).toBe("Restart to finish");
  });
  it("sits in the end group, ahead of the Layout switch", () => {
    const end = readouts.indexOf('<div className="tb-end">');
    expect(readouts.indexOf("<VersionChip", end)).toBeGreaterThan(end);
    expect(readouts.indexOf("{children}", end)).toBeGreaterThan(readouts.indexOf("<VersionChip", end));
  });
});

describe("the Layout switch: 170x28, Medium on both, the selected one flat on --panel", () => {
  it("is 28 tall with its stroke inside the padding, r8, --bg-soft, --line-soft", () => {
    expect(decl(".view-switch", "box-sizing")).toBe("border-box");
    expect(decl(".view-switch", "height")).toBe("28px");
    expect(decl(".view-switch", "padding")).toBe("1px");
    expect(decl(".view-switch", "border")).toBe("1px solid var(--line-soft)");
    expect(decl(".view-switch", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".view-switch", "background")).toBe("var(--bg-soft)");
    expect(decl(".view-switch", "gap")).toBe("2px");
    // 1px of padding inside a 1px edge = the frame's 2px; two 24px segments
    // fill 24 + 2 + 2 = 28 high.
    expect(decl(".view-opt", "height")).toBe("24px");
    expect(decl(".view-opt", "gap")).toBe("6px");
    expect(decl(".view-opt", "padding")).toBe("0 8px");
    expect(decl(".view-opt", "border-radius")).toBe("var(--r-ctl)");
  });
  it("sets both segments in Medium, 500, the selected one on --panel in --text", () => {
    expect(decl(".view-opt", "font-weight")).toBe("500");
    expect(decl('.view-opt[aria-pressed="true"]', "font-weight")).toBeNull();
    expect(decl('.view-opt[aria-pressed="true"]', "background")).toBe("var(--panel)");
    expect(decl('.view-opt[aria-pressed="true"]', "color")).toBe("var(--text)");
    expect(decl(".view-opt", "color")).toBe("var(--muted)");
  });
  it("draws no shadow on either segment: the selected one is told by its fill alone", () => {
    // CHANGED ON PURPOSE (V4's Figma): the selected segment is flat on --panel;
    // the deck used to lift it with --shadow-contact.
    expect(decl('.view-opt[aria-pressed="true"]', "box-shadow")).toBeNull();
    expect(decl(".view-opt", "box-shadow")).toBeNull();
    expect(decl(".view-opt", "transition")).not.toMatch(/box-shadow/);
  });
});

describe("Search: 264x28 with the key chip, and Feedback: a 28x28 icon with its name", () => {
  it("is a field 264 by 28 holding the sentence and the chord's Kbd", () => {
    // CHANGED ON PURPOSE (V4's Figma): 264 is drawn around ⌘K. Off a Mac, Ctrl+K is about 24
    // wider and cut the sentence, so the field fits what it holds, from 264 up to that 24 more.
    expect(decl(".rail-btn-bar.rail-btn-field", "width")).toBe("auto");
    expect(decl(".rail-btn-bar.rail-btn-field", "min-width")).toBe("264px");
    expect(decl(".rail-btn-bar.rail-btn-field", "max-width")).toBe("288px");
    expect(decl(".rail-btn-field .rail-field-text", "flex")).toBe("1 1 auto");
    expect(decl(".rail-btn-bar.rail-btn-field", "height")).toBe("28px");
    expect(decl(".rail-btn-bar.rail-btn-field", "box-sizing")).toBe("border-box");
    expect(decl(".rail-btn-bar.rail-btn-field", "padding")).toBe("0 4px 0 8px");
    expect(decl(".rail-btn-bar.rail-btn-field", "gap")).toBe("8px");
    const rails = sourceOf("components/EdgeRails.tsx");
    expect(rails).toContain("{item.key && <Kbd>{item.key.cap}</Kbd>}");
    // CHANGED ON PURPOSE (the UI in every language): the source names the key,
    // and English maps it to the same words.
    expect(sourceOf("rail-items.tsx")).toContain('QUICK_OPEN_PLACEHOLDER_MSG = "board.quick.placeholder"');
    expect(sourceOf("rail-items.tsx")).toContain("fieldText: t(QUICK_OPEN_PLACEHOLDER_MSG)");
    expect(en["board.quick.placeholder"]).toBe("Open a session or run a command");
  });
  it("draws Feedback as a 28x28 icon, named and hinted by its word", () => {
    expect(decl(".rail-btn-bar.rail-btn-icon", "width")).toBe("28px");
    expect(decl(".rail-btn-bar.rail-btn-icon", "height")).toBe("28px");
    const items = sourceOf("rail-items.tsx");
    expect(items).toMatch(/ariaLabel: t\("board\.rail\.feedback\.menu"\)/);
    expect(items).toMatch(/barLook: "icon"/);
    const rails = sourceOf("components/EdgeRails.tsx");
    expect(rails).toContain('variant !== "stripe" && !iconOnly && <span className="rail-word">');
    expect(rails).toContain('railHint(hinted, singleKeys, variant !== "stripe" && !iconOnly)');
  });
  it("gaps its two with 8", () => {
    expect(decl(".utility-run", "gap")).toBe("8px");
  });
});

describe("the queue popover", () => {
  it("opens from the waiting pill as a menu, and its rows are the queue in n's order", () => {
    expect(readouts).toContain('aria-haspopup="menu"');
    expect(readouts).toContain('role="menu"');
    expect(readouts).toContain('role="menuitem"');
    expect(readouts).toMatch(/sessions=\{waitingSessions\}/);
    expect(readouts).toMatch(/\{sessions\.map\(w => \(/);
    expect(app).toContain("blockedSessions(stateRef.current.agents.values())");
  });
  it("opens with a click, Enter, Space or ArrowDown on the pill", () => {
    expect(readouts).toMatch(/onClick=\{\(\) => \{\s*if \(popRef\.current === "closed"\) setPop\("open"\);/);
    expect(readouts).toContain('e.key === "ArrowDown"');
  });
  it("a row focuses that session, as n does, and puts W's cursor on it", () => {
    expect(readouts).toMatch(/waitingCursorRef\.current = id;\s*close\(\);\s*focusSession\(id\);/);
  });
  it("closes on Escape and on a press outside, and walks its rows with the arrows (AnchoredPopover)", () => {
    const pop = sourceOf("components/AnchoredPopover.tsx");
    expect(pop).toContain("useModalDismiss");
    expect(pop).toContain("useOutsidePress");
    expect(pop).toContain("menuMove");
    expect(readouts).toContain('role="menu"');
  });
  it("is the menu's look: --panel, a --line edge, the overlay shadow, rows at the table height", () => {
    expect(decl(".anchored-popover.queue-pop", "box-shadow")).toBe("var(--shadow-overlay)");
    // CHANGED ON PURPOSE (V4's Figma): the popover is 320 wide on the overlay
    // corner (12), padded 12, with 8 between its heading, rows and foot.
    expect(decl(".anchored-popover.queue-pop", "border-radius")).toBe("var(--r-overlay)");
    expect(tokens).toMatch(/--r-overlay:\s*12px;/);
    expect(decl(".anchored-popover.queue-pop", "width")).toBe("320px");
    expect(decl(".anchored-popover.queue-pop", "padding")).toBe("12px");
    expect(decl(".anchored-popover.queue-pop", "gap")).toBe("8px");
    expect(decl(".queue-row", "min-height")).toBe("var(--row-table)");
    expect(decl(".queue-row:focus-visible", "background")).toBe("var(--selected)");
    expect(css).toMatch(/\.anchored-popover \{[^}]*background: var\(--panel\);[^}]*border: 1px solid var\(--line\);/);
  });
  it("heads its rows with a muted 'Waiting on you', seen and not read", () => {
    expect(readouts).toContain('<div className="queue-head" aria-hidden>{t("board.queue.title")}</div>');
    expect(en["board.queue.title"]).toBe("Waiting on you");
    expect(decl(".queue-head", "color")).toBe("var(--muted)");
    expect(decl(".queue-head", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(decl(".queue-head", "line-height")).toBe("16px");
    expect(decl(".queue-head", "font-weight")).toBe("500");
  });
  it("draws a row as the Waiting glyph, the name in SemiBold 13 and the wait in mono 11 at the right end", () => {
    const at = readouts.indexOf("{sessions.map(w => (");
    const row = readouts.slice(at, readouts.indexOf("))}", at));
    expect(row).toContain("<AlertMark size={14} />");
    expect(row.indexOf("<AlertMark")).toBeLessThan(row.indexOf("<QueueEntryWords"));
    expect(decl(".queue-row .alert-mark", "margin-left")).toBe("0");
    expect(decl(".queue-row", "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
    expect(decl(".queue-row .we-name", "font-weight")).toBe("600");
    expect(decl(".queue-row :is(.we-wait, .we-what)", "font-family")).toBe("var(--font-mono)");
    expect(decl(".queue-row :is(.we-wait, .we-what)", "font-size")).toBe("calc(11px + var(--ui-text-increase, 0px))");
    expect(decl(".queue-row :is(.we-wait, .we-what)", "line-height")).toBe("14px");
    expect(decl(".queue-row :is(.we-wait, .we-what)", "color")).toBe("var(--muted)");
    expect(decl(".queue-row .we-wait", "margin-left")).toBe("auto");
  });
  it("keeps every waiting session a row: a long queue scrolls, and a foot counts what is out of view, with n", () => {
    // Every row stays in the menu, so each is still a press and the arrows
    // still reach it; only the list scrolls, under a heading and foot that stay.
    expect(decl(".queue-rows", "overflow-y")).toBe("auto");
    expect(decl(".queue-rows", "min-height")).toBe("0");
    expect(readouts).toMatch(/\{unseen > 0 && \(\s*<div className="queue-foot" aria-hidden>\s*<span>\{t\("board\.queue\.more", \{ n: unseen \}\)\}<\/span>\s*\{singleKeys && <Kbd>n<\/Kbd>\}\s*<\/div>\s*\)\}/);
    expect(en["board.queue.more"]).toBe("+{n} more");
    expect(readouts).toContain("setUnseen(Math.max(0, sessions.length - rowsInView(list)));");
    // The reader's scroll survives the popover placing itself again.
    expect(readouts).toContain("list.scrollTop = scrolled.current;");
  });
  it("moves with TRANSITIONS from the trigger corner: --enter-scale in over --dur-base, .98 out over --dur-exit", () => {
    const base = ".anchored-popover.queue-pop";
    expect(decl(base, "animation")).toBe("none");
    expect(decl(base, "opacity")).toBe("0");
    expect(decl(base, "transform")).toBe("scale(var(--enter-scale))");
    expect(decl(base, "transform-origin")).toBe("top left");
    expect(decl(base, "transition")).toBe("opacity var(--dur-base) var(--ease), transform var(--dur-base) var(--ease)");
    expect(decl(`${base}.queue-pop-open`, "opacity")).toBe("1");
    expect(decl(`${base}.queue-pop-open`, "transform")).toBe("none");
    expect(decl(`${base}.queue-pop-leaving`, "transform")).toBe("scale(0.98)");
    expect(decl(`${base}.queue-pop-leaving`, "transition-duration")).toBe("var(--dur-exit)");
    const queueCss = css.slice(css.indexOf(".anchored-popover.queue-pop {"), css.indexOf(".queue-row {"));
    expect(queueCss).not.toContain("@keyframes");
    expect(queueCss).not.toMatch(/animation:\s*[^n\s]/);
  });
  it("has none by key (data-motion=instant) and only opacity under reduced motion", () => {
    expect(css).toContain(':root[data-motion="instant"] .anchored-popover.queue-pop { transition: none; }');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.anchored-popover\.queue-pop,\s*\.anchored-popover\.queue-pop\.queue-pop-leaving \{ transform: none; transition-property: opacity; \}/);
    expect(readouts).toContain('document.documentElement.dataset.motion === "instant"');
    expect(readouts).toMatch(/if \(keyDriven\(\)\) \{ setPop\("closed"\); return; \}/);
  });
  it("is kept mounted for exactly the exit token's length", () => {
    const m = /--dur-exit:\s*(\d+)ms/.exec(tokens);
    expect(Number(m![1])).toBe(QUEUE_EXIT_MS);
    expect(Number(m![1])).toBe(CHIP_EXIT_MS);
  });
});

describe("no word Live on a session", () => {
  it("is not in the Inspector's hero: it wears the card's word", () => {
    const detail = sourceOf("components/Detail.tsx");
    const hero = detail.slice(detail.indexOf('<header className="detail-hero">'), detail.indexOf('<div className="hero-meta">'));
    // CHANGED ON PURPOSE (V4's Figma): the state is a glyph now, named by the pane's sentence for a
    // session and by the card's word otherwise; the word the card wears is still the fallback.
    expect(hero).toContain("status?.phrase ?? cardState(agent).word");
    expect(hero).not.toMatch(/stateLabel|board\.state\.live|\bLIVE\b|"Live"/);
  });
  it("is not on the bar", () => {
    expect(readouts + app).not.toMatch(/board\.state\.live|\bLIVE\b/);
    expect(readouts).not.toMatch(/stateLabel/);
  });
});

describe("Esc clears the selection and Z frames it, which is what the ribbon's × and click did", () => {
  const keys = sourceOf("use-deck-shortcuts.ts");
  it("clears the selection on Escape when nothing else answers it", () => {
    expect(keys).toMatch(/if \(shouldReleaseFocusOnEscape\(target\)\) el\?\.blur\(\);\s*clearSelection\(\);/);
  });
  it("frames the selected card on Z", () => {
    expect(keys).toMatch(/e\.key === "z" \|\| e\.key === "Z"\) \{\s*if \(primarySelectedIdRef\.current\) focusAgent\(primarySelectedIdRef\.current\);/);
  });
});

describe("the provider incident chip: Claude · partial outage · as of HH:MM", () => {
  const NOW = 1_790_550_000_000;
  const line = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
    provider: "claude", state: "partial_outage", summary: null, components: [], checkedAt: NOW - 60_000, stale: false,
    statusPageUrl: "https://status.claude.com", ...over,
  });
  it("reads as one line with the time the page last answered, fresh or stale", () => {
    const inc = incidentOf(line(), NOW)!;
    const html = renderToStaticMarkup(createElement(IncidentChips, { incidents: [inc] }));
    expect(html).toContain('<span class="pi-name">Claude</span>');
    expect(html).toContain('<span class="pi-words">· partial outage</span>');
    expect(html).toContain(`<span class="pi-asof">· as of ${inc.readAt}</span>`);
    expect(inc.readAt).toMatch(/^\d{2}:\d{2}$/);
    expect(html).toContain('<span class="pi-icon" aria-hidden="true"><span class="pi-dot"></span></span>');
    expect(html).not.toContain("pi-go");
  });
  it("is 24 tall, a --warn pill, padded 0 8 0 6, 4 apart, one regular line in --text", () => {
    const sel = ".topbar .provider-incident";
    expect(decl(sel, "height")).toBe("24px");
    expect(decl(sel, "border")).toBe("1px solid var(--warn)");
    expect(decl(sel, "border-radius")).toBe("var(--r-pill)");
    expect(decl(sel, "padding")).toBe("0 8px 0 6px");
    expect(decl(sel, "gap")).toBe("4px");
    expect(decl(sel, "color")).toBe("var(--text)");
    expect(decl(`${sel} .pi-name`, "font-weight")).toBe("400");
    expect(decl(`${sel} .pi-icon`, "width")).toBe("14px");
  });
});

describe("a chip's exit: opacity and x, then the neighbours close over the gap", () => {
  it("is a slot with transitions, from --dur-base in to --dur-exit out", () => {
    expect(decl(".topbar .chip-slot", "opacity")).toBe("0");
    expect(decl(".topbar .chip-slot[data-on]", "transition-duration")).toBe("var(--dur-base)");
    expect(decl(".topbar .chip-slot", "grid-template-columns")).toBe("0fr");
    const chips = sourceOf("components/ChipPresence.tsx");
    expect(chips).toContain("data-on={on || undefined}");
    expect(sourceOf("components/ProviderIncidents.tsx")).toContain("<ChipPresence");
    expect(readouts).toContain('<ChipPresence show={!pill.resting} className="status">');
  });
});

describe("strokes sit inside, so each box measures the frame's outer size", () => {
  it("Inspector tabs 24, Board controls 28, Kbd 16 tall and 17 for one letter, Layout switch 28", () => {
    expect(decl(".insp-tabs", "padding")).toBe("1px");
    expect(decl(".react-flow__controls", "padding")).toBe("1px");
    expect(decl(".kbd", "padding")).toBe("0 4px");
    expect(decl(".kbd", "line-height")).toBe("calc(14px + var(--ui-text-increase, 0px))");
    expect(decl(".kbd", "border")).toBe("1px solid var(--line)");
    expect(decl(".view-switch", "height")).toBe("28px");
  });
});
