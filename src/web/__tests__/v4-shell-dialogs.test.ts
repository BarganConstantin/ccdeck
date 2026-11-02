// The shell's dialogs as V4's Figma draws them: Clear the deck, the shortcuts
// sheet, the tour, What's new, Core history, Busiest processes, Quota history,
// Browser watch, Radio, Explore integrations, the dialog that did not load and
// the crash pane. Each block pins the sizes, type and colours of its frame, and
// that what the deck does (every shortcut, the tour's way out, Reload and Send
// report) is still there.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";
import { clearCopy } from "../clear-confirm";
import { KEY_HELP, WORKSPACE_KEY_ROW, keyHelpFor } from "../key-help";
import { capChips, splitColumns } from "../components/KeyboardHelp";
import board from "../i18n/areas/board/en";
import shell from "../i18n/areas/shell/en";
import insights from "../i18n/areas/insights/en";
import integrations from "../i18n/areas/integrations/en";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The value of `prop` in the first rule written for exactly this selector. */
function decl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  const m = rule && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return m ? m[1].trim() : null;
}
const px = (v: string | null) => (v ?? "").replace(/calc\(|\s*\+ var\(--ui-text-increase, 0px\)\)/g, "");

describe("Clear the deck", () => {
  const dialog = src("../components/ClearConfirm.tsx");
  it("is 560 wide with a plain title: no red dot before it", () => {
    expect(decl(".modal.clear-confirm", "width")).toBe("var(--dialog-s)");
    expect(dialog).not.toContain("status-dot");
    expect(board["board.clear.title"]).toBe("Clear the deck?");
  });
  it("says Clear the deck on the branch where another deck owns the log too", () => {
    expect(board["board.clear.confirmCanvas"]).toBe("Clear the deck");
    const owned = clearCopy(2, { path: "/x/events.jsonl", decks: 2, mine: false, ownerPort: 4318 });
    expect(owned.confirm).toBe("Clear the deck");
    expect(JSON.stringify(board)).not.toContain("Clear this canvas");
  });
  it("draws Goes and Stays as two columns of 24 apart, labels 12/16 600, rows 13/20", () => {
    expect(decl(".cc-plan", "grid-template-columns")).toBe("repeat(2, minmax(0, 1fr))");
    expect(decl(".cc-plan", "gap")).toBe("24px");
    expect(decl(".cc-col dt", "font-weight")).toBe("600");
    expect(decl(".cc-col dt", "line-height")).toBe("16px");
    expect(decl(".cc-col dd", "line-height")).toBe("var(--lh-body)");
    expect(decl(".cc-col dd", "color")).toBe("var(--text)");
    expect(decl(".modal-body.cc-body", "gap")).toBe("20px");
  });
  it("labels in --text-secondary (not --muted), bullets 4x4 r2 in --muted, the last line 12/16 --muted", () => {
    expect(decl(".cc-col dt", "color")).toBe("var(--text-secondary)");
    const bullet = css.match(/\.cc-col dd > span::before\s*\{([^}]*)\}/)![1];
    expect(bullet).toMatch(/width:\s*4px/);
    expect(bullet).toMatch(/height:\s*4px/);
    expect(bullet).toMatch(/border-radius:\s*2px/);
    expect(bullet).toMatch(/background:\s*var\(--muted\)/);
    expect(decl(".cc-final", "color")).toBe("var(--muted)");
    expect(decl(".cc-col dd > span.cc-none", "color")).toBe("var(--muted)");
    expect(board["board.clear.nothing"]).toBe("Nothing on this deck.");
  });
  it("keeps Cancel first and the danger button, and the warning line", () => {
    expect(dialog.indexOf("board.clear.cancel\"")).toBeLessThan(dialog.indexOf("btn danger"));
    expect(dialog).toContain("{final && <p className=\"cc-final\">{final}</p>}");
  });
});

