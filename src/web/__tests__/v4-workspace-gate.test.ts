// V4 Workspace sits behind the Command Panel's gate, off by default. With the
// flag off nothing of it is drawn, claimed or named; a phone is the Board alone;
// no server change, no new pref.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sourceOf, WEB_DIR } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { StageDockSlot, StageNavigatorSlot } from "../components/StageSlots";
import { initialShell } from "../stage-shell";
import type { Stage } from "../use-stage";
import ViewSwitch from "../components/ViewSwitch";
import { statusViewFor } from "../status-hints";

const app = withoutComments(sourceOf("App.tsx"));

describe("with the Command Panel off", () => {
  it("the view switch is drawn only where Workspace is on offer, and never on a phone", () => {
    expect(app).toContain("{!phone && stage.workspaceOffered && <ViewSwitch");
  });

  it("the root carries data-view only in Workspace: the Board's root is the root it was", () => {
    expect(app).toContain('data-view={inWorkspace ? "workspace" : undefined}');
    expect(app).toContain('data-zoom={inWorkspace && stage.expanded ? "" : undefined}');
  });

  it("the chord is not available, so the window listener leaves it to the page", () => {
    expect(app).toContain("useMirroredRef({ available: stage.workspaceOffered, toggle: toggleView })");
    const stage = withoutComments(sourceOf("use-stage.ts"));
    expect(stage).toContain("const offered = workspaceOffered({ enabled, supported }, phone);");
  });

  it("the status bar and the key sheet name nothing of it", () => {
    expect(app).toContain('viewChord={stage.workspaceOffered ? (inWorkspace ? "board" : "workspace") : null}');
    const view = statusViewFor({ stageOpen: false, pane: null, onCard: false, zoomedOut: true, singleKeys: true, platform: "Linux", viewChord: null });
    expect(view.hints.map(h => h.word)).not.toContain("workspace");
  });

  it("the slots draw nothing, and the navigator is not drawn in Workspace", () => {
    const stage = { enabled: false, shell: initialShell(), workspace: false } as unknown as Stage;
    const props = { stage } as never;
    expect(renderToStaticMarkup(createElement(StageNavigatorSlot, props))).toBe("");
    expect(renderToStaticMarkup(createElement(StageDockSlot, props))).toBe("");
    const open = { enabled: true, workspace: true, shell: { ...initialShell(), phase: "open" } } as unknown as Stage;
    expect(renderToStaticMarkup(createElement(StageNavigatorSlot, { stage: open } as never))).toBe("");
  });

  it("the switch is two buttons that say which view is on, and tell how they were pressed", () => {
    const calls: Array<[string, string]> = [];
    const tree = ViewSwitch({ view: "board", onChange: (v, how) => calls.push([v, how]) }) as { props: { children: Array<{ props: Record<string, unknown> }> } };
    const [board, workspace] = tree.props.children;
    expect(board.props["aria-pressed"]).toBe(true);
    expect(workspace.props["aria-pressed"]).toBe(false);
    (workspace.props.onClick as (e: { detail: number }) => void)({ detail: 1 });
    (workspace.props.onClick as (e: { detail: number }) => void)({ detail: 0 });
    (board.props.onClick as (e: { detail: number }) => void)({ detail: 1 });
    expect(calls, "the view already on screen is not a change").toEqual([["workspace", "pointer"], ["workspace", "key"]]);
  });
});

describe("no new surface", () => {
  it("adds no pref and no route: the view is the browser's, in localStorage, and the server is untouched", () => {
    const useView = withoutComments(sourceOf("use-view.ts"));
    expect(useView).not.toMatch(/fetch\(|\/api\//);
    const stage = withoutComments(sourceOf("use-stage.ts"));
    const added = stage.split("\n").filter(l => /\/api\//.test(l));
    expect(added.every(l => /\/api\/prefs/.test(l))).toBe(true);
  });

  it("imports no stage code into the first-load modules", () => {
    for (const f of ["use-view.ts", "components/ViewSwitch.tsx"]) {
      const src = withoutComments(readFileSync(join(WEB_DIR, f), "utf8"));
      expect(src, f).not.toMatch(/from "(?:\.\.?\/)+(?:components\/terminal\/|use-stage|stage-shell|stage-geometry)/);
    }
  });

  it("writes the view where no sheet of the account can carry it", () => {
    let leaks = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "__tests__") walk(p); continue; }
        if (/account-ui-fields\.ts$/.test(p) && readFileSync(p, "utf8").includes("agent-dag.view")) leaks++;
      }
    };
    walk(WEB_DIR);
    expect(leaks).toBe(0);
  });
});
