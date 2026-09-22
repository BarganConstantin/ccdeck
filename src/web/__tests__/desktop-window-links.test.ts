// Where a link clicked inside the desktop app's window is allowed to go.
//
// The window has no address bar and wears ccdeck's name, so a page loaded into
// it looks like ccdeck whatever served it, and a scheme handed to the OS is a
// link that can start a program. `navigationFor` is the one place that decides,
// and the two handlers in main.mjs — the one for a new window and the one for a
// navigation in this one — both have to ask it, which is what the last case
// here pins. The prefix test it replaced (`url.startsWith(origin)`) let
// `http://127.0.0.1:4317@evil.example/` and `http://127.0.0.1:43170/` stay in
// the window, and its sibling (`/^https?:/`) opened neither in the browser.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { navigationFor } from "../../../desktop/nav.mjs";

const ORIGIN = "http://127.0.0.1:4317";
const main = readFileSync(fileURLToPath(new URL("../../../desktop/main.mjs", import.meta.url)), "utf8");

describe("a link inside the app's window", () => {
  it("stays in the window only on the deck's own origin", () => {
    expect(navigationFor(`${ORIGIN}/`, ORIGIN)).toBe("stay");
    expect(navigationFor(`${ORIGIN}/?session=abc#node`, ORIGIN)).toBe("stay");
  });

  it("opens another site in the person's own browser", () => {
    expect(navigationFor("https://ccdeck.dev/", ORIGIN)).toBe("external");
    expect(navigationFor("https://console.anthropic.com/login", ORIGIN)).toBe("external");
  });

  it("is not fooled by an address that merely starts with the deck's", () => {
    // A userinfo field: the host is evil.example, and the deck's address is
    // the username. A prefix test reads it as the deck's own page.
    expect(navigationFor(`${ORIGIN}@evil.example/`, ORIGIN)).toBe("external");
    // Another program on this machine, on a port whose number starts the same.
    expect(navigationFor("http://127.0.0.1:43170/", ORIGIN)).toBe("external");
    // Same port, another host on the loopback name.
    expect(navigationFor("http://localhost:4317/", ORIGIN)).toBe("external");
  });

  it("refuses anything that is not a web page, rather than handing it to the OS", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "smb://server/share", "ms-msdt:/id", "data:text/html,<b>x</b>", "not a url"]) {
      expect(navigationFor(url, ORIGIN), url).toBe("block");
    }
  });

  it("is asked by both of the window's handlers", () => {
    // Either handler left on its own test is a way into the window, or a
    // scheme handed to the shell, that this file would not see.
    const open = main.match(/setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?\}\);/)?.[0] ?? "";
    const navigate = main.match(/on\("will-navigate", \(event, url\) => \{[\s\S]*?\n {2}\}\);/)?.[0] ?? "";
    expect(open).toMatch(/navigationFor\(url, origin\) !== "block"/);
    expect(navigate).toMatch(/navigationFor\(url, origin\)/);
    expect(navigate).toMatch(/shell\.openExternal\(url\)/);
    expect(main).not.toMatch(/url\.startsWith\(origin\)/);
  });
});
