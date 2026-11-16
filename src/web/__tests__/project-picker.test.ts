// The New session picker's projects (internal #106), as pure functions: what
// it offers and in what order, what a search keeps, how two folders of one
// name are told apart, and the short list it keeps of folders the reader
// chose or started in — bounded, one entry per folder, removable without
// touching anything on disk.
import { describe, expect, it } from "vitest";
import {
  FORGOTTEN_KEY, FORGOTTEN_MAX, RECENT_KEY, RECENT_MAX, looksRelative, matchProjects, pickerProjects, projectKey,
  projectPaths, readKept, readRecents, saveKept, typedFolder, withRecent, withoutRecent, type KeptProjects,
} from "../components/terminal/project-picker";
import type { ProjectChoice } from "../components/terminal/stage-model";

const memStore = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
};
const none: KeptProjects = { recents: [], forgotten: [] };
const p = (cwd: string, name: string, at?: number): ProjectChoice => ({ cwd, name, hue: 1, ...(at === undefined ? {} : { at }) });

describe("the folders it keeps", () => {
  it("puts a chosen folder first, once, and keeps no more than RECENT_MAX", () => {
    let kept = none;
    for (let i = 0; i < RECENT_MAX + 5; i += 1) kept = withRecent(kept, `/srv/p${i}`, i);
    expect(kept.recents).toHaveLength(RECENT_MAX);
    expect(kept.recents[0]).toEqual({ cwd: `/srv/p${RECENT_MAX + 4}`, at: RECENT_MAX + 4 });
    kept = withRecent(kept, "/srv/p10/", 100);
    expect(kept.recents.filter(r => r.cwd === "/srv/p10"), "one entry per folder, a trailing / or not").toEqual([{ cwd: "/srv/p10", at: 100 }]);
    expect(kept.recents[0].cwd).toBe("/srv/p10");
  });

  it("keeps only full paths", () => {
    expect(withRecent(none, "~/code", 1)).toBe(none);
    expect(withRecent(none, "code/app", 1)).toBe(none);
    expect(withRecent(none, "C:\\work\\app", 1).recents).toEqual([{ cwd: "C:\\work\\app", at: 1 }]);
  });

  it("removes a folder from the list and from the board's offer, and brings it back when chosen again", () => {
    let kept = withRecent(none, "/srv/a", 1);
    kept = withoutRecent(kept, "/srv/a");
    expect(kept).toEqual({ recents: [], forgotten: ["/srv/a"] });
    expect(pickerProjects([p("/srv/a", "a")], kept.recents, kept.forgotten)).toEqual([]);
    kept = withRecent(kept, "/srv/a", 2);
    expect(kept).toEqual({ recents: [{ cwd: "/srv/a", at: 2 }], forgotten: [] });
    let many = none;
    for (let i = 0; i < FORGOTTEN_MAX + 3; i += 1) many = withoutRecent(many, `/x/${i}`);
    expect(many.forgotten).toHaveLength(FORGOTTEN_MAX);
  });

  it("survives a reload, and reads what another version or a hand wrote without trusting it", () => {
    const store = memStore();
    saveKept(withRecent(withoutRecent(none, "/gone"), "/srv/a", 5), store);
    expect(readKept(store)).toEqual({ recents: [{ cwd: "/srv/a", at: 5 }], forgotten: ["/gone"] });
    store.setItem(RECENT_KEY, JSON.stringify([
      { cwd: "/srv/b", at: 1 }, { cwd: "/srv/b/", at: 3 }, { cwd: "rel", at: 9 }, { cwd: "/srv/c" }, "junk", null, { cwd: "/srv/d", at: 7 },
    ]));
    expect(readRecents(store)).toEqual([{ cwd: "/srv/d", at: 7 }, { cwd: "/srv/b", at: 1 }]);
    store.setItem(RECENT_KEY, "{not json");
    store.setItem(FORGOTTEN_KEY, JSON.stringify(["/ok", 3, "rel"]));
    expect(readKept(store)).toEqual({ recents: [], forgotten: ["/ok"] });
  });

  it("works with no storage at all, and with a storage that refuses to write", () => {
    expect(readKept(null)).toEqual(none);
    expect(() => saveKept(withRecent(none, "/srv/a", 1), null)).not.toThrow();
    const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceededError"); } };
    expect(() => saveKept(withRecent(none, "/srv/a", 1), full)).not.toThrow();
  });

  it("names one folder one way: trailing separators off, the root kept", () => {
    expect(projectKey("/srv/a///")).toBe("/srv/a");
    expect(projectKey("/")).toBe("/");
    expect(projectKey("C:\\work\\")).toBe("C:\\work");
    expect(projectKey("C:\\")).toBe("C:\\");
  });
});

