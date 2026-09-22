// The sign-in dialog opened as a strip down the left edge of the screen: 288px
// wide, the full height, over a scrim that dimmed the accounts panel and
// nothing else. `.modal-backdrop` is `position: fixed; inset: 0`, which covers
// the viewport only while nothing between it and <body> has a say in its box.
// The accounts panel had one: the wipe it opens with gives every direct child a
// fixed 288px measure (`.accounts-panel > *`), and the dialog was a direct
// child, so the rule sized the backdrop as if it were a row of the panel.
//
// SectionHistoryModal met the same kind of fault from a transformed panel and
// answered it with a portal. This pins the rule the two findings add up to: a
// dialog mounted anywhere but App.tsx — the top of the tree, where no panel
// sits above it — renders through createPortal into <body>, so no panel's
// layout can reach its backdrop.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../components", import.meta.url));
const components = readdirSync(dir)
  .filter(f => f.endsWith(".tsx"))
  .map(f => [f.replace(/\.tsx$/, ""), readFileSync(`${dir}/${f}`, "utf8")] as const);

/** The components that mount `name`, App.tsx aside — it is not in this folder. */
const mountedFrom = (name: string) => components
  .filter(([other, src]) => other !== name && new RegExp(`<${name}\\b`).test(src))
  .map(([other]) => other);

describe("a dialog opened from inside a panel is not laid out by it", () => {
  const dialogs = components.filter(([, src]) => /className="[a-z-]*backdrop"/.test(src));
  const nested = dialogs.filter(([name]) => mountedFrom(name).length > 0);

  it("knows which dialogs are mounted below the top of the tree", () => {
    // Named rather than counted, so a dialog that moves into a panel shows up
    // here as a change to read, not as the sweep below quietly growing.
    expect(nested.map(([name]) => name).sort()).toEqual([
      "AccountProjectsModal",
      "AddAccountDialog",
      "GuideModal",
      "LanAddDeckModal",
      "LanPeerModal",
      "LanSetupModal",
      "ProcessListModal",
      "SectionHistoryModal",
      "ShareAccountsDialog",
    ]);
  });

  it("renders every one of them into <body> through a portal", () => {
    for (const [name, src] of nested) {
      const portalled = /return createPortal\(\s*(?:\/\/[^\n]*\n\s*)*<div className="[a-z-]*backdrop"[\s\S]*?,\s*document\.body,?\s*\);/.test(src);
      expect(`${name}: ${portalled}`).toBe(`${name}: true`);
    }
  });

  it("still has the panel rule that made this necessary", () => {
    // If the fixed measure ever goes, the portals are still right — a modal is
    // not a panel's to lay out — but this comment trail would be pointing at a
    // rule that no longer exists, and that is worth knowing.
    const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.accounts-panel > \* \{ width: 288px; \}/);
  });
});