describe("Keyboard shortcuts", () => {
  const sheet = src("../components/KeyboardHelp.tsx");
  it("is the 820 dialog with 24px of body and two columns 48 apart", () => {
    expect(decl(".modal.key-help", "width")).toBe("var(--dialog-m)");
    expect(decl(".key-help > .modal-body", "padding")).toBe("24px");
    expect(decl(".kh-cols", "grid-template-columns")).toBe("repeat(2, minmax(0, 1fr))");
    expect(decl(".kh-cols", "column-gap")).toBe("40px");
  });
  it("has V4's five groups in order, with Terminal only where the Command Panel is on", () => {
    expect(KEY_HELP.map(g => g.title)).toEqual(["Deck", "The question", "Canvas", "Panels"]);
    expect(keyHelpFor(true, () => true, true).map(g => g.title)).toEqual(["Deck", "The question", "Terminal", "Canvas", "Panels"]);
    expect(KEY_HELP.find(g => g.title === "The question")!.rows.map(r => r.cap)).toEqual(["W", "N", "Shift + N"]);
    expect(KEY_HELP.find(g => g.title === "Panels")!.rows.map(r => r.cap)).toEqual(["Ctrl + K", "U", "L", "D", "H", "A", "S", "B", "I"]);
  });
  it("keeps every shortcut the deck listed before: keys, chords, mouse and the Command Panel's", () => {
    const caps = keyHelpFor(true, () => true, true).flatMap(g => g.rows.map(r => r.cap));
    for (const cap of ["Space", "J", "K", "W", "N", "Shift + N", "P", "F", "Z", "Delete", "R", "Ctrl + Z", "C",
      "Ctrl + K", "U", "L", "D", "H", "A", "S", "B", "I", "?", "Ctrl + ,", "V", "M", "T",
      "Tab", "Enter", "Shift + Enter", "Esc", "drag", "shift-click", "click", "double-click", "hover", WORKSPACE_KEY_ROW.cap]) {
      expect(caps, cap).toContain(cap);
    }
    expect(caps).toHaveLength(37);
  });
  it("splits the groups into V4's left (Deck, The question) and right columns", () => {
    const cols = splitColumns(keyHelpFor(true, () => true, true));
    expect(cols[0].map(g => g.id)).toEqual(["deck", "question"]);
    expect(cols[1].map(g => g.id)).toEqual(["terminal", "canvas", "panels"]);
  });
  it("draws one chip per key: Ctrl and K on Linux and Windows, ⌘ and K on a Mac", () => {
    expect(capChips("Ctrl + K")).toEqual(["Ctrl", "K"]);
    expect(capChips("⌘ K")).toEqual(["⌘", "K"]);
    expect(capChips("double-click")).toEqual(["double-click"]);
    expect(sheet).toContain("apple && row.macCap ? row.macCap : row.cap");
  });
  it("sets rows 24 high with the action 13/20 --text-secondary and the keys right-aligned", () => {
    expect(decl(".key-help .sc", "justify-content")).toBe("space-between");
    expect(decl(".key-help .sc", "padding")).toBe("2px 0");
    expect(decl(".kh-action", "color")).toBe("var(--text-secondary)");
    expect(decl(".kh-action", "line-height")).toBe("var(--lh-body)");
    expect(decl(".kh-keys", "justify-content")).toBe("flex-end");
    expect(decl(".kh-keys", "gap")).toBe("4px");
    expect(decl(".kh-group", "color")).toBe("var(--text-secondary)");
    expect(decl(".kh-group", "padding-bottom")).toBe("6px");
    expect(decl(".kh-block + .kh-block", "padding-top")).toBe("16px");
  });
  it("sets the chip at natural width: 1px 5px, a --line edge r4 on --bg-soft, mono 11/14 500 --muted", () => {
    expect(decl(".key-help kbd", "padding")).toBe("1px 5px");
    expect(decl(".key-help kbd", "border")).toBe("1px solid var(--line)");
    expect(decl(".key-help kbd", "border-radius")).toBe("var(--r-tag)");
    expect(decl(".key-help kbd", "background")).toBe("var(--bg-soft)");
    expect(decl(".key-help kbd", "color")).toBe("var(--muted)");
    expect(decl(".key-help kbd", "font-weight")).toBe("500");
    expect(decl(".key-help kbd", "font-family")).toBe("var(--font-mono)");
  });
  it("keeps the intro line and Take the tour (an accent 12/16 link in the footer), and the note", () => {
    expect(sheet).toContain("<p className=\"kh-intro\">{t(\"settings.key.tourText\")}</p>");
    expect(sheet).toContain("className=\"kh-tour\" onClick={onTour}");
    expect(decl(".kh-tour", "color")).toBe("var(--accent)");
    expect(decl(".kh-tour", "font-weight")).toBe("500");
    expect(decl(".kh-foot", "color")).toBe("var(--muted)");
    expect(sheet).toContain("settings.key.switchNote");
  });
});

