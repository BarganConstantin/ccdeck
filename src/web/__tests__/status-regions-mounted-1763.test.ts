// Two status messages whose live region arrived with its own text (#1763).
//
// The topbar's "notifications on" / "notifications blocked" was a span with
// role="status" mounted only at the moment the browser answered, and the sound
// menu's note that both tones use the same custom sound was a role="status"
// paragraph mounted the moment the second tone picked it. A screen reader
// registers a live region when it enters the accessibility tree, and text that
// arrives in the same tick as the region is routinely never announced — the
// reason the topbar's other three regions are mounted unconditionally (#372).
// So the refusal a screen-reader user most needs to hear was often silent.
//
// Each region is now always mounted and only its text changes. The visible
// chip and the visible note still come and go as they did, hidden from the
// accessibility tree so that nothing is read twice.
//
// Rendered, not read: both components are drawn to markup by react-dom/server,
// once before the answer and once after.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ReadoutGroup } from "../components/TopbarReadouts";
import SoundsSection from "../components/SoundsSection";
import { DEFAULT_PREFS } from "../sound";

type ReadoutProps = Parameters<typeof ReadoutGroup>[0];
type Said = "on" | "blocked" | null;

const readouts = (notifySaid: Said) => renderToStaticMarkup(createElement(ReadoutGroup, {
  versionCheck: { version: "1.0.0", notice: null, noticeOpen: false, showNotice: () => {}, versionChecking: false, loadVersion: () => {} },
  welcome: { chipVersion: null, openReleaseNotes: () => {} },
  desktopUpdate: { readyAppUpdate: null },
  pause: { paused: false, pauseGate: { size: 0, dropped: 0 } },
  announcements: { blockedSaid: "", watchSaid: "", incidentSaid: "" },
  notify: { notifySaid },
  waitingSessions: [],
  waitingCursorRef: { current: null },
  focusSession: () => {},
  live: true,
  now: 1_790_550_000_000,
  incidents: [],
} as unknown as ReadoutProps));

/** Every role="status" element, as its opening tag and its text. */
const regions = (html: string) =>
  [...html.matchAll(/<(\w+)([^>]*\brole="status"[^>]*)>([^<]*)<\/\1>/g)].map(m => ({ attrs: m[2], text: m[3] }));

describe("the topbar's word on the browser's answer", () => {
  it("has its region in place before there is anything to say", () => {
    const before = regions(readouts(null));
    const after = regions(readouts("blocked"));
    expect(after).toHaveLength(before.length);
    expect(before.every(r => r.attrs.includes('class="vis-hidden"'))).toBe(true);
  });

  it("says a refusal in the region that was already there, with its remedy", () => {
    const before = regions(readouts(null));
    const after = regions(readouts("blocked"));
    const changed = after.findIndex((r, n) => r.text !== before[n].text);
    expect(changed).toBeGreaterThan(-1);
    expect(before[changed].text).toBe("");
    expect(after[changed].text).toMatch(/^Notifications are blocked for this page\./);
    expect(after[changed].text).toMatch(/site settings/);
  });

  it("says a grant there too", () => {
    const said = regions(readouts("on")).map(r => r.text).filter(Boolean);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/^Notifications on\./);
  });

  it("keeps the chip on screen, and out of the accessibility tree", () => {
    const html = readouts("blocked");
    const chip = /<span class="notify-said notify-said-blocked"([^>]*)>notifications blocked<\/span>/.exec(html);
    expect(chip).not.toBeNull();
    expect(chip![1]).toContain('aria-hidden="true"');
    expect(chip![1]).not.toContain("role=");
    expect(readouts(null)).not.toContain("notify-said");
  });
});

// The tones and their shared note left the sound popover for Settings › Sounds
// (2026-10-07), whole; this draws that section.
const menu = (done: string | null, needsInput: string | null) => renderToStaticMarkup(createElement(SoundsSection, {
  soundOn: true, onToggleSound: () => {}, prefs: DEFAULT_PREFS, claudeHere: true,
  onLevel: () => {}, onFigure: () => {}, onPreview: () => {},
  customAssets: [{ id: "clip-1", name: "Chime", kind: "audio", mime: "audio/wav", duration: 1.5, normalizationGain: 1 }],
  customSelections: { done, "needs-input": needsInput },
  onBuiltInSelected: () => {}, onCustomSelected: () => {},
  onImportCustom: async () => {}, onCreateVoice: async () => {}, onRenameCustom: async () => {},
  onPreviewCustom: () => {}, onDeleteCustom: async () => {},
} as Parameters<typeof SoundsSection>[0]));

describe("Settings › Sounds' note on a shared custom sound", () => {
  it("has its region in place before both tones share one", () => {
    const before = regions(menu("clip-1", null));
    const after = regions(menu("clip-1", "clip-1"));
    expect(after).toHaveLength(before.length);
    const changed = after.findIndex((r, n) => r.text !== before[n].text);
    expect(changed).toBeGreaterThan(-1);
    expect(before[changed].text).toBe("");
    expect(after[changed].text).toBe("Both tones use “Chime”. They may be harder to tell apart.");
  });

  it("still shows the note, once, and only while they share one", () => {
    const shown = /<p class="sm-note"([^>]*)>Both tones use “Chime”\. They may be harder to tell apart\.<\/p>/;
    expect(menu("clip-1", null)).not.toMatch(shown);
    const note = shown.exec(menu("clip-1", "clip-1"));
    expect(note).not.toBeNull();
    expect(note![1]).toContain('aria-hidden="true"');
    expect(note![1]).not.toContain("role=");
  });
});
