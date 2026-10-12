// The git view and the deck's edges: the stripes that hold the panel toggles
// on either side of the window, and the dock that holds them on a phone. The
// view stands between them and never over one, so every toggle stays in sight
// and in reach while it is open; a toggle whose panel the view stands over
// closes the view and shows that panel, and is not drawn open meanwhile.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sourceOf } from "./client-source";
import { sheetParts } from "./sheet-source";
import { closeGitViewRequest, gitViewCovers, gitViewRequest, openGitViewRequest, yieldingColumnToggle } from "../git-view-request";

const own = sheetParts().find(([path]) => path === "styles/git-view.css")![1];
const view = sourceOf("components/GitView.tsx");
const app = sourceOf("App.tsx");
const undo = sourceOf("components/RearrangeUndo.tsx");
/** A rule of the view's own part of the sheet, outside any at-rule. */
const rule = (sel: string) => {
  const at = own.indexOf(`\n${sel} {`);
  expect(at, sel).toBeGreaterThan(-1);
  return own.slice(at, own.indexOf("}", at));
};

describe("where the view stands", () => {
  it("under the topbar, its right edge at the right stripe's inner edge", () => {
    const r = rule(".gv-wide");
    expect(r).toMatch(/top: var\(--gv-top, var\(--topbar-h\)\);/);
    expect(r).toMatch(/right: var\(--edge-w\);/);
    // The measured top is set only once there is a measure; the bar's height
    // stands in until then, never a number from an older bar.
    expect(view).toMatch(/\.\.\.\(box \? \{ "--gv-top": `\$\{box\.top\}px` \} : \{\}\),/);
  });

  it("as a full sheet, between the two stripes", () => {
    expect(rule(".gv-wide[data-sheet]")).toMatch(/left: var\(--edge-w\);\s*width: auto;\s*border-left: none;/);
  });

  it("on a phone, above the dock rather than under it", () => {
    expect(own).toMatch(/@media \(max-width: 640px\) \{[^}]*\}[^}]*\.gv-wide \{ bottom: calc\(var\(--dock-h\) \+ env\(safe-area-inset-bottom\)\); \}/);
  });

  it("takes its width, its cover and what it leaves in sight from the stripes, not the window's edge", () => {
    expect(view).toMatch(/const left = document\.querySelector\("\.edge-rail-left"\)\?\.getBoundingClientRect\(\);/);
    expect(view).toMatch(/const right = document\.querySelector\("\.edge-rail-right"\)\?\.getBoundingClientRect\(\);/);
    expect(view).toMatch(/end: right && right\.width > 0 \? right\.left : window\.innerWidth/);
    expect(view).toMatch(/const room = box \? end - box\.left : win;/);
    expect(view).toMatch(/const width = sheet \? end - \(box \? box\.start : 0\) : panelWidth\(/);
    expect(view).toMatch(/const cover = Math\.max\(0, width - \(box \? end - box\.right : detailShown \? 360 : 0\)\);/);
    expect(view).toMatch(/const cover = Math\.max\(0, w - \(chromeEdges\(\)\.end - rect\.right\)\);/);
    expect(view).not.toMatch(/window\.innerWidth - (w|rect)\b/);
  });
});