describe("Tour", () => {
  const guide = src("../components/GuideModal.tsx");
  it("is the 560 dialog with the title and the step counter in the header, left of the ×", () => {
    expect(decl(".modal.guide", "width")).toBe("var(--dialog-s)");
    const head = guide.slice(guide.indexOf("<header"), guide.indexOf("</header>"));
    expect(head.indexOf("guide-count")).toBeLessThan(head.indexOf("<DialogClose"));
    expect(decl(".guide-count", "font-family")).toBe("var(--font-mono)");
    expect(decl(".guide-count", "color")).toBe("var(--muted)");
  });
  it("draws the picture box 182 high on --sunken, a --line-soft edge, r8, 16 inside", () => {
    expect(decl(".guide-stage", "height")).toBe("182px");
    expect(decl(".guide-stage", "background")).toBe("var(--sunken)");
    expect(decl(".guide-stage", "border")).toBe("1px solid var(--line-soft)");
    expect(decl(".guide-stage", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".guide-stage", "padding")).toBe("16px");
  });
  it("sets the tip 14/20 500 --text over a 13/20 --muted second line", () => {
    expect(decl(".guide-line", "font-weight")).toBe("500");
    expect(decl(".guide-line", "line-height")).toBe("var(--lh-card-title)");
    expect(decl(".guide-line", "color")).toBe("var(--text)");
    expect(decl(".guide-tip", "color")).toBe("var(--muted)");
    expect(decl(".guide-tip", "line-height")).toBe("var(--lh-body)");
  });
  it("has one 6px dot per step on a 12px pitch: --accent for the current step, --muted-dim for the rest", () => {
    expect(guide).toContain("steps.map((_, i) => (");
    expect(decl(".guide-dot", "width")).toBe("12px");
    const dot = css.match(/\.guide-dot::before\s*\{([^}]*)\}/)![1];
    expect(dot).toMatch(/width:\s*6px/);
    expect(dot).toMatch(/background:\s*var\(--muted-dim\)/);
    expect(decl(".guide-dot[aria-current=\"step\"]::before", "background")).toBe("var(--accent)");
  });
  it("has a Skip that ends the tour the way finishing or Esc does: through onClose", () => {
    expect(guide).toContain("className=\"btn guide-skip\" onClick={onClose}");
    expect(shell["shell.skip"]).toBe("Skip");
    // Finishing without a `finish` action is onClose, and Esc is the dismiss queue's onClose.
    expect(guide).toContain("if (finish) finish.act(); else onClose();");
    expect(guide).toContain("useModalDismiss(onClose,");
    // One flag: the welcome hook stores tourSeen when the tour closes, whichever way.
    expect(src("../components/DeckDialogs.tsx")).toContain("onClose={closeTour}");
  });
});

describe("What's new", () => {
  const notes = src("../components/ReleaseNotesModal.tsx");
  it("shows the version as a bordered pill without the v", () => {
    expect(notes).toContain("isVersion(running) ? running :");
    expect(decl(".release-notes .rn-pill", "border")).toBe("1px solid var(--line)");
    expect(decl(".release-notes .rn-pill", "border-radius")).toBe("10px");
    expect(decl(".release-notes .rn-pill", "padding")).toBe("1px 6px");
    expect(decl(".release-notes .rn-pill", "color")).toBe("var(--text-secondary)");
  });
  it("has the plain 1px --line-soft footer rule, no fill, Take the tour as a bordered button, Done on the right", () => {
    expect(decl(".release-notes .rn-footer", "border-top")).toBe("1px solid var(--line-soft)");
    expect(decl(".release-notes .rn-footer", "background")).toBe("none");
    expect(notes).toContain("className=\"btn rn-tour\"");
    expect(notes).toContain("onClick={onClose}>{t(\"shell.done\")}");
  });
  it("shows Release history as an accent link with its arrow, in the body inset by 16", () => {
    expect(notes).toMatch(/<p className="rn-history-link">\s*<a href="https:\/\/ccdeck\.dev\/changelog\/"/);
    expect(notes).toContain("<ExternalLinkGlyph />");
    expect(decl(".release-notes .rn-history-link a", "color")).toBe("var(--accent)");
    expect(decl(".release-notes > .modal-body", "padding")).toBe("16px");
  });
});

