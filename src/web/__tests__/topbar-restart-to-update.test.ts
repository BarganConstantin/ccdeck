// The topbar's own Restart to update (owner's call, 2026-10-18). A user wrote
// that the app restarted "randomly" on updates and asked for agency over it.
// The ready chip already said an update was there, but its click opens What's
// new and the press waited inside the dialog, a step most people never took —
// so the app took it for them. This is the press itself, one click, beside the
// chip, only while the app has a verified update ready.
import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import VersionChip from "../components/VersionChip";
import { readyButtonCopy, RESTART_TO_UPDATE } from "../desktop-update";

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
const pressButton = (props: ChipProps) =>
  elements(VersionChip(props)).find(el => el.props.className === "v ready v-update");

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

describe("the button beside the chip", () => {
  it("is there only while the app has an update ready", () => {
    expect(html()).toContain('class="v ready v-update"');
    expect(html({ readyAppUpdate: null })).not.toContain("v-update");
    // No press to make, no button: a page outside the app is never handed one.
    expect(html({ restartToUpdate: undefined })).not.toContain("v-update");
  });

  it("leaves the chip as it was, still opening What's new", () => {
    const openReleaseNotes = vi.fn();
    const chip = elements(VersionChip({ ...base, openReleaseNotes })).find(el => el.props.className === "v ready");
    (chip!.props.onClick as () => void)();
    expect(openReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it("asks for the restart into the exact version that is ready", () => {
    // The app checks the version again before acting (window-update.mjs), so
    // the press has to name the one on offer, not whatever the chip printed.
    const restartToUpdate = vi.fn();
    const button = pressButton({ ...base, restartToUpdate });
    (button!.props.onClick as () => void)();
    expect(restartToUpdate).toHaveBeenCalledWith("3.42.0");
  });

  it("is busy, never disabled, while its request is out (#620)", () => {
    const out = html({ updateRestarting: true });
    expect(out).toContain("Restarting…");
    expect(out).toMatch(/class="v ready v-update"[^>]*aria-busy="true"/);
    expect(out).not.toMatch(/v-update"[^>]*disabled/);
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

  it("keeps the bar on a phone's width: below 480px the chip gives way to the button", () => {
    // Chip and button together are about 228px, and with a session waiting
    // they pushed the chip's left edge out of a 320px bar.
    const css = read("../styles/topbar.css");
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.topbar \.brand button\.v\.ready:has\(\+ \.v-update\) \{ display: none; \}\s*\}/);
    expect(css).toMatch(/\.topbar \.brand button\.v\.v-update \{/);
  });
});
