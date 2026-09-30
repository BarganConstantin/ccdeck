// Opened from the menu bar while another app was full screen, the deck's
// window came up over that app and then stayed in front of it: clicking the
// full-screen browser gave the browser the keyboard and left ccdeck drawn over
// it (#1214). With no app full screen the same window stepped back as it
// should.
//
// A full-screen Space admits the windows of an agent app — an accessory app is
// one, the same as LSUIElement — and nothing else from another app, and there
// is nothing behind a full-screen window for an admitted one to step back to.
// The app is accessory while no window is open, and it built the window before
// it turned regular, so the window was made as an agent's and let in.
//
// Electron cannot run in the suite, so what is checked is the order in the
// app's source: regular first, then the window.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const main = readFileSync(join(__dirname, "..", "..", "..", "desktop", "main.mjs"), "utf8");

/** The body of openWindow, up to the function after it. */
function openWindowBody(): string {
  const at = main.indexOf("function openWindow(steal = true) {");
  expect(at).toBeGreaterThan(-1);
  return main.slice(at, main.indexOf("\n}\n", at));
}

describe("the window a person opens while another app is full screen", () => {
  it("is built by a regular app, so a full-screen Space never takes it in", () => {
    const body = openWindowBody();
    const regular = body.indexOf("setRegular(true);");
    expect(regular).toBeGreaterThan(-1);
    expect(regular).toBeLessThan(body.indexOf("new BrowserWindow("));
  });

  it("turns regular once, and back to a menu-bar app when the window closes", () => {
    const body = openWindowBody();
    expect(body.split("setRegular(true);")).toHaveLength(2);
    expect(body).toMatch(/win\.on\("closed", \(\) => \{\n {4}win = null;\n {4}setRegular\(false\);/);
  });
});
