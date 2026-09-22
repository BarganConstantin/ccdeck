// The page inside the desktop app (#1160) says "window" where a tab would say
// "tab", and drops the browser-permission section the app never uses.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inDesktopApp } from "../in-app";
import { notifyNote, NOTIFY_NOTE, NOTIFY_NOTE_APP } from "../notify-reach";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

describe("knowing the page is in the app", () => {
  it("reads the marker the app appends to its user agent", () => {
    expect(inDesktopApp(`${CHROME} ccdeck-desktop/3.25.0`)).toBe(true);
    expect(inDesktopApp(CHROME)).toBe(false);
    // Electron's own product token is not the app: a page opened in some other
    // Electron shell is still a tab.
    expect(inDesktopApp(`${CHROME} Electron/42.11.6`)).toBe(false);
  });

  it("reads the marker the app actually appends, not a copy of it (#1173)", () => {
    // The case above hard-codes the suffix, so either side could be renamed —
    // `ccdeck/`, `CCDeck-Desktop/` — with every test green, and the desktop
    // window would go on asking for a browser permission it cannot use and
    // describing a tab to close. This reads the template main.mjs hands
    // setUserAgent and fills in what Electron would: the window's own user
    // agent and the app's version from its package.json.
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const main = read("../../../desktop/main.mjs");
    const { version } = JSON.parse(read("../../../desktop/package.json")) as { version: string };
    const template = main.match(/\.setUserAgent\(`([^`]*)`\)/)?.[1];
    expect(template, "main.mjs no longer sets the user agent with a template").toBeDefined();
    const ua = template!
      .replace(/\$\{[^}]*getUserAgent\(\)\}/, CHROME)
      .replace(/\$\{app\.getVersion\(\)\}/, version);
    // Nothing left unfilled: a placeholder this does not know would otherwise
    // pass through as literal text and prove nothing.
    expect(ua).not.toContain("${");
    expect(ua.startsWith(CHROME)).toBe(true);
    expect(inDesktopApp(ua)).toBe(true);
  });

  it("wants a version after the marker, not the name alone", () => {
    // The digit is deliberate: the marker is the app's name AND its version,
    // and a bare name is not what the app writes.
    expect(inDesktopApp(`${CHROME} ccdeck-desktop/`)).toBe(false);
  });

  it("words the notification switch for a window there, and for a tab everywhere else", () => {
    expect(notifyNote(true)).toBe(NOTIFY_NOTE_APP);
    expect(NOTIFY_NOTE_APP).toMatch(/window closed/);
    expect(notifyNote(false)).toBe(NOTIFY_NOTE);
  });
});
