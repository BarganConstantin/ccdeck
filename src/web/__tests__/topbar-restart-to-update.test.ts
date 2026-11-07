// The topbar's own Restart to update (owner's call, 2026-10-18). A user wrote
// that the app restarted "randomly" on updates and asked for agency over it.
// The ready chip already said an update was there, but its click opens What's
// new and the press waited inside the dialog, a step most people never took —
// so the app took it for them. This is the press itself, one click, only while
// the app has a verified update ready.
// CHANGED ON PURPOSE (V4's Figma): the press is the ready chip itself, one chip
// reading "Restart to finish" with the kit's Restart icon and the versions in
// its tooltip. It used to be a second button beside a chip that opened What's
// new; What's new for the update is in Settings › About, and a press that
// comes to nothing still opens it (the wiring below).
import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import VersionChip from "../components/VersionChip";
import { KitIcon } from "../components/kit-icons";
import { readyButtonCopy, RESTART_TO_FINISH_MSG, RESTART_TO_UPDATE_MSG } from "../desktop-update";
import { en } from "../i18n/en";

// CHANGED ON PURPOSE (the UI in every language): the label is a key now, read
// here through the English catalog.
const RESTART_TO_UPDATE = en[RESTART_TO_UPDATE_MSG];

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

type ChipProps = Parameters<typeof VersionChip>[0];
const base: ChipProps = {
  readyAppUpdate: { version: "3.42.0" },
  notice: null,
  noticeOpen: false,
  version: null,
  chipVersion: "3.41.3",
  versionChecking: false,
  now: 0,
  openReleaseNotes: () => {},
  showNotice: () => {},
  loadVersion: async () => {},
  restartToUpdate: () => {},
};
const html = (over: Partial<ChipProps> = {}) => renderToStaticMarkup(createElement(VersionChip, { ...base, ...over }));

/** Every element in a tree VersionChip returned, depth first. It calls no
 *  hooks, so it can be called as a function and its buttons pressed directly. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}
const readyChip = (props: ChipProps) =>
  elements(VersionChip(props)).find(el => el.props.className === "v ready");

// The same words on Settings › About's Restart to update, the one other place
// on the page that makes this press.
describe("the button's words", () => {
  it("prints the shared phrase, and its name starts with it and names the version (WCAG 2.5.3)", () => {
    // One phrase on every surface that applies the update — the tray, the
    // native sheet, the dialog — and now this one.
    const copy = readyButtonCopy("3.42.0");
    expect(copy.text).toBe(RESTART_TO_UPDATE);
    expect(copy.label).toBe(`${RESTART_TO_UPDATE} to v3.42.0`);
    expect(copy.label!.startsWith(copy.text)).toBe(true);
  });

  it("says that ccdeck restarts and that the agents do not", () => {
    // The two facts a person weighing the press needs, and the one the user
    // who asked for it was afraid of: their sessions are not what restarts.
    const { title } = readyButtonCopy("3.42.0");
    expect(title).toContain("v3.42.0");
    expect(title).toMatch(/ccdeck restarts/);
    expect(title).toMatch(/sessions keep running/);
  });

  it("while its request is out, prints Restarting… and is read as what it prints", () => {
    const copy = readyButtonCopy("3.42.0", true);
    expect(copy.text).toBe("Restarting…");
    expect(copy.label).toBeUndefined();
  });
});

describe("the ready chip is the press", () => {
  it("is one chip, there only while the app has an update ready", () => {
    const out = html();
    expect(out.match(/<button/g)).toHaveLength(1);
    expect(out).toContain('class="v ready"');
    expect(out).not.toContain("v-update");
    expect(html({ readyAppUpdate: null })).not.toContain('class="v ready"');
  });

  it("reads Restart to finish after the kit's Restart icon, with the versions in its tooltip", () => {
    const restartIcon = renderToStaticMarkup(createElement(KitIcon, { name: "restart" }));
    const out = html();
    expect(out).toContain(`<span class="v-icon" aria-hidden="true">${restartIcon}</span>${en[RESTART_TO_FINISH_MSG]}</button>`);
    expect(en[RESTART_TO_FINISH_MSG]).toBe("Restart to finish");
    // Its name is what it prints: no aria-label to drift from the words.
    expect(out).not.toContain("aria-label");
    expect(out).toMatch(/title="v3\.41\.3 → v3\.42\.0 · Install ccdeck v3\.42\.0 now/);
  });

  it("asks for the restart into the exact version that is ready, and opens nothing", () => {
    // The app checks the version again before acting (window-update.mjs), so
    // the press has to name the one on offer, not whatever the chip printed.
    const restartToUpdate = vi.fn();
    const openReleaseNotes = vi.fn();
    const chip = readyChip({ ...base, restartToUpdate, openReleaseNotes });
    (chip!.props.onClick as () => void)();
    expect(restartToUpdate).toHaveBeenCalledWith("3.42.0");
    expect(openReleaseNotes).not.toHaveBeenCalled();
  });

  it("is busy, never disabled, while its request is out (#620)", () => {
    const out = html({ updateRestarting: true });
    expect(out).toContain("Restarting…");
    expect(out).toMatch(/class="v ready"[^>]*aria-busy="true"/);
    expect(out).not.toMatch(/disabled/);
    expect(html()).not.toContain("aria-busy");
  });
});

describe("the wiring", () => {
  const topbar = read("../components/TopbarReadouts.tsx");

  it("presses through the same path as the dialog's button", () => {
    expect(topbar).toMatch(/void askDesktopUpdateRestart\(updateVersion\);/);
    expect(topbar).toMatch(/restartToUpdate=\{restartToUpdate\} updateRestarting=\{desktopUpdateRestarting\}/);
  });

  it("opens What's new when a press made here came to nothing, where the reason is written", () => {
    // The button has nowhere to say a sentence; the dialog's live region
    // already says what went wrong and names the tray as the way out.
    const effect = topbar.match(/useEffect\(\(\) => \{\n    if \(desktopUpdateRestarting \|\| !topbarPress\.current\) return;[\s\S]*?\}, \[desktopUpdateRestarting, desktopUpdateFailure, openReleaseNotes\]\);/)?.[0];
    expect(effect).toBeTruthy();
    expect(effect).toMatch(/if \(desktopUpdateFailure\) openReleaseNotes\(\);/);
  });

  it("needs no phone rule: there is one chip, not a chip and a button to choose between", () => {
    // Chip and button together were about 228px, and below 480px the chip
    // used to give way to the button. One chip is the press now.
    const css = read("../styles/topbar.css");
    expect(css).not.toMatch(/v-update/);
    // It wears V4's one chip look (the accent wash, no edge) with a newer
    // version, and is busy while its press is out.
    expect(css).toMatch(/\.topbar button\.v:is\(\.stale, \.ready\) \{/);
    expect(css).toMatch(/\.topbar button\.v\.ready\[aria-busy="true"\] \{ cursor: progress; \}/);
  });
});
