// Settings keeps one height across sections.
//
// The dialog was as tall as the section it held, with its top pinned, so every
// press in the nav moved its bottom edge: measured at 1440×900 it was 412px on
// General, 320 on Notifications, 618 on Sounds and 378 on Music & character,
// and the frame jumped under the pointer each time a section was chosen. Now
// the dialog has one height of its own, set by the sheet and by nothing a
// section draws, and the section scrolls inside it when a window is too short
// to hold it: macOS System Settings, Linear's settings and Raycast's
// preferences all keep one frame and let the pane change inside it.
//
// No DOM here, so the cascade is read out of the sheet for the dialog's own
// chain of elements at a desktop's width and a phone's, and the markup is drawn
// once per section to show that nothing on the frame follows the section.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SettingsModal, { type SettingsModalProps } from "../components/SettingsModal";
import { SETTINGS_SECTIONS, type SettingsSection } from "../settings";
import { DEFAULT_PREFS } from "../sound";
import { ACCOUNT_NOTIFY_DEFAULTS } from "../use-os-notifications";
import { cascade, el, selects, type El } from "./sheet-cascade";

const DESKTOP = 1440;
const PHONE = 390;

const backdrop = el("div", ["modal-backdrop"], { attrs: { role: "presentation" } });
const dialog = el("div", ["modal", "settings-modal"], { attrs: { id: "settings", role: "dialog", "aria-modal": "true" } });
const body = el("div", ["settings-body"]);
const nav = el("div", ["settings-nav"], { attrs: { role: "tablist" } });
const pane = el("div", ["settings-pane"], { attrs: { role: "tabpanel", id: "settings-pane" } });

/** `selects`, except that a selector it cannot read (a sibling, a `:has()`)
 *  is passed over when it names neither a modal nor Settings — `.aa-code > * + *`
 *  matches any element on its subject and could never reach this dialog — and
 *  still throws when it does, so a rule that might size the dialog is never
 *  skipped in silence. */
const reach = (chain: readonly El[]) => (selector: string) => {
  try { return selects(selector, chain); } catch (error) {
    if (/modal|settings/.test(selector)) throw error;
    return null;
  }
};
const at = (chain: readonly El[], prop: string, width: number) => cascade(reach(chain), prop, width);
const onDialog = (prop: string, width: number) => at([backdrop, dialog], prop, width);
const onBody = (prop: string, width: number) => at([backdrop, dialog, body], prop, width);
const onNav = (prop: string, width: number) => at([backdrop, dialog, body, nav], prop, width);
const onPane = (prop: string, width: number) => at([backdrop, dialog, body, pane], prop, width);

const noop = () => {};
const asyncNoop = async () => {};
const draw = (section: SettingsSection) => renderToStaticMarkup(createElement(SettingsModal, {
  section, onSection: noop, onClose: noop,
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
  fm: {
    fmVolume: 50, setFmVolume: noop, fmMuted: false, setFmMuted: noop, fmSource: "claude-fm", customFmStations: [],
    unavailableFmStations: new Set(), fmPlayRequest: 0, addFmStation: noop, renameFmStation: noop,
    removeFmStation: noop, pickFmSource: noop, markFmStationAvailability: noop,
  },
} as unknown as SettingsModalProps));

/** The opening tag of the element carrying `marker`, attributes and all. */
const openTag = (html: string, marker: string) => new RegExp(`<[a-z]+[^>]*${marker}[^>]*>`).exec(html)?.[0];

describe("Settings keeps one height across sections", () => {
  it("gives the dialog one explicit height on a desktop, held inside the window", () => {
    expect(onDialog("height", DESKTOP)).toBe("min(720px, calc(100dvh - 80px))");
    // Nothing a section draws can stretch or shrink it: no floor for a short
    // section to sit on, and .modal's 82vh ceiling taken off so the one height
    // is the only word on it.
    expect(onDialog("min-height", DESKTOP)).toBeNull();
    expect(onDialog("max-height", DESKTOP)).toBe("none");
  });

  it("takes the phone's height, 16px off each edge, whichever section is open", () => {
    expect(onDialog("height", PHONE)).toBe("calc(100dvh - 32px)");
    expect(onDialog("min-height", PHONE)).toBeNull();
    expect(onDialog("max-height", PHONE)).toBe("none");
  });

  it("stays where it opened: centred like every dialog, with no offset of its own to move", () => {
    expect(onDialog("margin-top", DESKTOP)).toBeNull();
    expect(onDialog("margin-top", PHONE)).toBeNull();
    expect(at([backdrop], "align-items", DESKTOP)).toBe("center");
    expect(onDialog("transition", DESKTOP)).toBeNull();
  });

  it("scrolls the section, never the nav or the header, on a gutter that does not move", () => {
    for (const width of [DESKTOP, PHONE]) {
      expect(onDialog("overflow", width), `${width}`).toBe("hidden");
      expect(onBody("flex", width), `${width}`).toBe("1");
      expect(onBody("min-height", width), `${width}`).toBe("0");
      expect(onPane("overflow-y", width), `${width}`).toBe("auto");
      expect(onPane("min-height", width), `${width}`).toBe("0");
      expect(onPane("scrollbar-gutter", width), `${width}`).toBe("stable both-edges");
      expect(onPane("overscroll-behavior", width), `${width}`).toBe("contain");
    }
    expect(onNav("overflow-y", DESKTOP)).toBe("auto");
  });

  it("fades only the padding at each edge, so a section at rest shows nothing faded", () => {
    for (const width of [DESKTOP, PHONE]) {
      const [top, , bottom] = onPane("padding", width)!.split(" ");
      const mask = onPane("mask-image", width);
      expect(mask, `${width}`).toBe(`linear-gradient(transparent, #000 ${top}, #000 calc(100% - ${bottom}), transparent)`);
      expect(onPane("-webkit-mask-image", width), `${width}`).toBe(mask);
      // A control the keyboard scrolls to stops clear of both fades.
      expect(onPane("scroll-padding", width), `${width}`).toBe(`${top} 0 ${bottom}`);
    }
  });

  it("draws the same frame round every section", () => {
    const frames = SETTINGS_SECTIONS.map(({ id }) => {
      const html = draw(id);
      return [openTag(html, 'id="settings"'), openTag(html, 'class="settings-body"'), openTag(html, 'role="tablist"')];
    });
    expect(frames[0].every(Boolean)).toBe(true);
    for (const frame of frames.slice(1)) expect(frame).toEqual(frames[0]);
    // The pane changes only the tab it answers to: no class or style of its
    // own per section for a rule to size it by.
    const panes = SETTINGS_SECTIONS.map(({ id }) => openTag(draw(id), 'role="tabpanel"')?.replace(/settings-tab-[a-z]+/, "settings-tab-X"));
    expect(new Set(panes).size).toBe(1);
  });
});
