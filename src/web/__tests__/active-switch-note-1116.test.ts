import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { activeSwitchNote } from "../active-switch-note";

describe("a panel switch confirmation follows the live account (#1116)", () => {
  const note = { num: 2, name: "account 2" };

  it("stays on the account while a fresh roster still marks it active", () => {
    expect(activeSwitchNote(note, [{ num: 2, active: true }, { num: 3, active: false }])).toBe(note);
  });

  it("clears on an external switch, and cannot reappear when the account becomes active again", () => {
    const afterSwitch = activeSwitchNote(note, [{ num: 2, active: false }, { num: 3, active: true }]);
    expect(afterSwitch).toBeNull();
    expect(activeSwitchNote(afterSwitch, [{ num: 2, active: true }, { num: 3, active: false }])).toBeNull();
  });

  it("clears if the confirmed account was removed", () => {
    expect(activeSwitchNote(note, [{ num: 3, active: true }])).toBeNull();
  });

  it("does not discard a confirmation when the roster is unavailable", () => {
    expect(activeSwitchNote(note, undefined)).toBe(note);
  });

  it("reconciles only when fresh account data arrives, so a successful POST can finish first", () => {
    const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
    expect(panel).toMatch(/useEffect\(\(\) => \{\s*if \(!data\?\.ok \|\| !data\.accounts\) return;\s*setSwitched\(previous => activeSwitchNote\(previous, data\.accounts\)\);\s*\}, \[data\]\)/);
  });
});
