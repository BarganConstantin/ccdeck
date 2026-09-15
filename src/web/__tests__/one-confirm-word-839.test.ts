// #839: destructive acts used three confirmation idioms — a dialog for Clear,
// an armed "confirm" to remove an account, an armed "sure?" to unpair a deck.
// Three patterns to learn for one kind of act. The two in-panel ones now arm to
// the same word, and the dialog stays for Clear alone, which destroys the most.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const components = fileURLToPath(new URL("../components", import.meta.url));
const read = (name: string) => readFileSync(join(components, name), "utf8");
const accounts = read("AccountsPanel.tsx");
const lan = read("LanSyncSection.tsx");

describe("one arm-then-confirm word for the in-panel destructive acts (#839)", () => {
  it("arms removing an account to confirm", () => {
    // Capitalised since the verb moved from a pill on the row into the ⋯
    // menu, whose items are sentence case like every menu. Same word.
    expect(accounts).toMatch(/confirmRemove === a\.num \? "Confirm" : "Remove"/);
  });

  it("arms unpairing a deck to the same word", () => {
    expect(lan).toMatch(/armed === p\.fp \? "confirm" : "unpair"/);
  });

  it("leaves no second word for it anywhere in the components", () => {
    const offenders = readdirSync(components)
      .filter(f => f.endsWith(".tsx"))
      .filter(f => /["'`>]\s*sure\?\s*["'`<]/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("keeps the dialog for Clear alone", () => {
    const dialogs = readdirSync(components)
      .filter(f => f.endsWith(".tsx"))
      .filter(f => /btn danger/.test(read(f)) && /role="dialog"/.test(read(f)));
    expect(dialogs).toContain("ClearConfirm.tsx");
    // Neither in-panel act opens one.
    expect(accounts).not.toMatch(/Confirm(Remove)?Dialog/);
    expect(lan).not.toMatch(/Unpair(Confirm|Dialog)/);
  });
});
