// V4's Settings, section by section: the Select every choice uses, the nav item
// and its pitch, the page head, the group labels each page carries and in what
// order, and that no setting the deck had went missing on the way.
//
// Looks are read from the sheet; the pages are drawn with renderToStaticMarkup
// (no DOM in this suite) and their group labels and setting ids read off the
// markup. The setting ids are the ones a search result lands on, so a setting
// that stops being drawn also stops being found; the lists below are the ones
// the pages drew before V4's rows, and a page may draw more, never fewer.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsModal, { type SettingsModalProps } from "../components/SettingsModal";
import SelectShell from "../components/SelectShell";
import type { SettingsSection } from "../settings";
import { DEFAULT_PREFS } from "../sound";
import { ACCOUNT_NOTIFY_DEFAULTS } from "../use-os-notifications";
import { SETTINGS_INDEX, isSectionEntry } from "../settings-search";
import { setSettingsFailure } from "../settings-failure";
import { sheetText } from "./sheet-source";
import { deckOffersEveryKind } from "./integrations-offered";

await deckOffersEveryKind();

// ── the sheet ───────────────────────────────────────────────────────────────

interface Rule { media: string; selectors: string[]; decls: Record<string, string> }
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
function parse(text: string): Rule[] {
  const rules: Rule[] = [];
  const block = (from: number): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces");
  };
  const walk = (start: number, end: number, media: string) => {
    let i = start;
    while (i < end) {
      const open = text.indexOf("{", i);
      if (open < 0 || open >= end) return;
      const prelude = text.slice(i, open).trim().replace(/\s+/g, " ");
      const close = block(open);
      if (prelude.startsWith("@keyframes")) { /* not read here */ }
      else if (prelude.startsWith("@")) walk(open + 1, close, prelude.startsWith("@media") ? (media ? `${media} and ${prelude.slice(6).trim()}` : prelude.slice(6).trim()) : media);
      else {
        const decls: Record<string, string> = {};
        for (const m of text.slice(open + 1, close).matchAll(/([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) decls[m[1]] = m[2].replace(/\s+/g, " ");
        rules.push({ media, selectors: prelude.split(/,(?![^()]*\))/).map(s => s.trim().replace(/\s+/g, " ")), decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, "");
  return rules;
}
const rules = parse(css);
function decl(selector: string, prop: string, media = ""): string | undefined {
  let value: string | undefined;
  for (const r of rules) if (r.media === media && r.selectors.includes(selector) && prop in r.decls) value = r.decls[prop];
  return value;
}
const INC = (px: number) => `calc(${px}px + var(--ui-text-increase, 0px))`;
const POINTER = "(hover: hover) and (pointer: fine)";

describe("the Select", () => {
  const select = ".v4-select > .sm-select";
  it("is a control tall (28 at Compact, as V4 draws it), radius 6, on --bg-soft, with the platform's arrow gone and room for the chevron", () => {
    expect(decl(select, "min-height")).toBe("var(--ctl-h)");
    expect(decl(':root[data-density="compact"]', "--ctl-h")).toBe("28px");
    // Under a coarse pointer the Select and the nav item take the 32 floor the other controls take.
    for (const sel of [select, ".settings-tab"]) expect(decl(sel, "min-height", "(pointer: coarse)"), sel).toBe("32px");
    expect(decl(select, "appearance")).toBe("none");
    // 12 of padding before the name; 8 + 12 + 8 after it.
    expect(decl(select, "padding")).toBe("0 calc(8px + 12px + 8px) 0 12px");
    expect(decl(".sm-select", "background")).toBe("var(--bg-soft)");
    expect(decl(".sm-select", "border-radius")).toBe("var(--r-ctl)");
    expect(decl(".sm-select", "font-size")).toBe(INC(13));
  });
  it("is as wide as its longest option needs above a floor, never a fixed width", () => {
    for (const sel of [select, ".v4-select", ".settings-row-control > .v4-select"]) expect(decl(sel, "width"), sel).toBeUndefined();
    // CHANGED ON PURPOSE (review): a floor of 90 (V4's narrowest Select) so a list that fills in
    // late does not make its row reflow; this test first forbade any min-width.
    expect(decl(select, "min-width")).toBe("90px");
    expect(decl(".v4-select", "display")).toBe("inline-flex");
  });
  it("draws a 12px chevron in --muted, 8px from the edge, that never takes the pointer", () => {
    expect(decl(".v4-select", "color")).toBe("var(--muted)");
    expect(decl(".v4-select-chevron", "right")).toBe("8px");
    expect(decl(".v4-select-chevron", "pointer-events")).toBe("none");
    const html = renderToStaticMarkup(createElement(SelectShell, null, createElement("select", { className: "sm-select" }, createElement("option", null, "One"))));
    expect(html).toMatch(/^<span class="v4-select"><select class="sm-select"><option>One<\/option><\/select><svg class="v4-select-chevron" width="12" height="12"/);
  });
  it("keeps the native list underneath, so the keys and the touch picker are the platform's", () => {
    expect(readFileSync(new URL("../components/SelectShell.tsx", import.meta.url), "utf8")).not.toMatch(/role="listbox"|onKeyDown/);
  });
  it("is the one control behind every select in Settings", () => {
    const files = ["LanguageSection", "SessionsSection", "ToneSection", "SpokenVoiceForm", "ToolAuditSettings", "ClaudeCodeSettings", "ReadingSection"];
    const wanted = { LanguageSection: 1, SessionsSection: 1, ToneSection: 1, SpokenVoiceForm: 1, ToolAuditSettings: 1, ClaudeCodeSettings: 1, ReadingSection: 2 } as Record<string, number>;
    let total = 0;
    for (const file of files) {
      const source = readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8");
      const selects = source.match(/<select\b/g)?.length ?? 0;
      expect(selects, file).toBe(wanted[file]);
      expect(source.match(/<SelectShell>\s*<select\b/g)?.length ?? 0, `${file} wraps each one`).toBe(selects);
      total += selects;
    }
    // Six places in General, Sounds, Data and Claude Code (nine selects once the
    // two tones and Claude Code's three choices are drawn), and Text & density's two.
    expect(total).toBe(8);
  });
});

describe("the nav", () => {
  it("is 176 wide items, 28 high at a 30 pitch, with no group label between them", () => {
    expect(decl(".settings-tab", "min-height")).toBe("var(--ctl-h)");
    expect(decl(".settings-nav", "gap")).toBe("2px");
    // 200 less the 1px divider = 199; 8 and 15 of padding leave 176.
    expect(decl(".settings-body", "grid-template-columns")).toBe("200px minmax(0, 1fr)");
    expect(decl(".settings-nav", "padding")).toBe("8px calc(16px - 1px) 8px 8px");
    expect(decl(".settings-search", "padding")).toBe("8px calc(16px - 1px) 4px 8px");
    expect(decl(".settings-search .settings-search-field", "min-height")).toBe("30px");
    expect(decl(".settings-side", "border-right")).toBe("1px solid var(--line-soft)");
  });
  it("lists the tabs in V4's order, with Experimental not among them", () => {
    const html = draw("general");
    const tabs = [...html.matchAll(/role="tab" id="settings-tab-([a-z]+)"/g)].map(m => m[1]);
    expect(tabs).toEqual(["general", "appearance", "reading", "keyboard", "notifications", "sounds", "integrations", "data", "claude", "radar", "about"]);
  });
});

describe("the page head", () => {
  it("is 40 high on every page, a 14/20 title over a 12/16 line, 4 apart", () => {
    expect(decl(".settings-pane-head", "min-height")).toBe("40px");
    expect(decl(".settings-pane-heading", "gap")).toBe("4px");
    expect(decl(".settings-pane-title", "line-height")).toBe(INC(20));
    expect(decl(".settings-pane-note", "line-height")).toBe(INC(16));
    // No 60-character measure: a line of V4's wording is one line at 555 wide.
    expect(decl(".settings-pane-note", "max-width")).toBeUndefined();
  });
});

// ── the pages ───────────────────────────────────────────────────────────────

const noop = () => {};
const asyncNoop = async () => {};
function props(section: SettingsSection, over: Partial<SettingsModalProps> = {}): SettingsModalProps {
  return {
    section,
    onSection: noop,
    onClose: noop,
    providers: { kind: "reported", claude: true, codex: true },
    sound: { soundOn: true, toggleSound: noop, activateSoundRef: { current: noop }, soundOnRef: { current: true } },
    tones: { tonePrefs: DEFAULT_PREFS, setTonePrefs: noop, tonePrefsRef: { current: DEFAULT_PREFS }, previewTone: noop, changeTone: noop },
    customTones: {
      customSelections: { done: null, "needs-input": null }, customSelectionsRef: { current: { done: null, "needs-input": null } },
      customAssets: [], clearCustomOnly: noop, fallbackCustomRef: { current: null }, selectCustomTone: noop,
      importNotificationAudio: asyncNoop, createNotificationVoice: asyncNoop, renameCustomAsset: asyncNoop,
      deleteCustomAsset: asyncNoop, previewCustomAsset: noop,
    },
    notify: {
      notifyPermission: "default", notifySaid: new Set(), notifyOn: false, notifyVetoed: false, toggleNotify: noop,
      notifySupported: true, askForNotifications: noop, loadNotifyPrefs: noop, accountNotify: ACCOUNT_NOTIFY_DEFAULTS,
      toggleAccountNotify: noop,
    },
    appearance: { theme: "dark", setTheme: noop, characterEnabled: true, setCharacterEnabled: noop },
    versionCheck: { version: null, notice: null, noticeOpen: false, showNotice: noop, dismissNotice: noop, versionChecking: false, loadVersion: async () => null },
    desktopUpdate: { desktopUpdateRestarting: false, desktopUpdateFailure: null, readyAppUpdate: null, appUpdate: null, askDesktopUpdateRestart: asyncNoop, onDesktopUpdateEvent: noop },
    restart: { autoRestart: true, toggleAutoRestart: noop },
    doors: { whatsNew: noop, update: noop, tour: noop, feedback: noop, accounts: noop, localNetwork: noop, browserWatch: noop, radar: noop },
    terminal: { on: false, supported: true, toggle: noop },
    ...over,
  } as unknown as SettingsModalProps;
}
const draw = (section: SettingsSection, over: Partial<SettingsModalProps> = {}) => renderToStaticMarkup(createElement(SettingsModal, props(section, over)));
const pane = (html: string) => html.slice(html.indexOf('id="settings-pane"'));
const groups = (html: string) => [...pane(html).matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map(m => m[1]);
const settings = (html: string) => new Set([...pane(html).matchAll(/data-setting="([^"]+)"/g)].map(m => m[1]));

describe("each page's groups, in order", () => {
  it("General: Language, then the rest of the deck's behaviour, then Elsewhere on the deck and Experimental", () => {
    const labels = groups(draw("general"));
    expect(labels[0]).toBe("Language");
    expect(labels.slice(-2)).toEqual(["Elsewhere on the deck", "Experimental"]);
    // CHANGED ON PURPOSE (V4's General page): one Sessions group where Board
    // and a group per provider were.
    expect(labels).toEqual(["Language", "Sessions", "Updates", "Elsewhere on the deck", "Experimental"]);
  });
  it("General's Sessions group: V4's four rows in V4's order, Claude before Codex, and none lost", () => {
    const html = draw("general");
    const group = html.slice(html.indexOf('aria-labelledby="settings-sessions-caption"'), html.indexOf('aria-labelledby="settings-updates-caption"'));
    const rows = [...group.matchAll(/data-setting="([^"]+)"/g)].map(m => m[1]);
    expect(rows).toEqual(["hide-finished", "claude-session-recovery", "codex-session-recovery", "claude-continue-stopped"]);
    const names = [...group.matchAll(/<span class="settings-row-name"[^>]*>([^<]*)</g)].map(m => m[1]);
    expect(names).toEqual(["Hide finished sessions after", "Bring back busy Claude sessions", "Bring back unfinished Codex turns", "Continue stopped background sessions"]);
    // Where Claude Code is not, its two rows go and Codex's stays.
    const codexOnly = draw("general", { providers: { kind: "reported", claude: false, codex: true } } as Partial<SettingsModalProps>);
    const left = codexOnly.slice(codexOnly.indexOf('aria-labelledby="settings-sessions-caption"'), codexOnly.indexOf('aria-labelledby="settings-updates-caption"'));
    expect([...left.matchAll(/data-setting="([^"]+)"/g)].map(m => m[1])).toEqual(["hide-finished", "codex-session-recovery"]);
  });
  it("draws a refused write's line right under the page head, on any page, and nothing while there is none", () => {
    expect(draw("general")).not.toContain("settings-failure");
    setSettingsFailure({ text: "Could not save that setting. Try again.", giveBack: false, done: false });
    try {
      for (const section of ["general", "notifications", "claude"] as SettingsSection[]) {
        const html = pane(draw(section));
        const head = html.indexOf('<div class="settings-pane-head">');
        const line = html.indexOf('<div class="settings-failure" role="alert">');
        expect(line, section).toBeGreaterThan(head);
        // Next to the head, before the page's first group.
        expect(html.slice(head, line).match(/<\/div><\/div>$/), section).not.toBeNull();
        expect(html.indexOf('class="settings-group', line), section).toBeGreaterThan(line);
      }
    } finally { setSettingsFailure(null); }
  });
  it("General draws no Experimental group while the deck does not hand over the Command Panel's switch", () => {
    expect(groups(draw("general", { terminal: undefined }))).not.toContain("Experimental");
  });
  it("Appearance: Theme, Character", () => expect(groups(draw("appearance"))).toEqual(["Theme", "Character"]));
  it("Text & density: Text size, Density, Preview", () => expect(groups(draw("reading"))).toEqual(["Text size", "Density", "Preview"]));
  it("Keyboard: Shortcuts first", () => expect(groups(draw("keyboard"))[0]).toBe("Shortcuts"));
  it("Notifications: Sessions, Accounts", () => expect(groups(draw("notifications"))).toEqual(["Sessions", "Accounts"]));
  it("Sounds: Sound, a group for each tone, Your own", () => {
    const labels = groups(draw("sounds"));
    expect(labels[0]).toBe("Sound");
    expect(labels.at(-1)).toBe("Your own");
    expect(labels).toHaveLength(4);
  });
  it("Radar: Radar", () => expect(groups(draw("radar"))).toEqual(["Radar"]));
  it("About: Version, Tour and feedback, Project", () => expect(groups(draw("about"))).toEqual(["Version", "Tour and feedback", "Project"]));
  it("Integrations: its providers are rows of Connected and Not connected, not a heading each", () => {
    const html = pane(draw("integrations"));
    const captions = [...html.matchAll(/<h3 id="ig-group-[a-z-]+">([^<]*)<\/h3>/g)].map(m => m[1]);
    expect(captions).toEqual(["Not connected"]);
    // The three providers are rows under it, each a name with no icon beside it.
    expect([...html.matchAll(/<section[^>]*id="ig-provider-([a-z]+)"/g)].map(m => m[1]).sort()).toEqual(["github", "gitlab", "jira"]);
    expect(html).not.toContain("ig-provider-glyph");
  });
});

describe("no setting the pages drew before went missing", () => {
  // The expected ids come from the search index, which lists every place a result
  // lands, so they are not typed from the markup they are checked against.
  const SECTIONS: SettingsSection[] = ["general", "appearance", "reading", "keyboard", "notifications", "sounds", "integrations", "data", "claude", "radar", "about"];
  const expected = (section: SettingsSection) => SETTINGS_INDEX.filter(e => e.section === section && !isSectionEntry(e)).map(e => e.id);
  // Tool history draws its rows once the deck has answered how much it keeps, which a
  // static render cannot wait for: its ids are held to the component that draws them.
  const toolHistory = readFileSync(new URL("../components/ToolAuditSettings.tsx", import.meta.url), "utf8");
  // CHANGED ON PURPOSE (V4's engine install rows): the terminal engine's row in
  // General draws once the deck has said whether this machine can take an
  // engine at all, for the same reason — so it is held to the component too.
  const terminalSection = readFileSync(new URL("../components/TerminalSection.tsx", import.meta.url), "utf8");
  const waitsForTheDeck = new Set(["terminal-engine", "terminal-engine-remove"]);
  it.each(SECTIONS)("%s still draws every place the search can land on", section => {
    const ids = expected(section);
    expect(ids.length, section).toBeGreaterThan(0);
    const drawn = settings(draw(section));
    for (const id of ids) {
      if (section === "data") expect(toolHistory, id).toContain(`settingId="${id}"`);
      else if (waitsForTheDeck.has(id)) expect(terminalSection, id).toContain(`settingId="${id}"`);
      else expect(drawn, `${section}: ${id}`).toContain(id);
    }
  });
  it("counts what the index promises for the pages whose rows do not wait for the deck", () => {
    expect(Object.fromEntries(SECTIONS.map(section => [section, expected(section).length])))
      .toMatchObject({ reading: 2, keyboard: 1, notifications: 5, radar: 1, about: 6, appearance: 15 });
  });
  it("keeps the Details disclosures the rows had", () => {
    const details = (section: SettingsSection) => pane(draw(section)).match(/<details class="settings-row-details"/g)?.length ?? 0;
    expect({ general: details("general"), sounds: details("sounds") }).toEqual({ general: 5, sounds: 0 });
  });
});

describe("the cards, the key rows and the notes", () => {
  it("draws theme cards 128 wide with a 62 high preview, four to a row at a 13 gap", () => {
    expect(decl(".appearance-themes", "grid-template-columns")).toBe("repeat(auto-fill, 128px)");
    expect(decl(".appearance-themes", "gap")).toBe("13px");
    expect(decl(".appearance-preview", "height")).toBe("62px");
    expect(decl(".appearance-preview", "border-radius")).toBe("var(--r-panel)");
    expect(decl(".appearance-theme", "padding")).toBe("0");
  });
  it("draws the companions as the same kind of tile: 128 wide, an 80 high preview on --bg", () => {
    expect(decl(".character-choice", "width")).toBe("128px");
    expect(decl(".character-preview", "height")).toBe("80px");
    expect(decl(".character-preview", "background")).toBe("var(--bg)");
    expect(decl(".character-picker", "gap")).toBe("13px");
  });
  it("draws a key row 28 high and its cap 16 high in the data face", () => {
    expect(decl(".settings-keys .settings-row", "min-height")).toBe("28px");
    expect(decl(".settings-key", "font-size")).toBe("calc(11px + max(-1px, var(--ui-text-increase, 0px)))");
    expect(decl(".settings-key", "line-height")).toBe(INC(14));
    expect(decl(".settings-key", "border-radius")).toBe("var(--r-tag)");
    expect(decl(".settings-key", "padding")).toBe("0 5px");
  });
  it("draws an integration row 48 high, and a note on the control wash", () => {
    expect(decl(".ig-provider", "min-height")).toBe("48px");
    expect(decl(".ig-provider-state", "color")).toBe("var(--muted)");
    expect(decl(".settings-note", "background")).toBe("var(--ctl-fill)");
    expect(decl(".settings-note", "border-radius")).toBe("var(--r-panel)");
  });
});

describe("the Select when it cannot be used", () => {
  it("dims its chevron with it, and gives the chevron the button text colour in forced colours", () => {
    expect(decl(".v4-select:has(> .sm-select:disabled) > .v4-select-chevron", "opacity")).toBe("var(--dim-off)");
    expect(css).toMatch(/\.v4-select-chevron \{ color: ButtonText; \}/);
  });
});

describe("the Text & density preview", () => {
  it("takes its row padding from the density, 44 at Compact", () => {
    expect(decl(".reading-preview-row", "padding")).toBe("calc(4px * var(--ui-space, 1) / 0.7) 10px");
    expect(decl(".reading-preview-row", "min-height")).toBeUndefined();
  });
});

describe("hover", () => {
  it("lifts the theme and companion names only under a mouse", () => {
    expect(decl(".appearance-theme:hover", "color", POINTER)).toBe("var(--text)");
    expect(decl(".character-choice:hover", "color", POINTER)).toBe("var(--text)");
  });
});