describe("what it offers", () => {
  it("offers the board's folders and the kept ones, each once, the stage's own first, the rest newest first", () => {
    const board = [p("/srv/stage", "stage", 10), p("/srv/old", "old", 5), p("/srv/new", "new", 20)];
    const got = pickerProjects(board, [{ cwd: "/srv/kept", at: 15 }, { cwd: "/srv/old", at: 30 }], []);
    expect(got.map(x => x.cwd)).toEqual(["/srv/stage", "/srv/old", "/srv/new", "/srv/kept"]);
    expect(got.find(x => x.cwd === "/srv/kept")).toMatchObject({ name: "kept", at: 15 });
    expect(pickerProjects([], [{ cwd: "/srv/a", at: 1 }, { cwd: "/srv/b", at: 2 }]).map(x => x.cwd), "no board: newest first").toEqual(["/srv/b", "/srv/a"]);
    expect(pickerProjects([], [])).toEqual([]);
  });

  it("keeps what a search finds in a name or a path, names that start with it first", () => {
    const list = [p("/home/u/work/api", "api"), p("/home/u/personal/payments-api", "payments-api"), p("/home/u/api-tools/cli", "cli"), p("/srv/web", "web")];
    expect(matchProjects(list, "api").map(x => x.name)).toEqual(["api", "payments-api", "cli"]);
    expect(matchProjects(list, "work api").map(x => x.name), "every word, anywhere").toEqual(["api"]);
    expect(matchProjects(list, "API").map(x => x.name), "in any case").toEqual(["api", "payments-api", "cli"]);
    expect(matchProjects(list, "   ")).toBe(list);
    expect(matchProjects(list, "nothing-here")).toEqual([]);
  });

  it("offers a typed full path as itself, unless the list holds it already", () => {
    const list = [p("/srv/a", "a")];
    expect(typedFolder(list, "/srv/b/")).toMatchObject({ cwd: "/srv/b", name: "b" });
    expect(typedFolder(list, "/srv/a/")).toBeNull();
    expect(typedFolder(list, "srv")).toBeNull();
    expect(typedFolder(list, "C:\\work\\b")).toMatchObject({ cwd: "C:\\work\\b", name: "b" });
  });

  it("tells a path that is not full from a search", () => {
    for (const q of ["~", "~/code", "./api", "../web", ".\\api", "..\\web"]) expect(looksRelative(q), q).toBe(true);
    for (const q of ["api", "/srv/api", "C:\\api", ".hidden", "~name"]) expect(looksRelative(q), q).toBe(false);
  });

  it("shows two folders of one name with the folders that tell them apart, and a worktree as itself", () => {
    const list = [
      p("/home/u/personal/ccdeck", "ccdeck"),
      p("/home/u/work/ccdeck", "ccdeck"),
      p("/home/u/work/ccdeck/.claude/worktrees/fix-x", "fix-x"),
      p("/a/same/x/repo", "repo"),
      p("/b/same/x/repo", "repo"),
    ];
    const paths = projectPaths(list);
    expect(paths.get("/home/u/personal/ccdeck")).toBe("…/personal/ccdeck");
    expect(paths.get("/home/u/work/ccdeck")).toBe("…/work/ccdeck");
    expect(paths.get("/home/u/work/ccdeck/.claude/worktrees/fix-x")).toBe("…/worktrees/fix-x");
    expect(paths.get("/a/same/x/repo"), "as far back as they differ").toBe("/a/same/x/repo");
    expect(paths.get("/b/same/x/repo")).toBe("/b/same/x/repo");
    expect(new Set(list.map(x => paths.get(x.cwd))).size).toBe(list.length);
  });
});
