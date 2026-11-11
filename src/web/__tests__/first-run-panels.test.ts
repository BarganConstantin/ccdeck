// What a deck shows somebody who has never opened it.
//
// CHANGED ON PURPOSE (owner, 2026-11-11): a first run opens no panel. Accounts,
// Usage and the machine panel used to open on a fresh profile, and on a machine
// with nothing set up yet each opened on what was missing — "claude-swap isn't
// installed" on the left, "Quota unavailable" on the right — two failures
// before the first session. Each waits for its door now.
//
// The distinction the three share is unchanged in kind: `"1"` means somebody
// opened it and keeps it open, `"0"` means somebody closed it, and absent is
// nobody having said — which now reads as shut. A profile from before this
// change that never stored one of the three still has it open: boot pins it
// (storage.ts's settlePanelDefaults, run in storage.test.ts).
import { describe, it, expect } from "vitest";
import { clientText } from "./client-source";

// The machine and usage panels are decided in use-right-panels.ts and the
// accounts panel in use-left-column.ts. The rule is about the client, so it
// reads the client, comment-stripped. All matches are positive.
const app = clientText();

/** The one decision, spelled the one way, for each key that carries it. */
const SHUT_ON_FIRST_RUN = /return readStored\(KEY\) === "1";/;

const PANELS = [
  ["the machine panel", "MACHINE_PANEL_OPEN_KEY"],
  ["usage", "USAGE_PANEL_OPEN_KEY"],
  ["accounts", "ACCOUNTS_PANEL_OPEN_KEY"],
] as const;

describe("a first run opens no panel", () => {
  it.each(PANELS)("keeps %s shut when nobody has said otherwise", (_name, key) => {
    expect(app).toMatch(new RegExp(SHUT_ON_FIRST_RUN.source.replace("KEY", key)));
    expect(app).not.toMatch(new RegExp(`readStored\\(${key}\\);\\s*return stored === null \\? true`));
  });

  it("writes the answer down, so it survives a reload", () => {
    for (const [name, key] of PANELS) {
      expect(app, name).toMatch(new RegExp(`(?:setItem|writeStored)\\(${key}, [^)]*\\? "1" : "0"\\)`));
    }
  });

  it("sees three panels, so none of the above can pass on an empty set", () => {
    expect(PANELS).toHaveLength(3);
    for (const [, key] of PANELS) expect(app, key).toContain(key);
  });
});
