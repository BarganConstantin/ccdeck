// The page inside the desktop app (#1160) says "window" where a tab would say
// "tab", and drops the browser-permission section the app never uses.
import { describe, it, expect } from "vitest";
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

  it("words the notification switch for a window there, and for a tab everywhere else", () => {
    expect(notifyNote(true)).toBe(NOTIFY_NOTE_APP);
    expect(NOTIFY_NOTE_APP).toMatch(/window closed/);
    expect(notifyNote(false)).toBe(NOTIFY_NOTE);
  });
});