describe("Core history and Busiest processes", () => {
  it("Core history is 560 wide and Busiest processes keeps 1120, both with the title in the shared 14/600 style and a Done footer", () => {
    expect(decl(".hist-modal", "width")).toBe("var(--dialog-s)");
    // Busiest processes stays the deck's 1120 with all seven columns: at 560 the
    // process name would get about 104px of the 690 it has now. V4's three-column
    // table is skipped (the deck also shows Threads, Up, User and PID).
    expect(decl(".pl-modal", "width")).toBe("var(--dialog-l)");
    expect(css).toMatch(/\.modal-head > span\.modal-title,/);
    expect(src("../components/SectionHistoryModal.tsx")).toContain("onClick={onClose}>{t(\"shell.done\")}");
    expect(src("../components/ProcessListModal.tsx")).toContain("onClick={onClose}>{t(\"shell.done\")}");
  });
  it("sets the busiest table's headers in sentence case at 11/14 500, with 12px figures in mono --text-secondary", () => {
    expect([insights["insights.proc.process"], insights["insights.proc.cpu"], insights["insights.proc.memory"]]).toEqual(["Process", "CPU", "Memory"]);
    expect(decl(".pl-body .pl-table .sd-sort", "font-weight")).toBe("500");
    expect(decl(".pl-body .pl-table .sd-sort", "line-height")).toBe("14px");
    expect(decl(".pl-body .pl-table td.sd-num", "color")).toBe("var(--text-secondary)");
    expect(decl(".pl-body .pl-table td.sd-num", "font-family")).toBe("var(--font-mono)");
    expect(decl(".pl-body .pl-table thead th", "height")).toBe("24px");
    expect(decl(".pl-body .pl-table tbody td", "height")).toBe("28px");
  });
  it("keeps every column and the sort on each, and the hint beside the title", () => {
    const list = src("../components/ProcessListModal.tsx");
    for (const col of ["cpu", "rss", "threads", "uptime", "user", "name"]) expect(list).toContain(`col="${col}"`);
    expect(list).toContain("insights.machine.processesSub");
    expect(decl(".pl-hint", "font-family")).toBe("var(--font-mono)");
  });
});

describe("Quota history, Browser watch and Radio", () => {
  it("Quota history is 560, with the Claude | Codex switch in the header and a Done footer", () => {
    const quota = src("../components/QuotaHistoryModal.tsx");
    expect(decl(".modal.qh-modal", "width")).toBe("var(--dialog-s)");
    const head = quota.slice(quota.indexOf("<header"), quota.indexOf("</header>"));
    expect(head).toContain("qh-providers");
    expect(quota).toContain("onClick={onClose}>{t(\"shell.done\")}");
    expect(decl(".qh-providers", "background")).toBe("var(--bg-soft)");
    expect(decl(".qh-providers", "border")).toBe("1px solid var(--line-soft)");
    expect(decl(".qh-providers", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".qh-provider[aria-pressed=\"true\"]", "background")).toBe("var(--panel)");
    expect(decl(".qh-provider", "color")).toBe("var(--muted)");
    expect(decl(".qh-summary strong", "font-family")).toBe("var(--font-mono)");
    expect(decl(".qh-chart-wrap", "background")).toBe("var(--sunken)");
  });
  it("Browser watch is the 1120 dialog with the mono 11 --muted caption", () => {
    expect(decl(".bw-modal", "width")).toBe("var(--dialog-l)");
    expect(decl(".modal-tool-id", "font-family")).toBe("var(--font-mono)");
    expect(decl(".modal-tool-id", "color")).toBe("var(--muted)");
  });
  it("Radio takes the overlay radius and shadow, and its caption Explorer is mono 11 --muted", () => {
    const radio = css.match(/\.radio-panel, \.radio-loading\s*\{([^}]*)\}/)![1];
    expect(radio).toMatch(/border-radius:\s*var\(--r-overlay\)/);
    expect(radio).toMatch(/box-shadow:\s*var\(--shadow-overlay\)/);
    expect(decl(".radio-header h2 span", "font-family")).toBe("var(--font-mono)");
    expect(decl(".radio-header h2 span", "color")).toBe("var(--muted)");
    expect(src("../i18n/areas/radio/en.ts")).toContain("\"radio.title\": \"Radio\"");
    expect(src("../i18n/areas/radio/en.ts")).toContain("\"radio.title.explorer\": \"Explorer\"");
  });
});

