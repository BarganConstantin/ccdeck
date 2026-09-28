// The Projects report whose account left the store — and the one whose store
// could not be read for a poll (#1412).
//
// The panel used to notice a missing account in the middle of drawing the
// report: the render found no account, called setProjectsFor(null) and
// returned nothing. Setting state from a render is a second render React has
// to throw away, so the close became an effect, beside the ones that drop a ⋯
// menu or an issue popover whose account has gone.
//
// What must not change is that it CLOSES. Drawing nothing while the account is
// missing would look the same for one poll, and then reopen the report by
// itself on the next poll that found the account again — over whatever the
// reader had moved on to.
//
// #1412 is the other half. "Missing" was read off `data?.accounts ?? []`, so a
// poll that could not read the store — /api/claude-accounts answers with no
// roster at all while claude-swap rewrites it — counted as every account
// having left, and the report closed under the reader with focus on <body>.
// Only a roster that was read can say an account has gone now; through an
// unreadable poll the report stays, under the name it was opened with, and a
// real departure hands focus to the panel's reload.
//
// Checked in the isolated deck, report open on slot 2. Removed and restored:
// closed and stays closed, focus on the ↻ (development: on <body>). Store
// unreadable for a poll and then readable: the report stays open through both
// (development: closed after the first and never back).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountsSurface } from "./accounts-surface";

const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");
/** The effect that closes the report, from its guard to its dependencies. */
const effect = /useEffect\(\(\) => \{\s*if \(projectsFor == null[\s\S]*?\}, \[[^\]]*\]\);/.exec(panel)?.[0] ?? "";
/** Where the report is drawn, from its gate to the end of the IIFE. */
const site = (() => {
  const start = panel.indexOf("{projectsFor != null && (() => {");
  return start === -1 ? "" : panel.slice(start, panel.indexOf("})()}", start));
})();

describe("the Projects report whose account has gone", () => {
  it("is closed by an effect on the roster, not hidden for as long as the account is missing", () => {
    expect(effect).not.toBe("");
    expect(effect).toMatch(/data\.accounts\.some\(a => a\.num === projectsFor\.num\)\) return;\s*setProjectsFor\(null\);/);
    expect(effect).toMatch(/\}, \[data, projectsFor, rescueFocus\]\);$/);
  });

  it("hands focus to the panel's reload when it closes that way, since its row went with it", () => {
    expect(effect).toMatch(/setProjectsFor\(null\);\s*rescueFocus\(null\);/);
  });

  it("is drawn by a render that writes no state", () => {
    expect(site).toContain("<AccountProjectsModal");
    // The modal's own close is a callback it is handed, which runs on a press.
    expect(site.replace("onClose={() => setProjectsFor(null)}", "")).not.toMatch(/\bset[A-Z]\w*\(/);
  });

  it("has two closes in the whole accounts surface: the effect and the report's own", () => {
    expect(accountsSurface().match(/setProjectsFor\(null\)/g)).toHaveLength(2);
  });
});

describe("the Projects report through a poll that could not read the store (#1412)", () => {
  it("closes only on a roster that was read, never on the absence of one", () => {
    expect(effect).toMatch(/if \(projectsFor == null \|\| !data\?\.accounts \|\| /);
    // The old reading, which made no roster mean no accounts.
    expect(panel).not.toMatch(/\(data\?\.accounts \?\? \[\]\)\.some\(a => a\.num === projectsFor/);
  });

  it("stays drawn with no roster, under the name it was opened with", () => {
    expect(site).toMatch(/if \(data\?\.accounts && !a\) return null;/);
    expect(site).toMatch(/num=\{projectsFor\.num\}/);
    expect(site).toMatch(/name=\{a \? \(a\.alias \?\? a\.email \?\? `account \$\{a\.num\}`\) : projectsFor\.name\}/);
    // Which is why the opener hands the name in with the slot.
    expect(panel).toMatch(/setProjectsFor\(\{ num: a\.num, name: a\.alias \?\? a\.email \?\? `account \$\{a\.num\}` \}\)/);
  });
});
