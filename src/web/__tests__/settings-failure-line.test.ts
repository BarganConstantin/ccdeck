// Settings says a refused write once, under the page head (settings-failure.ts,
// SettingsFailureLine's banner form), and says what a row or a group cannot do
// yet on a line of its own with the info icon (SettingsInfo), under the note
// it keeps. Drawn with the real React; the store is reset after each case.
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { SettingsFailureLine } from "../components/SettingsFailureLine";
import { SettingRow, SettingsGroup, SettingsInfo } from "../components/SettingsParts";
import UpdatesSection from "../components/UpdatesSection";
import NotificationsSection from "../components/NotificationsSection";
import LanguageSection from "../components/LanguageSection";
import { answerSettingsFailure, refuseSave, setSettingsFailure, settingsFailure } from "../settings-failure";
import { ACCOUNT_NOTIFY_DEFAULTS } from "../use-os-notifications";
import type { VersionInfo } from "../use-version-check";
import { sheetText } from "./sheet-source";
import { en } from "../i18n/en";

const noop = () => {};
const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");
/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(m, `${selector} has a rule`).not.toBeNull();
  return m![1].replace(/\s+/g, " ");
}

afterEach(() => { setSettingsFailure(null); });

describe("a refused write, said once under the page head", () => {
  it("says V4's sentence, and offers the give-back press only when the server does", () => {
    refuseSave(null);
    expect(settingsFailure()?.line).toEqual({ text: "Could not save that setting. Try again.", giveBack: false, done: false });
    refuseSave({ detail: { fix: "give_back" } });
    expect(settingsFailure()?.line.giveBack).toBe(true);
  });

  it("draws a second equal refusal as a new alert, and keeps the alert through the press's answer", () => {
    refuseSave(null);
    const first = settingsFailure()!.serial;
    refuseSave(null);
    const second = settingsFailure()!.serial;
    expect(second).not.toBe(first);
    answerSettingsFailure({ text: "Done.", giveBack: false, done: true });
    expect(settingsFailure()!.serial).toBe(second);
    setSettingsFailure(null);
    expect(settingsFailure()).toBeNull();
  });

  it("is V4's banner in the Error tone: the mark, the sentence, and the kit's close", () => {
    const html = renderToStaticMarkup(createElement(SettingsFailureLine, {
      banner: true, line: { text: "Could not save that setting. Try again.", giveBack: false, done: false }, onDismiss: noop, onAnswer: noop,
    }));
    expect(html).toMatch(/^<div class="settings-failure" role="alert"><span class="banner-mark err" aria-hidden="true"><svg/);
    expect(html).toContain('<span class="settings-failure-text">Could not save that setting. Try again.</span>');
    expect(html).toMatch(/<button type="button" class="settings-failure-x" aria-label="[^"]+" title="[^"]+"><svg[\s\S]*<\/svg><\/button><\/div>$/);
    expect(html).not.toContain("settings-failure-act");
    // The give-back press, as the banner's word link, only when on offer.
    const offer = renderToStaticMarkup(createElement(SettingsFailureLine, {
      banner: true, line: { text: "x", giveBack: true, done: false }, onDismiss: noop, onAnswer: noop,
    }));
    expect(offer).toContain('class="settings-failure-act"');
    // The good news after it wears the Done tone.
    const done = renderToStaticMarkup(createElement(SettingsFailureLine, {
      banner: true, line: { text: "x", giveBack: false, done: true }, onDismiss: noop, onAnswer: noop,
    }));
    expect(done).toContain('class="banner-mark ok"');
    // The panel form stays the panel's red box.
    const panel = renderToStaticMarkup(createElement(SettingsFailureLine, {
      line: { text: "x", giveBack: false, done: false }, onDismiss: noop, onAnswer: noop,
    }));
    expect(panel).toContain('class="ap-failure"');
  });

  it("is 32 high with a --line rule at its foot, on the panel fill, and stays in view while the page scrolls", () => {
    const line = rule(".settings-failure");
    expect(line).toContain("min-height: var(--ctl-h-lg)");
    expect(line).toContain("padding: 4px 4px 3px 12px");
    expect(line).toContain("border-bottom: 1px solid var(--line)");
    expect(line).toContain("background: var(--panel)");
    expect(line).toContain("position: sticky");
    // Held at the pane's top edge: the pane's own top padding taken back.
    expect(line).toContain("top: -16px");
    expect(rule(".settings-pane")).toContain("padding: 16px");
    expect(css).toContain("--ctl-h-lg: 32px;");
    expect(rule(".settings-failure .banner-mark")).toContain("color: var(--err)");
    const x = rule(".settings-failure-x");
    expect(x).toContain("width: 24px; height: 24px");
    expect(x).toContain("color: var(--muted)");
    expect(rule(".settings-failure-act")).toContain("font-weight: 500");
  });

  it("is drawn by the dialog under the page head, and emptied on open, on a new section and on close", () => {
    const modal = readFileSync(new URL("../components/SettingsModal.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(modal).toContain("useEffect(() => { setSettingsFailure(null); }, [section]);");
    expect(modal).toContain("useEffect(() => () => setSettingsFailure(null), []);");
    const head = modal.indexOf('<div className="settings-pane-head">');
    const line = modal.indexOf("{failure && <SettingsFailureLine key={failure.serial} banner line={failure.line}");
    expect(head).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(head);
    expect(modal.indexOf("{pane}", head)).toBeGreaterThan(line);
  });

  it("is where every Settings writer reports a refusal, with no Failed word left in a row", () => {
    for (const file of ["../components/SessionRecoverySettings.tsx", "../use-claude-settings.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).toMatch(/refuseSave|setSettingsFailure\(\{/);
      expect(source, file).not.toContain("WriteState");
    }
    expect(readFileSync(new URL("../components/ClaudeCodeSettings.tsx", import.meta.url), "utf8")).not.toContain("WriteState");
    // The switches App hands Settings report there too, and slide back
    // (behaviour: notify-switch-adopts-standing-1761 and use-stage tests).
    const restart = readFileSync(new URL("../use-auto-restart.ts", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(restart).toContain("const refused = (d: Parameters<typeof refuseSave>[0]) => { setAutoRestart(on => (on === next ? !next : on)); refuseSave(d); };");
    expect(restart).toContain("if (!r.ok || !d?.ok) return refused(d); setSettingsFailure(null); setAutoRestart(d.prefs?.autoUpdate !== false);");
    expect(restart).toContain("}).catch(() => refused(null));");
  });
});

describe("what a row or a group cannot do yet, under the note it keeps", () => {
  it("is the info mark and the words, in the note's ink, under a row's note or a caption's", () => {
    const html = renderToStaticMarkup(createElement(SettingsInfo, { id: "x-info", children: "Not yet." }));
    expect(html).toMatch(/^<span class="settings-info" id="x-info"><svg[\s\S]*<\/svg><span>Not yet\.<\/span><\/span>$/);
    const info = rule(".settings-info");
    expect(info).toContain("color: var(--muted)");
    expect(info).toContain("max-width: 400px");
    expect(rule(".settings-row > .settings-info")).toContain("grid-column: 1");
    const group = renderToStaticMarkup(createElement(SettingsGroup, { id: "g", title: "G", note: "Note.", info: "Waits.", infoId: "g-info", children: null }));
    expect(group).toContain('<p class="settings-caption-note">Note.</p><span class="settings-info" id="g-info">');
    const row = renderToStaticMarkup(createElement(SettingRow, { name: "N", note: "Note.", children: createElement(SettingsInfo, { children: "Waits." }) }));
    expect(row.indexOf("settings-row-note")).toBeLessThan(row.indexOf("settings-info"));
  });

  it("keeps Update when idle's note when the deck cannot restart, and says so under it", () => {
    const version = { name: "ccdeck", running: "3.41.0", installed: "3.41.0", latest: "3.41.0", notice: null, command: "npm i -g ccdeck", canRestart: false, checkDisabled: false } as VersionInfo;
    const html = renderToStaticMarkup(createElement(UpdatesSection, { autoRestart: true, onToggleAutoRestart: noop, version, inApp: false }));
    expect(html).toContain('<span class="settings-row-note" id="settings-auto-update-note">Installs a new version when no session is working.</span>');
    expect(html).toContain('<span class="settings-info" id="settings-auto-update-info"><svg');
    expect(html).toContain("<span>Not available in this session. Your choice is saved for the next start.</span>");
    expect(html).toContain('aria-describedby="settings-auto-update-note settings-auto-update-info"');
    // A deck that can restart says the note alone.
    const plain = renderToStaticMarkup(createElement(UpdatesSection, { autoRestart: true, onToggleAutoRestart: noop, version: { ...version, canRestart: true }, inApp: false }));
    expect(plain).not.toContain("settings-info");
    expect(plain).toContain('aria-describedby="settings-auto-update-note"');
  });

  it("keeps the notifications note when alerts are held off at launch, and says so under it", () => {
    const draw = (notifyVetoed: boolean) => renderToStaticMarkup(createElement(NotificationsSection, {
      notifyOn: true, onToggleNotify: noop, notifyVetoed, notifyPermission: "granted", onAskNotify: noop,
      accountNotify: ACCOUNT_NOTIFY_DEFAULTS, onToggleAccountNotify: noop,
    }));
    const held = draw(true);
    expect(held).toContain('<span class="settings-row-note" id="sm-notify-note">Keeps notifying from the background.</span>');
    expect(held).toContain('<span class="settings-info" id="sm-notify-veto"><svg');
    expect(held).toContain("<span>Held off for this run: the deck was started with alerts off. Your choice is saved for the next start.</span>");
    expect(held).toContain('aria-describedby="sm-notify-note sm-notify-veto"');
    // The accounts group keeps its caption note and says the same under it.
    expect(held).toMatch(/<p class="settings-caption-note">For the Claude and Codex accounts you&#x27;re on, whether or not the deck is open\.<\/p><span class="settings-info"><svg[\s\S]*?<\/svg><span>Held off for this run too\.<\/span>/);
    const free = draw(false);
    expect(free).not.toContain("settings-info");
  });

  it("words every account notification as a sentence with a full stop, Codex where it applies", () => {
    const notes = ["swap", "quota", "reset", "stopped"].map(k => en[`settings.notify.${k}.title`]);
    for (const note of notes) expect(note, note).toMatch(/^[A-Z][^]*\.$/);
    expect(en["settings.notify.swap.title"]).toBe("When auto-switch moves Claude Code or Codex to another account.");
    expect(en["settings.notify.quota.title"]).toBe("For the account you are on, once at 90% and again at 100%.");
    expect(en["settings.notify.reset.title"]).toBe("When a window that reached 90% is available again.");
    expect(en["settings.notify.stopped.title"]).toBe("Once for all of them, with what to type to resume.");
  });
});

describe("General's own words", () => {
  it("names the language row as V4 does", () => {
    const html = renderToStaticMarkup(createElement(LanguageSection));
    expect(html).toContain('<span class="settings-row-name" id="settings-language-label">Language</span>');
    expect(html).toContain("The words in the deck. Follows the system until you pick one.");
  });

  it("says what the restore rows and Update when idle do in V4's words", () => {
    expect(en["settings.section.general.note"]).toBe("How sessions come back after a restart, and updates.");
    expect(en["settings.recover.claudeName"]).toBe("Bring back busy Claude sessions");
    expect(en["settings.recover.claudeNote"]).toBe("After a restart, sessions that were still working return to the rail.");
    expect(en["settings.recover.codexName"]).toBe("Bring back unfinished Codex turns");
    expect(en["settings.recover.codexNote"]).toBe("Their processes may have stopped; the turn shows as it was left.");
    expect(en["settings.recover.continueNote"]).toBe("They resume once a signed-in account has room again.");
    expect(en["settings.board.hideNote"]).toBe("Hidden sessions stay in the rail under Done, one click away.");
    expect(en["settings.updates.plainNote"]).toBe("Installs a new version when no session is working.");
  });

  it("draws Elsewhere's Open as V4's text link: the accent's words at 12/16 and 500, no box", () => {
    const link = rule("button.settings-link");
    expect(link).toContain("border: 0");
    expect(link).toContain("background: none");
    expect(link).toContain("font-weight: 500");
    expect(link).toContain("font-size: calc(12px + var(--ui-text-increase, 0px))");
    expect(rule(".settings-link")).toContain("color: var(--accent)");
  });
});