describe("Explore integrations", () => {
  const explore = src("../components/ExploreIntegrationsModal.tsx");
  it("draws 58-high rows r10 with a 1px --line-soft stroke and no icon", () => {
    expect(decl(".explore-provider", "min-height")).toBe("58px");
    expect(decl(".explore-provider", "border")).toBe("1px solid var(--line-soft)");
    expect(decl(".explore-provider", "border-radius")).toBe("var(--r-node)");
    expect(explore).not.toContain("explore-glyph");
  });
  it("makes Open the primary button and Connect the quiet one, keeping what each does", () => {
    expect(explore).toContain("className=\"btn primary\" aria-label={t(\"integrations.explore.openAria\"");
    expect(explore).toContain("className=\"btn\" aria-label={t(\"integrations.form.connect\"");
    expect(explore).toContain("go(() => onOpen(def.kind))");
    expect(explore).toContain("go(() => onConnect(def.kind))");
    expect(explore).toContain("go(() => onManage(first?.id))");
  });
  it("writes Connected / Not connected as plain 12px --muted text and the tag beside the name", () => {
    expect(decl(".explore-connection, .explore-unavailable", "color")).toBe("var(--muted)");
    expect(decl(".explore-connection, .explore-unavailable", "font-size")).toBe("calc(12px + var(--ui-text-increase, 0px))");
    expect(css).not.toContain(".explore-connection[data-connected]");
    expect(integrations["integrations.explore.connected"]).toBe("Connected");
    expect(integrations["integrations.explore.notConnected"]).toBe("Not connected");
    expect(decl(".explore-tag", "color")).toBe("var(--muted)");
  });
  it("puts the footnote in the body and Manage in Settings (quiet, left) with Done (primary, right) in the footer", () => {
    expect(integrations["integrations.explore.footer"]).toBe("You choose what each token may do. Tokens stay on this machine.");
    const body = explore.slice(explore.indexOf("explore-body"), explore.indexOf("explore-footer"));
    expect(body).toContain("explore-footnote");
    const foot = explore.slice(explore.indexOf("<div className=\"explore-footer\">"));
    expect(foot.indexOf("manageInSettings")).toBeLessThan(foot.indexOf("btn primary"));
    expect(foot).toContain("onClick={onClose}>{t(\"shell.done\")}");
    expect(decl(".explore-footer", "border-top")).toBe("1px solid var(--line-soft)");
  });
});

describe("The dialog that did not load", () => {
  const lazy = src("../components/LazyDialog.tsx");
  it("is 420 wide with the note 13/20 --text-secondary and the buttons on the footer", () => {
    expect(decl(".modal.dialog-missing", "width")).toBe("min(420px, calc(100vw - 32px))");
    expect(decl(".dm-note", "color")).toBe("var(--text-secondary)");
    expect(decl(".dm-note", "line-height")).toBe("var(--lh-body)");
    const foot = lazy.slice(lazy.indexOf("<footer"));
    expect(foot).toContain("shell.close");
    expect(foot).toContain("shell.reload");
    expect(foot.indexOf("shell.close")).toBeLessThan(foot.indexOf("shell.reload"));
  });
});