describe("the left column's toggles over a full sheet", () => {
  let width = 900;
  beforeEach(() => { width = 900; vi.stubGlobal("window", { get innerWidth() { return width; } }); });
  afterEach(() => { closeGitViewRequest("key"); vi.unstubAllGlobals(); });

  function column(open: boolean) {
    let value = open;
    return { toggle: () => { value = !value; }, now: () => value };
  }

  it("toggle as before while the view is closed", () => {
    const c = column(false);
    const press = yieldingColumnToggle(c.toggle, c.now(), "pointer");
    press();
    expect(c.now()).toBe(true);
  });

  it("toggle as before while the view stands beside the canvas, which leaves the column alone", () => {
    width = 1440;
    openGitViewRequest("pointer", { agentId: "s1" });
    const c = column(false);
    yieldingColumnToggle(c.toggle, c.now(), "pointer")();
    expect(c.now()).toBe(true);
    expect(gitViewRequest().open).toBe(true);
  });

  it("close the sheet and show the panel, opening it only if it was shut", () => {
    for (const was of [false, true]) {
      openGitViewRequest("pointer", { agentId: "s1" });
      const c = column(was);
      yieldingColumnToggle(c.toggle, c.now(), "pointer")();
      expect(gitViewRequest().open, `was ${was}`).toBe(false);
      expect(c.now(), `was ${was}`).toBe(true);
    }
  });

  it("close it the way they were asked: a key never animates", () => {
    openGitViewRequest("pointer", { agentId: "s1" });
    const c = column(false);
    yieldingColumnToggle(c.toggle, c.now(), "key")();
    expect(gitViewRequest()).toMatchObject({ open: false, how: "key" });
  });
});

describe("what the edges draw while the view is open", () => {
  let width = 1440;
  beforeEach(() => { width = 1440; vi.stubGlobal("window", { get innerWidth() { return width; } }); });
  afterEach(() => { closeGitViewRequest("key"); vi.unstubAllGlobals(); });

  it("knows which panels the view stands over: none closed, the rail's beside the canvas, all of them as a sheet", () => {
    expect(gitViewCovers()).toBe("none");
    openGitViewRequest("key", { agentId: "s1" });
    expect(gitViewCovers()).toBe("rail");
    width = 900;
    expect(gitViewCovers()).toBe("all");
    width = 390;
    expect(gitViewCovers()).toBe("all");
    closeGitViewRequest("key");
    expect(gitViewCovers()).toBe("none");
  });

  it("draws no panel open on its edge while it is out of sight under the view", () => {
    expect(app).toMatch(/const gitCovers = useGitViewCovers\(\);/);
    const rails = app.slice(app.indexOf("const rails = railItems({"), app.indexOf("});", app.indexOf("const rails = railItems({")));
    expect(rails).toMatch(/sessionListOpen: sessionListOpen && gitCovers !== "all",/);
    expect(rails).toMatch(/accountsPanelOpen: accountsPanelOpen && gitCovers !== "all",/);
    expect(rails).toMatch(/usagePanelOpen: usagePanelOpen && gitCovers === "none",/);
    expect(rails).toMatch(/machinePanelOpen: machinePanelOpen && gitCovers === "none",/);
  });

  it("sends the left column's buttons, keys and the queue's +N more through the same yield", () => {
    expect(app).toMatch(/sessionList: \{ pointer: yieldingColumnToggle\(toggleSessionList, sessionListOpen, "pointer"\), key: yieldingColumnToggle\(toggleSessionList, sessionListOpen, "key"\) \},/);
    expect(app).toMatch(/accounts: \{ pointer: yieldingColumnToggle\(toggleAccountsPanel, accountsPanelOpen, "pointer"\), key: yieldingColumnToggle\(toggleAccountsPanel, accountsPanelOpen, "key"\) \},/);
    expect(app).toMatch(/toggleSessionList: columnToggles\.sessionList\.pointer,/);
    expect(app).toMatch(/toggleAccountsPanel: columnToggles\.accounts\.pointer,/);
    expect(app).toMatch(/toggleSessionList: columnToggles\.sessionList\.key, toggleAccountsPanel: columnToggles\.accounts\.key,/);
    expect(app).toMatch(/if \(!sessionListOpen \|\| gitCovers === "all"\) columnToggles\.sessionList\.pointer\(\);/);
  });
});

describe("Re-arrange's Undo beside the view", () => {
  it("centres on the part of the canvas the view leaves, by the width it settles at", () => {
    expect(undo).toMatch(/const gitCover = useSyncExternalStore\(subscribeGitViewCover, gitViewCover, gitViewCover\);/);
    expect(undo).toMatch(/style=\{gitCover > 0 \? \{ right: gitCover \} : undefined\}/);
  });
});
