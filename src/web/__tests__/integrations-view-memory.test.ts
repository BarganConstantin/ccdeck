// What an integration panel keeps between one opening of its modal and the
// next (#2178, #2179): closing the modal unmounts the panel, and before this
// only the filters came back — the issue or merge request that was open, the
// search, both scrolls, Jira's sub-task rows and a merge request's section
// were gone. integrations/view-memory.ts keeps them per list for the page's
// life, and decides what a list shows on arrival; the hook that applies it
// (use-list-view.ts) and the panels are held to it here by their sources,
// since the suite has no DOM. The browser checks are in the QA runs.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  arrive, choose, enter, forgetViews, keepList, keepSearch, listKey, recallList, recallSearch, settle,
  type Drawn, type ViewState,
} from "../integrations/view-memory";

type Item = { id: string };
const same = (a: Item, b: Item) => a.id === b.id;
const rows = (ids: string[], complete = true): Drawn<Item> => ({ complete, has: item => ids.includes(item.id) });

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const source = (path: string) => strip(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

beforeEach(() => forgetViews());

describe("the memory", () => {
  it("is empty for a list never visited, and adds to what a list remembers", () => {
    const key = listKey("gitlab:c1", "acme/web", "changes");
    expect(key).toBe("gitlab:c1|acme/web|changes");
    expect(recallList(key)).toBeNull();
    keepList<Item>(key, { selection: { id: "!5" } });
    keepList<Item>(key, { listTop: 340 });
    expect(recallList<Item>(key)).toEqual({ selection: { id: "!5" }, closed: false, listTop: 340, detailTop: 0, rows: {}, section: null });
  });

  it("keeps one memory per list: each project and tab, each board, All projects as its own", () => {
    keepList<Item>(listKey("gitlab:c1", "acme/web", "changes"), { selection: { id: "!5" } });
    keepList<Item>(listKey("gitlab:c1", "acme/web", "pipelines"), { selection: { id: "p9" } });
    keepList<Item>(listKey("gitlab:c1", null, "changes"), { selection: { id: "!7" } });
    keepList<string[]>(listKey("jira:j1", "12"), { selection: ["MOCK-10"] });
    expect(recallList<Item>("gitlab:c1|acme/web|changes")?.selection).toEqual({ id: "!5" });
    expect(recallList<Item>("gitlab:c1|acme/web|pipelines")?.selection).toEqual({ id: "p9" });
    expect(recallList<Item>("gitlab:c1|*|changes")?.selection).toEqual({ id: "!7" });
    expect(recallList<string[]>("jira:j1|12")?.selection).toEqual(["MOCK-10"]);
    expect(recallList("jira:j1|13")).toBeNull();
  });

  it("keeps the search per connection, an empty one as none", () => {
    keepSearch("jira:j1", "payment");
    expect(recallSearch("jira:j1")).toBe("payment");
    expect(recallSearch("gitlab:c1")).toBe("");
    keepSearch("jira:j1", "");
    expect(recallSearch("jira:j1")).toBe("");
  });

  it("forgets the oldest lists first past its bound, never growing without limit", () => {
    for (let i = 0; i < 200; i++) keepList(`gitlab:c1|r${i}|changes`, { listTop: i });
    expect(recallList("gitlab:c1|r0|changes")).toBeNull();
    expect(recallList("gitlab:c1|r199|changes")?.listTop).toBe(199);
  });

  it("lives in module memory only, so a reload or a restart starts fresh", () => {
    const src = source("integrations/view-memory.ts");
    expect(src).not.toMatch(/localStorage|sessionStorage|readStored|writeStored|indexedDB/);
  });
});

describe("arriving at a list", () => {
  const key = "gitlab:c1|acme/web|changes";

  it("puts the remembered item back with both scrolls when it is still in the list as drawn", () => {
    keepList<Item>(key, { selection: { id: "!5" }, listTop: 640, detailTop: 1200, section: "commits" });
    expect(arrive(recallList<Item>(key), rows(["!3", "!5"]))).toEqual({ kind: "restore", selection: { id: "!5" }, listTop: 640, detailTop: 1200 });
  });

  it("waits while the rows that could hold it are still being read", () => {
    keepList<Item>(key, { selection: { id: "!5" } });
    expect(arrive(recallList<Item>(key), rows(["!3"], false))).toEqual({ kind: "wait" });
  });

  it("keeps a detail the reader closed closed, the list where it was", () => {
    keepList<Item>(key, { selection: null, closed: true, listTop: 300 });
    expect(arrive(recallList<Item>(key), rows(["!3", "!5"]))).toEqual({ kind: "none", listTop: 300 });
  });

  it("goes in, the first time, with nothing to wait for and the list at its top", () => {
    const fresh = enter<Item>(key, true);
    expect(fresh).toMatchObject({ selection: null, settled: true, plan: null });
  });

  it("starts another list's scroller at the top, and a remembered one where it was left", () => {
    expect(enter<Item>(key, false).plan).toEqual({ list: 0, detail: null });
    keepList<Item>(key, { closed: true, listTop: 300 });
    expect(enter<Item>(key, false).plan).toEqual({ list: 300, detail: null });
  });
});

describe("a list's view after arrival", () => {
  const key = "jira:j1|12";
  const sameTrail = (a: string[], b: string[]) => a[a.length - 1] === b[b.length - 1];
  const trailRows = (keys: string[], complete = true): Drawn<string[]> => ({ complete, has: trail => keys.includes(trail[0]) });

  it("reopens on the issue and its breadcrumb, quietly, once the board draws it", () => {
    keepList<string[]>(key, { selection: ["MOCK-10", "MOCK-11"], listTop: 420, detailTop: 900 });
    let view: ViewState<string[]> = enter(key, true);
    expect(view).toMatchObject({ selection: null, settled: false });
    view = settle(view, null);
    expect(view.settled).toBe(false);
    view = settle(view, trailRows(["MOCK-10"], false));
    expect(view).toMatchObject({ selection: ["MOCK-10", "MOCK-11"], auto: true, settled: true, plan: { list: 420, detail: 900 } });
  });

  it("leaves nothing open when the item is gone, once every row that could hold it is drawn", () => {
    keepList<string[]>(key, { selection: ["MOCK-99"], listTop: 420 });
    let view: ViewState<string[]> = enter(key, true);
    view = settle(view, trailRows(["MOCK-10"], false));
    expect(view.settled).toBe(false);
    view = settle(view, trailRows(["MOCK-10"]));
    expect(view).toMatchObject({ selection: null, settled: true, plan: { list: 0, detail: null } });
  });

  it("keeps the detail open while a live filter or search hides its row", () => {
    keepList<string[]>(key, { selection: ["MOCK-10"] });
    let view: ViewState<string[]> = settle(enter(key, true), trailRows(["MOCK-10"]));
    expect(view.selection).toEqual(["MOCK-10"]);
    const after = settle(view, trailRows(["MOCK-20"]));
    expect(after).toBe(view);
    view = choose(view, ["MOCK-20"], sameTrail);
    expect(settle(view, trailRows([]))).toBe(view);
  });

  it("remembers the reader's choice, and a detail they closed as closed", () => {
    let view: ViewState<string[]> = enter(key, true);
    view = choose(view, ["MOCK-20"], sameTrail);
    expect(view).toMatchObject({ selection: ["MOCK-20"], auto: false, settled: true });
    expect(recallList<string[]>(key)).toMatchObject({ selection: ["MOCK-20"], closed: false });
    view = choose(view, null, sameTrail);
    expect(recallList<string[]>(key)).toMatchObject({ selection: null, closed: true });
    expect(enter<string[]>(key, true)).toMatchObject({ selection: null, settled: true });
  });

  it("starts another item's page afresh, and keeps the page of the same one", () => {
    keepList<string[]>(key, { selection: ["MOCK-10"], detailTop: 700, section: "commits" });
    let view: ViewState<string[]> = settle(enter(key, true), trailRows(["MOCK-10"]));
    view = choose(view, ["MOCK-10"], sameTrail);
    expect(recallList<string[]>(key)).toMatchObject({ detailTop: 700, section: "commits" });
    choose(view, ["MOCK-20"], sameTrail);
    expect(recallList<string[]>(key)).toMatchObject({ detailTop: 0, section: null });
  });
});

describe("the hook that applies it", () => {
  const hook = source("integrations/use-list-view.ts");

  it("decides another list's view while rendering, so its item is never drawn beside the wrong rows", () => {
    expect(hook).toMatch(/if \(state\.key !== listKey\) \{\s*current = enter<S>\(listKey, false\);\s*setState\(current\);\s*\}/);
  });

  it("puts the scrolls back before the browser paints, after the item's own entrance", () => {
    expect(hook).toMatch(/const useBeforePaint = typeof window === "undefined" \? useEffect : useLayoutEffect;/);
    const plan = hook.indexOf("put(restoringDetail, DETAIL_SCROLLER, plan.detail)");
    const decide = hook.indexOf("const next = settle(current, drawn);");
    expect(plan).toBeGreaterThan(-1);
    expect(decide).toBeGreaterThan(plan);
  });

  it("records each scroll as the reader scrolls, but never one being put back", () => {
    expect(hook).toMatch(/box\.addEventListener\("scroll", onScroll, \{ capture: true, passive: true \}\)/);
    expect(hook).toMatch(/if \(!restoringDetail\.current\) keepList<S>\(latest\.current\.key, \{ detailTop: el\.scrollTop \}\)/);
    expect(hook).toMatch(/if \(!restoringList\.current\) keepList<S>\(latest\.current\.key, \{ listTop: el\.scrollTop \}\)/);
  });

  it("moves no focus and announces nothing of its own", () => {
    expect(hook).not.toMatch(/\.focus\(/);
    expect(hook).not.toMatch(/aria-live|role=|useFeatureUse|feature-use/);
  });

  it("stops putting a scroll back the moment the reader scrolls or presses", () => {
    expect(hook).toMatch(/const READER_INPUT = \["wheel", "pointerdown", "touchstart", "keydown"\] as const;/);
  });
});

describe("the panels", () => {
  const jira = source("components/JiraPanel.tsx");
  const forge = source("components/forge/ForgePanel.tsx");

  it("keep Jira's view per board: the trail, the sub-task rows, the search per connection", () => {
    expect(jira).toMatch(/const listKey = listKeyOf\(scope, board\);/);
    expect(jira).toMatch(/useListView<string\[\]>\(\{ listKey, drawn, same: sameIssue, root: rootRef, listScroller: "\.jr-list-scroll" \}\)/);
    expect(jira).toMatch(/useState\(\(\) => recallSearch\(scope\)\)/);
    expect(jira).toMatch(/keepList<string\[\]>\(listKey, \{ rows: next \}\)/);
    expect(jira).toMatch(/rowsOpen=\{rowsOpen\}\s*onToggleRow=\{toggleRow\}/);
    // A new board no longer clears what was open: that board has its own.
    expect(jira).not.toMatch(/setTrail/);
  });

  it("check the issue the trail began from against the board as drawn", () => {
    expect(jira).toMatch(/return \{ complete, has: trail => keys\.has\(trail\[0\]\) \};/);
  });

  it("keep a forge's view per project and tab, and a new tab still starts without the search", () => {
    expect(forge).toMatch(/const listKey = listKeyOf\(scope, view\.repo, view\.tab\);/);
    expect(forge).toMatch(/useListView<ForgeSelection>\(\{ listKey, drawn, same: sameSelection, root: panelRef, listScroller: LIST_SCROLLER \}\)/);
    expect(forge).toMatch(/const chooseTab = \(tab: ForgeTab\) => \{ setView\(\{ tab \}\); setQuery\(""\); \};/);
    expect(forge).toMatch(/useState\(\(\) => recallSearch\(scope\)\)/);
    expect(forge).not.toMatch(/setSelected/);
  });

  it("go through the reader's path only for the reader: a row or Close moves focus, an item put back does not", () => {
    // The forge's select() is the reader's (rows, links, Close) and the only
    // place focus moves for a selection; the view's own choice never calls it.
    expect(forge).toMatch(/const select = useCallback\(\(next: ForgeSelection \| null\) => \{[\s\S]*?choose\(next\);[\s\S]*?focusAfterSelect/);
    const detail = source("components/JiraIssueDetail.tsx");
    expect(detail).toMatch(/if \(!narrow \|\| !shownKey \|\| auto\) return;/);
    expect(jira).toMatch(/auto=\{view\.auto\}/);
  });

  it("let every forge tab say which rows it draws, folded groups left out", () => {
    for (const tab of ["BranchesTab", "ChangesTab", "PipelinesTab", "IssuesTab"]) {
      expect(source(`components/forge/${tab}.tsx`), tab).toMatch(/useReportRows\(drawn, phase !== "loading"\);/);
    }
    expect(source("components/forge/BranchesTab.tsx")).toMatch(/open\("branches-active", true\)[\s\S]*open\("branches-stale", false\)/);
    expect(source("components/forge/ChangesTab.tsx")).toMatch(/open\("reviews-waiting", true\)[\s\S]*open\("reviews-approved", false\)/);
  });

  it("open a merge request put back on the section it was left on", () => {
    const change = source("components/forge/ChangeDetail.tsx");
    expect(change).toMatch(/const kept = recallSection\(\);\s*return isSection\(kept\) \? kept : "overview";/);
    expect(change).toMatch(/const setSection = \(next: ChangeSection\) => \{ setSectionState\(next\); keepSection\(next\); \};/);
  });
});