describe("The crash pane", () => {
  const boundary = src("../components/ErrorBoundary.tsx");
  it("is the bare empty state: no card fill, edge or shadow, a 24px icon, 14/20 title, 13/20 --muted body", () => {
    const card = css.match(/\.error-fallback-card\s*\{([^}]*)\}/)![1];
    expect(card).not.toMatch(/(^|[;\s])(background|border|border-radius|box-shadow)\s*:/);
    expect(card).toMatch(/width:\s*min\(360px, 100%\)/);
    expect(card).toMatch(/gap:\s*4px/);
    expect(decl(".error-fallback-icon", "width")).toBe("24px");
    expect(decl(".error-fallback-title", "line-height")).toBe("var(--lh-card-title)");
    expect(decl(".error-fallback-title", "color")).toBe("var(--text)");
    expect(decl(".error-fallback-note", "color")).toBe("var(--muted)");
    expect(decl(".error-fallback-note", "line-height")).toBe("var(--lh-body)");
  });
  it("keeps Reload as the primary action and Send report as a second quiet one", () => {
    expect(boundary).toMatch(/className="btn primary" onClick=\{\(\) => window\.location\.reload\(\)\}/);
    expect(boundary).toMatch(/className="btn"\s+onClick=\{\(\) => this\.setState\(\{ reportOpen: true \}\)\}/);
    expect(boundary).toContain("shell.error.report");
  });
  it("writes its note as two sentences", () => {
    expect(shell["shell.error.note"]).toBe("The deck hit an error it could not draw past. Reloading usually clears it. If it keeps happening, a report tells the people who make ccdeck what broke.");
  });
});

describe("Touch, density and forced colours", () => {
  const touch = src("../styles/touch-and-forced-colours.css");
  const coarse = touch.slice(touch.indexOf("@media (pointer: coarse) {"), touch.indexOf("@media (forced-colors: active) {"));
  it("gives the link-shaped buttons and the provider segments a floor of the control height", () => {
    expect(decl(".kh-tour", "min-height")).toBe("var(--ctl-h)");
    expect(decl(".release-notes .rn-history-link a", "min-height")).toBe("var(--ctl-h)");
    expect(decl(".qh-provider", "min-height")).toBe("28px");
  });
  it("gives the tour's dots a 24px target around the 6px dot", () => {
    expect(decl(".guide-dot::after", "inset")).toBe("-6px 0");
  });
  it("takes all of them to 32px under a coarse pointer, and What's new's links to 44", () => {
    expect(coarse).toMatch(/\.kh-tour,\s*\.release-notes \.rn-history-link a,\s*\.qh-provider,\s*\.guide-dot \{ min-height: 32px; \}/);
    expect(css).toMatch(/\.rn-history-link a, \.release-notes \.rn-footer > \.primary \{ min-height: 44px; \}/);
  });
  it("redraws the chosen provider segment in the system colours inside the one forced-colours block", () => {
    expect(touch.match(/@media \(forced-colors: active\)/g)).toHaveLength(1);
    expect(touch).toMatch(/\.aa-tab\.on,\s*\.qh-provider\[aria-pressed="true"\] \{ forced-color-adjust: none;/);
  });
  it("keeps What's new's footer 48 on a phone: no vertical padding", () => {
    expect(css).toContain(".release-notes .rn-footer { padding: 0 16px; }");
    expect(css).toContain(".release-notes .rn-footer { padding: 0 12px; gap: 8px; }");
  });
  it("lifts the busiest table's figures on a row hover, under the mouse query", () => {
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.pl-body tbody tr:hover td \{[^}]*\}\s*\}\s*(?:\/\*[\s\S]*?\*\/\s*)?\.pl-body tbody tr:hover td\.sd-num|\.pl-body tbody tr:hover td\.sd-num \{ color: var\(--text\); \}/);
  });
  it("leaves no dead rules for the retired shortcut grid, tour door or What's new text button", () => {
    expect(css).not.toContain(".shortcuts");
    expect(css).not.toContain(".guide-door");
    expect(css).not.toContain(".rn-text-button");
  });
  it("shows the pill's fallback version without a v, and puts a hidden plus between chord chips", () => {
    expect(src("../components/ReleaseNotesModal.tsx")).toContain("entries[0]?.version");
    expect(src("../components/KeyboardHelp.tsx")).toContain("<span className=\"kh-plus\">+</span>");
  });
});
