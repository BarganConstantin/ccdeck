// #1411: the accounts panel's `try again` dropped keyboard focus to <body>.
//
// It is the one control in the empty state a failed first load leaves behind,
// and it was the one control #518 left on `disabled={reloading}` — out of scope
// then, because with nothing else on screen a busy lock had nothing to protect
// it from. What the exclusion did not weigh is that disabling is itself the
// defect #518 measured: Chrome drops focus the moment the focused element
// becomes disabled, so an Enter on `try again` sent the keyboard to the top of
// the document before the request had even left. And when the roster did
// arrive, it replaced the button, so focus had nowhere to come back to.
//
// Measured in an isolated deck with the first load blocked, then let through:
// Tab to `try again`, Enter. On development `document.activeElement` is <body>
// while the request is out and after the roster has arrived. With this, it is
// the retry while the request is out and the header's ↻ once the roster is in.
//
// Both halves are what the rest of the panel already does, so both are read
// from the markup: the retry spreads the ↻'s own attributes, and a press that
// takes its own control away hands focus through rescueFocus, which only moves
// it when it was dropped.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { rescueSelectors } from "../panel-press";
import { withoutComments } from "./tsx-scan";

const panel = withoutComments(readFileSync(fileURLToPath(new URL("../components/AccountsPanel.tsx", import.meta.url)), "utf8"));
/** The retry's opening tag, from its class to the end of its handler. */
const retry = /<button type="button" className="ap-fix"[\s\S]*?>\s*\{reloading \? "trying…" : "try again"\}/.exec(panel)?.[0] ?? "";

describe("the empty state's retry keeps the keyboard in the panel (#1411)", () => {
  it("is found, so the cases below are about it", () => {
    expect(retry).not.toBe("");
  });

  it("does not disable itself while its reload is out", () => {
    expect(retry).not.toMatch(/\bdisabled=/);
    // The ↻'s attributes, with the same in-flight flag: busy and focusable
    // while the reload is its own.
    expect(retry).toMatch(/\{\.\.\.pressProps\("reload", reloading\)\}/);
  });

  it("hands focus to the panel's reload once the roster it brought in replaces it", () => {
    expect(retry).toMatch(/onClick=\{\(\) => load\(true\)\.then\(\(\) => rescueFocus\(null\)\)\}/);
    // No row to go back to — there was none — so the chain is the ↻ alone.
    expect(rescueSelectors(null)).toEqual([".accounts-panel .ap-refresh"]);
  });
});
