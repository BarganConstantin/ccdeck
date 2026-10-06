// Which git client, editor and terminal a machine has, per OS, from a faked
// filesystem: the hand-off buttons show a slot only when one of these answers,
// and the first found is the default until somebody picks another.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { CATALOGUE, SLOTS, chooseApp, detectApps } from "../../server/git-handoff-apps.mjs";

type Found = { id: string; slot: string; name: string; target: { kind: string; path: string } };

/** A machine that has exactly `paths`, and `dirs` listing what is in them. */
function machine(paths: string[], dirs: Record<string, string[]> = {}) {
  const have = new Set(paths);
  return {
    exists: async (p: string) => have.has(p),
    readdir: async (p: string) => {
      if (!(p in dirs)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return dirs[p];
    },
  };
}

const ids = (found: Found[], slot: string) => found.filter(a => a.slot === slot).map(a => a.id);
const pathOf = (found: Found[], id: string) => found.find(a => a.id === id)?.target.path;

describe("the catalogue", () => {
  it("has the three slots, each app in one, and unique ids", () => {
    expect(SLOTS).toEqual(["git", "editor", "terminal"]);
    const list = CATALOGUE as { id: string; slot: string }[];
    expect(new Set(list.map(a => a.id)).size).toBe(list.length);
    for (const a of list) expect(SLOTS).toContain(a.slot);
  });

  it("orders the git clients and editors the way the default is chosen", () => {
    const list = CATALOGUE as { id: string; slot: string }[];
    expect(list.filter(a => a.slot === "git").map(a => a.id))
      .toEqual(["fork", "tower", "sublime-merge", "gitkraken", "github-desktop", "lazygit"]);
    const editors = list.filter(a => a.slot === "editor").map(a => a.id);
    expect(editors.slice(0, 3)).toEqual(["vscode", "cursor", "zed"]);
    expect(editors[editors.length - 1]).toBe("sublime-text");
    expect(editors.slice(3, -1)).toEqual(["idea", "webstorm", "pycharm", "goland", "rider", "clion", "phpstorm", "rubymine", "rustrover"]);
  });
});

describe("macOS", () => {
  const home = "/Users/ada";
  it("finds bundles in either Applications folder and tools on PATH", async () => {
    const found: Found[] = await detectApps({
      platform: "darwin", home, env: { PATH: "/opt/homebrew/bin:/usr/bin" },
      ...machine([
        "/Applications/Fork.app",
        "/Applications/Sublime Merge.app",
        `${home}/Applications/Cursor.app`,
        "/Applications/IntelliJ IDEA CE.app",
        "/System/Applications/Utilities/Terminal.app",
        "/Applications/Ghostty.app",
        "/opt/homebrew/bin/lazygit",
      ]),
    });
    expect(ids(found, "git")).toEqual(["fork", "sublime-merge", "lazygit"]);
    expect(ids(found, "editor")).toEqual(["cursor", "idea"]);
    expect(ids(found, "terminal")).toEqual(["terminal", "ghostty"]);
    expect(pathOf(found, "cursor")).toBe(`${home}/Applications/Cursor.app`);
    expect(found.find(a => a.id === "cursor")?.target.kind).toBe("app");
    expect(pathOf(found, "lazygit")).toBe("/opt/homebrew/bin/lazygit");
  });

  it("has no Linux-only terminal and no Windows app", async () => {
    const found: Found[] = await detectApps({
      platform: "darwin", home, env: { PATH: "/usr/bin" },
      ...machine(["/usr/bin/konsole", "/usr/bin/x-terminal-emulator"]),
    });
    expect(found).toEqual([]);
  });
});

describe("Linux", () => {
  const home = "/home/ada";
  it("finds packages, snaps, Toolbox scripts and PATH entries", async () => {
    const found: Found[] = await detectApps({
      platform: "linux", home, env: { PATH: `${home}/.local/bin:/usr/bin` },
      ...machine([
        "/usr/share/code/bin/code",
        "/snap/bin/rider",
        `${home}/.local/share/JetBrains/Toolbox/scripts/idea`,
        "/usr/bin/smerge",
        `${home}/.local/bin/lazygit`,
        "/usr/bin/x-terminal-emulator",
        `${home}/.local/bin/kitty`,
      ]),
    });
    expect(ids(found, "git")).toEqual(["sublime-merge", "lazygit"]);
    expect(ids(found, "editor")).toEqual(["vscode", "idea", "rider"]);
    expect(ids(found, "terminal")).toEqual(["x-terminal-emulator", "kitty"]);
    expect(pathOf(found, "idea")).toBe(`${home}/.local/share/JetBrains/Toolbox/scripts/idea`);
    expect(pathOf(found, "kitty")).toBe(`${home}/.local/bin/kitty`);
    // Fork, Tower and GitHub Desktop have no Linux build.
    expect(ids(found, "git")).not.toContain("fork");
  });

  it("offers lazygit only when there is a terminal to run it in", async () => {
    const found: Found[] = await detectApps({
      platform: "linux", home, env: { PATH: "/usr/bin" },
      ...machine(["/usr/bin/lazygit"]),
    });
    expect(found).toEqual([]);
  });

  it("puts KDE's own terminal first after the system's alternative", async () => {
    const base = ["/usr/bin/gnome-terminal", "/usr/bin/konsole", "/usr/bin/alacritty"];
    const kde: Found[] = await detectApps({ platform: "linux", home, env: { PATH: "", XDG_CURRENT_DESKTOP: "KDE" }, ...machine(base) });
    expect(ids(kde, "terminal")).toEqual(["konsole", "gnome-terminal", "alacritty"]);
    const kdeAlt: Found[] = await detectApps({ platform: "linux", home, env: { PATH: "", XDG_CURRENT_DESKTOP: "KDE" }, ...machine([...base, "/usr/bin/x-terminal-emulator"]) });
    expect(ids(kdeAlt, "terminal")).toEqual(["x-terminal-emulator", "konsole", "gnome-terminal", "alacritty"]);
    const gnome: Found[] = await detectApps({ platform: "linux", home, env: { PATH: "", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, ...machine(base) });
    expect(ids(gnome, "terminal")).toEqual(["gnome-terminal", "konsole", "alacritty"]);
  });

  it("never looks in a relative PATH entry, which is the deck's own working folder", async () => {
    const found: Found[] = await detectApps({
      platform: "linux", home, env: { PATH: ".:bin:/usr/bin" },
      ...machine(["./code", "bin/code", "./kitty"]),
    });
    expect(found).toEqual([]);
  });
});

describe("Windows", () => {
  const env = {
    LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    SystemRoot: "C:\\Windows",
    PATH: "C:\\tools;.;C:\\Windows\\System32",
  };
  it("finds per-user and per-machine installs, the newest JetBrains version, and the alias", async () => {
    const found: Found[] = await detectApps({
      platform: "win32", home: "C:\\Users\\ada", env,
      ...machine([
        "C:\\Users\\ada\\AppData\\Local\\Fork\\Fork.exe",
        "C:\\Users\\ada\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
        "C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe",
        "C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.3\\bin\\idea64.exe",
        "C:\\Users\\ada\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe",
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "C:\\tools\\lazygit.exe",
      ], {
        "C:\\Program Files\\JetBrains": ["IntelliJ IDEA 2024.3", "IntelliJ IDEA 2025.2", "JetBrains Toolbox"],
      }),
    });
    expect(ids(found, "git")).toEqual(["fork", "lazygit"]);
    expect(ids(found, "editor")).toEqual(["vscode", "idea"]);
    expect(ids(found, "terminal")).toEqual(["windows-terminal", "powershell"]);
    expect(pathOf(found, "idea")).toBe("C:\\Program Files\\JetBrains\\IntelliJ IDEA 2025.2\\bin\\idea64.exe");
    expect(pathOf(found, "lazygit")).toBe("C:\\tools\\lazygit.exe");
  });

  it("falls back to a Toolbox script, and keeps lazygit without a terminal (it opens its own console)", async () => {
    const found: Found[] = await detectApps({
      platform: "win32", home: "C:\\Users\\ada", env: { ...env, SystemRoot: "" },
      ...machine([
        "C:\\Users\\ada\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\rider.cmd",
        "C:\\tools\\lazygit.exe",
      ]),
    });
    expect(ids(found, "editor")).toEqual(["rider"]);
    expect(pathOf(found, "rider")).toMatch(/scripts\\rider\.cmd$/);
    expect(ids(found, "git")).toEqual(["lazygit"]);
  });

  it("ignores a folder the environment does not name rather than guessing", async () => {
    const found: Found[] = await detectApps({ platform: "win32", home: "C:\\Users\\ada", env: { PATH: "" }, ...machine(["Fork\\Fork.exe"]) });
    expect(found).toEqual([]);
  });
});

describe("the choice", () => {
  const found = [
    { id: "fork", slot: "git" }, { id: "lazygit", slot: "git" },
    { id: "vscode", slot: "editor" }, { id: "zed", slot: "editor" },
  ];
  it("is the pick while that app is still here, else the first found", () => {
    expect(chooseApp(found, "editor", "zed").id).toBe("zed");
    expect(chooseApp(found, "editor", "").id).toBe("vscode");
    expect(chooseApp(found, "editor", "cursor").id).toBe("vscode");
    expect(chooseApp(found, "git", undefined).id).toBe("fork");
    expect(chooseApp(found, "terminal", "kitty")).toBeNull();
  });
});
