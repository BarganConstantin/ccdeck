// The Projects report whose account left the store.
//
// The panel used to notice that in the middle of drawing the report: the
// render found no account, called setProjectsFor(null) and returned nothing.
// Setting state from a render is a second render React has to throw away, and
// it is the one write in the panel that did not happen in a handler or an
// effect. The close is an effect now, beside the ones that drop a ⋯ menu or an
// issue popover whose account has gone.
//
// What must not change is that it CLOSES. Drawing nothing while the account is
// missing would look the same for one poll, and then reopen the report by
// itself on the next poll that found the account again — over whatever the
// reader had moved on to. Checked in the isolated deck: the account removed
// and then restored, and the store unreadable for a poll and then readable,
// leave the report shut exactly as development does; the draw-nothing version
// reopens it on both returns.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { accountsSurface } from "./accounts-surface";

const panel = readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8");

describe("the Projects report whose account has gone", () => {
  it("is closed by an effect on the roster, not hidden for as long as the account is missing", () => {
    expect(panel).toMatch(
      /useEffect\(\(\) => \{\s*if \(projectsFor != null && !\(data\?\.accounts \?\? \[\]\)\.some\(a => a\.num === projectsFor\)\) setProjectsFor\(null\);\s*\}, \[data, projectsFor\]\);/,
    );
  });

  it("is drawn by a render that writes no state", () => {
    const start = panel.indexOf("{projectsFor != null && (() => {");
    expect(start).toBeGreaterThan(-1);
    const site = panel.slice(start, panel.indexOf("})()}", start));
    expect(site).toContain("<AccountProjectsModal");
    // The modal's own close is a callback it is handed, which runs on a press.
    expect(site.replace("onClose={() => setProjectsFor(null)}", "")).not.toMatch(/\bset[A-Z]\w*\(/);
  });

  it("has two closes in the whole accounts surface: the effect and the report's own", () => {
    expect(accountsSurface().match(/setProjectsFor\(null\)/g)).toHaveLength(2);
  });
});
