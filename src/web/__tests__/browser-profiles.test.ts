// Browser Watch's profile discovery, which is one long claim about three
// operating systems' directory layouts and can therefore only be checked from a
// disk that is not this machine's.
//
// WHY EVERY CASE INJECTS BOTH THE PLATFORM AND THE FILESYSTEM. The failure this
// module exists to avoid is silent in the worst possible way: get a root wrong
// and `discoverProfiles` returns `[]`, which is also the correct answer for a
// laptop with no Chrome on it. There is no exception, no log line and no red
// pixel — the panel just says the user does not use a browser. A suite that ran
// against the real disk would be green on the author's Mac and prove nothing
// about the two platforms where the paths are spelled differently, and the one
// bug that matters most is precisely a Windows or Linux root that no macOS run
// can reach. So nothing here touches disk: the tree is a set of strings, the
// platform is an argument, and the macOS leg of CI checks the Windows layout as
// thoroughly as the Windows leg does.
//
// THE ONE ASYMMETRY WORTH STATING TWICE. macOS has no `User Data` level and
// Windows and Linux do (Arc excepted, which carries its own). Two describes
// below assert that in both directions, because inserting the level on macOS
// and dropping it on Windows are the same one-character-class mistake and both
// come back as an empty list.
//
// Plain node, no DOM: the module is four pure functions over an injected fs.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { CLAUDE_EXT_ID, browserRoots, discoverProfiles, hasExtension, profileDirs } from "../../server/browser-profiles.mjs";

type Root = { key: string; name: string; root: string };

const HOME_MAC = "/Users/dorin";
const HOME_WIN = "C:\\Users\\dorin";
const HOME_NIX = "/home/dorin";
const LOCAL_WIN = `${HOME_WIN}\\AppData\\Local`;
const SUPPORT = `${HOME_MAC}/Library/Application Support`;

/** The separator a path is written in — the same front-anchored question the
 *  module itself asks, so a Windows tree stays Windows-shaped on a Mac. */
const sepOf = (p: string) => (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(p) ? "\\" : "/");

/**
 * A filesystem made of strings.
 *
 * `readdirSync` deliberately answers in PLAIN LEXICOGRAPHIC ORDER, which is the
 * wrong order — it puts `Profile 10` between `Profile 1` and `Profile 2`. A real
 * readdir answers in whatever order the filesystem feels like, so a fake that
 * pre-sorted correctly would let the module's own sort be deleted without a
 * single case noticing.
 *
 * Missing entries throw ENOENT rather than answering empty, because that is what
 * node does and the module's `try` around it is a claim about the throw.
 */
function fakeFs(spec: { dirs?: string[]; files?: string[] } = {}) {
  const dirs = new Set(spec.dirs ?? []);
  const files = new Set(spec.files ?? []);
  // Every ancestor of a named path is a directory, so a test states the leaves
  // it cares about and nothing else.
  for (const p of [...dirs, ...files]) {
    const sep = sepOf(p);
    const parts = p.split(sep);
    for (let i = parts.length - 1; i > 1; i--) dirs.add(parts.slice(0, i).join(sep));
  }
  const enoent = (p: string) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  return {
    existsSync: (p: string) => dirs.has(String(p)) || files.has(String(p)),
    statSync: (p: string) => {
      const path = String(p);
      if (dirs.has(path)) return { isDirectory: () => true };
      if (files.has(path)) return { isDirectory: () => false };
      throw enoent(path);
    },
    readdirSync: (p: string) => {
      const dir = String(p);
      if (files.has(dir)) throw Object.assign(new Error(`ENOTDIR: ${dir}`), { code: "ENOTDIR" });
      if (!dirs.has(dir)) throw enoent(dir);
      const prefix = dir + sepOf(dir);
      const kids = new Set<string>();
      for (const q of [...dirs, ...files]) {
        if (q.startsWith(prefix)) kids.add(q.slice(prefix.length).split(sepOf(dir))[0]);
      }
      return [...kids].sort();
    },
  };
}

/** A profile that exists and has the extension unpacked into it. */
const withExt = (dir: string) => [dir, `${dir}${sepOf(dir)}Extensions${sepOf(dir)}${CLAUDE_EXT_ID}`];

const rootFor = (roots: Root[], key: string) => roots.find(r => r.key === key)?.root;

describe("the user-data roots this platform could have", () => {
  describe("macOS, where there is no User Data level at all", () => {
    const roots: Root[] = browserRoots("darwin", {}, HOME_MAC);

    it("puts Chrome's profiles directly under Application Support", () => {
      // The literal path, not a formula, because a formula is what got this
      // wrong: `.../Google/Chrome/User Data` is the Windows shape and finds
      // nothing on a Mac, without failing.
      expect(rootFor(roots, "chrome")).toBe(`${SUPPORT}/Google/Chrome`);
      expect(rootFor(roots, "brave")).toBe(`${SUPPORT}/BraveSoftware/Brave-Browser`);
      expect(rootFor(roots, "edge")).toBe(`${SUPPORT}/Microsoft Edge`);
      expect(rootFor(roots, "vivaldi")).toBe(`${SUPPORT}/Vivaldi`);
      expect(rootFor(roots, "chromium")).toBe(`${SUPPORT}/Chromium`);
    });

    it("carries no `User Data` segment anywhere except Arc", () => {
      // Stated as a sweep rather than per-browser so a root added later cannot
      // quietly arrive with the Windows shape copied off the row above it.
      for (const r of roots) {
        if (r.key === "arc") continue;
        expect(r.root, `${r.key} has a Windows-shaped root on macOS`).not.toContain("User Data");
      }
    });

    it("makes Arc the one exception, because Arc really does keep one", () => {
      expect(rootFor(roots, "arc")).toBe(`${SUPPORT}/Arc/User Data`);
    });

    it("knows the Beta and Canary channels, which sit beside Chrome rather than inside it", () => {
      expect(rootFor(roots, "chrome-beta")).toBe(`${SUPPORT}/Google/Chrome Beta`);
      expect(rootFor(roots, "chrome-canary")).toBe(`${SUPPORT}/Google/Chrome Canary`);
    });
  });

  describe("Windows, where every root ends in User Data", () => {
    const roots: Root[] = browserRoots("win32", { LOCALAPPDATA: LOCAL_WIN }, HOME_WIN);

    it("spells them with backslashes even though this test may be running on a Mac", () => {
      // node's `join` follows the host unless the module picks the flavour off
      // the platform argument. A forward-slashed Windows root would still open
      // on Windows, so only a check like this one can see the mistake at all.
      expect(rootFor(roots, "chrome")).toBe(`${LOCAL_WIN}\\Google\\Chrome\\User Data`);
      expect(rootFor(roots, "brave")).toBe(`${LOCAL_WIN}\\BraveSoftware\\Brave-Browser\\User Data`);
      expect(rootFor(roots, "chrome")).not.toContain("/");
    });

    it("puts Edge under Microsoft\\Edge, which is not how macOS spells it", () => {
      // One vendor, two layouts: `Microsoft Edge` with a space on macOS,
      // `Microsoft\Edge` as two segments here.
      expect(rootFor(roots, "edge")).toBe(`${LOCAL_WIN}\\Microsoft\\Edge\\User Data`);
    });

    it("spells Canary `Chrome SxS`, which is not how macOS spells it either", () => {
      // The same channel under two names: `Chrome Canary` in Application
      // Support, `Chrome SxS` here, after the side-by-side codename the Windows
      // installer has always used. Carrying the macOS spelling across would
      // list a root nothing is ever at, and this module's every failure looks
      // like a user who does not have that browser.
      expect(rootFor(roots, "chrome-canary")).toBe(`${LOCAL_WIN}\\Google\\Chrome SxS\\User Data`);
      expect(rootFor(roots, "chrome-canary")).not.toContain("Chrome Canary");
    });

    it("gives every root the User Data level, without exception", () => {
      expect(roots.length).toBeGreaterThan(0);
      for (const r of roots) {
        expect(r.root, `${r.key} is missing the User Data level`).toMatch(/\\User Data$/);
      }
    });

    it("falls back to AppData\\Local when LOCALAPPDATA is missing or blank", () => {
      // A broken login script leaves the variable empty; joining onto "" would
      // make every root relative to whatever directory the deck was started in.
      for (const env of [{}, { LOCALAPPDATA: "" }, { LOCALAPPDATA: "   " }]) {
        const fallback: Root[] = browserRoots("win32", env, HOME_WIN);
        expect(rootFor(fallback, "chrome")).toBe(`${HOME_WIN}\\AppData\\Local\\Google\\Chrome\\User Data`);
      }
    });

    it("follows LOCALAPPDATA onto a redirected profile", () => {
      const redirected = "D:\\Profiles\\dorin\\AppData\\Local";
      const roots2: Root[] = browserRoots("win32", { LOCALAPPDATA: redirected }, HOME_WIN);
      expect(rootFor(roots2, "chrome")).toBe(`${redirected}\\Google\\Chrome\\User Data`);
    });
  });

  describe("Linux, where the roots are XDG config directories", () => {
    const roots: Root[] = browserRoots("linux", {}, HOME_NIX);

    it("uses the browsers' own lowercase directory names under ~/.config", () => {
      expect(rootFor(roots, "chrome")).toBe(`${HOME_NIX}/.config/google-chrome`);
      expect(rootFor(roots, "chrome-beta")).toBe(`${HOME_NIX}/.config/google-chrome-beta`);
      expect(rootFor(roots, "chromium")).toBe(`${HOME_NIX}/.config/chromium`);
      expect(rootFor(roots, "edge")).toBe(`${HOME_NIX}/.config/microsoft-edge`);
      expect(rootFor(roots, "vivaldi")).toBe(`${HOME_NIX}/.config/vivaldi`);
      // Brave is the one that keeps its vendor directory, capitalised.
      expect(rootFor(roots, "brave")).toBe(`${HOME_NIX}/.config/BraveSoftware/Brave-Browser`);
    });

    it("has no User Data level either, and no Application Support", () => {
      for (const r of roots) {
        expect(r.root, `${r.key} borrowed another platform's layout`).not.toContain("User Data");
        expect(r.root).not.toContain("Application Support");
      }
    });

    it("reaches the snap and flatpak confinements, which are not under ~/.config", () => {
      // On a default Ubuntu, `chromium` is a snap-only transitional package, so
      // the XDG chromium root is empty on exactly the machines that have
      // Chromium. Missing these is a whole distro's worth of nothing found.
      expect(rootFor(roots, "chromium-snap")).toBe(`${HOME_NIX}/snap/chromium/common/chromium`);
      expect(rootFor(roots, "brave-flatpak"))
        .toBe(`${HOME_NIX}/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser`);
    });

    it("honours XDG_CONFIG_HOME for the unconfined roots and not for the sandboxes", () => {
      // Chromium reads the variable, so this module has to; the snap and the
      // flatpak have their own private filesystems and do not.
      const xdg: Root[] = browserRoots("linux", { XDG_CONFIG_HOME: "/mnt/cfg" }, HOME_NIX);
      expect(rootFor(xdg, "chrome")).toBe("/mnt/cfg/google-chrome");
      expect(rootFor(xdg, "chromium-snap")).toBe(`${HOME_NIX}/snap/chromium/common/chromium`);
      // Empty is a shell accident, not a request to read the current directory.
      const blank: Root[] = browserRoots("linux", { XDG_CONFIG_HOME: "  " }, HOME_NIX);
      expect(rootFor(blank, "chrome")).toBe(`${HOME_NIX}/.config/google-chrome`);
    });

    it("gives an unknown POSIX platform the XDG layout rather than nothing", () => {
      // A deck on FreeBSD has a Chromium package that uses these exact paths.
      // Answering with an empty table would be the silent no all over again.
      expect(rootFor(browserRoots("freebsd", {}, HOME_NIX), "chromium")).toBe(`${HOME_NIX}/.config/chromium`);
    });
  });

  describe("the shape of the table itself", () => {
    for (const platform of ["darwin", "win32", "linux"]) {
      it(`answers ${platform} with absolute, uniquely keyed, named roots`, () => {
        const home = platform === "win32" ? HOME_WIN : HOME_NIX;
        const roots: Root[] = browserRoots(platform, {}, home);
        expect(roots.length).toBeGreaterThanOrEqual(6);
        expect(new Set(roots.map(r => r.key)).size).toBe(roots.length);
        for (const r of roots) {
          expect(r.root.startsWith(home), `${r.key} is not under the given home`).toBe(true);
          // A key is for code, a name is for a person. Neither may be the other.
          expect(r.key).toMatch(/^[a-z][a-z0-9-]*$/);
          expect(r.name.length).toBeGreaterThan(0);
        }
      });
    }

    it("asks the disk nothing, so a root is listed whether or not it exists", () => {
      // The point of the split: "which browsers could be here" is a table, and
      // only "which are" needs a filesystem. A machine with no Chrome still gets
      // the Chrome row, which is what lets the panel say it looked.
      const roots: Root[] = browserRoots("darwin", {}, "/nonexistent/home");
      expect(roots.some(r => r.key === "chrome")).toBe(true);
    });
  });
});

describe("the profile directories inside a root", () => {
  const ROOT = `${SUPPORT}/Google/Chrome`;

  it("finds Default and every numbered profile that is really there", () => {
    const fs = fakeFs({ dirs: [`${ROOT}/Default`, `${ROOT}/Profile 1`, `${ROOT}/Profile 3`] });
    expect(profileDirs(ROOT, fs)).toEqual([
      `${ROOT}/Default`, `${ROOT}/Profile 1`, `${ROOT}/Profile 3`,
    ]);
  });

  it("orders Profile 10 after Profile 9, which alphabetical order does not", () => {
    // The whole reason the sort is numeric. A plain `.sort()` — and the fake
    // readdir above answers in exactly that order — would hand back
    // `Profile 1, Profile 10, Profile 2, Profile 9`.
    const fs = fakeFs({
      dirs: ["Default", "Profile 1", "Profile 2", "Profile 9", "Profile 10", "Profile 11"]
        .map(n => `${ROOT}/${n}`),
    });
    expect(profileDirs(ROOT, fs)).toEqual([
      `${ROOT}/Default`, `${ROOT}/Profile 1`, `${ROOT}/Profile 2`,
      `${ROOT}/Profile 9`, `${ROOT}/Profile 10`, `${ROOT}/Profile 11`,
    ]);
  });

  it("answers empty for a root that exists with nothing in it", () => {
    // The ordinary state of half the roots on a real machine: installed once,
    // never opened, or left behind by an uninstall.
    expect(profileDirs(ROOT, fakeFs({ dirs: [ROOT] }))).toEqual([]);
  });

  it("answers empty for a root that is not there at all, rather than throwing", () => {
    // Five of the eight roots miss on any given machine, and a throw from the
    // first would take the other seven browsers down with it.
    expect(profileDirs(ROOT, fakeFs())).toEqual([]);
    expect(profileDirs(`${SUPPORT}/Vivaldi`, fakeFs({ dirs: [`${ROOT}/Default`] }))).toEqual([]);
  });

  it("ignores Guest Profile, System Profile and anything else that is not a profile", () => {
    // `System Profile` exists on every Chrome install before the user has opened
    // a window, and its History never gets a row — two permanently empty entries
    // on the panel of every machine in the world.
    const fs = fakeFs({
      dirs: [
        `${ROOT}/Default`, `${ROOT}/Guest Profile`, `${ROOT}/System Profile`,
        `${ROOT}/Crashpad`, `${ROOT}/ShaderCache`, `${ROOT}/Profile`, `${ROOT}/Profile X`,
      ],
    });
    expect(profileDirs(ROOT, fs)).toEqual([`${ROOT}/Default`]);
  });

  it("rejects a Default that is a file rather than a directory", () => {
    // A sync tool or a restored backup can leave one, and a row for it would
    // send the History reader at a path it can never open.
    const fs = fakeFs({ dirs: [ROOT, `${ROOT}/Profile 1`], files: [`${ROOT}/Default`] });
    expect(profileDirs(ROOT, fs)).toEqual([`${ROOT}/Profile 1`]);
  });

  it("joins with backslashes for a Windows root, on whichever OS is running this", () => {
    // A mixed `C:\...\User Data/Default` opens fine on Windows and so would
    // never be reported by a user; it only breaks the basename this module
    // takes of it. See the `profile` case further down.
    const root = `${LOCAL_WIN}\\Google\\Chrome\\User Data`;
    const fs = fakeFs({ dirs: [`${root}\\Default`, `${root}\\Profile 1`] });
    expect(profileDirs(root, fs)).toEqual([`${root}\\Default`, `${root}\\Profile 1`]);
    for (const dir of profileDirs(root, fs) as string[]) expect(dir).not.toContain("/");
  });
});

describe("whether a profile carries the Claude extension", () => {
  const DIR = `${SUPPORT}/Google/Chrome/Default`;

  it("is the id everything else in the feature keys on", () => {
    // Pinned as a literal: the id is derived from the packing key, so it is the
    // same 32 characters in Chrome, Brave, Edge and Vivaldi alike, and a typo
    // here reads as "nobody has the extension" on every machine at once.
    expect(CLAUDE_EXT_ID).toBe("fcoeoabgfenejglbffodgkkbkcdhcgfn");
  });

  it("says yes when Extensions/<id> is unpacked into the profile", () => {
    expect(hasExtension(DIR, CLAUDE_EXT_ID, fakeFs({ dirs: withExt(DIR) }))).toBe(true);
  });

  it("says no for a profile that has other extensions but not this one", () => {
    const other = `${DIR}/Extensions/aapbdbdomjkkjkaonfhkkikfgjllcleb`;
    expect(hasExtension(DIR, CLAUDE_EXT_ID, fakeFs({ dirs: [DIR, other] }))).toBe(false);
  });

  it("says no for a profile with no Extensions directory at all", () => {
    expect(hasExtension(DIR, CLAUDE_EXT_ID, fakeFs({ dirs: [DIR] }))).toBe(false);
  });

  it("defaults to the Claude id, so callers do not restate it", () => {
    expect(hasExtension(DIR, undefined, fakeFs({ dirs: withExt(DIR) }))).toBe(true);
  });

  it("looks under a Windows profile with backslashes", () => {
    const dir = `${LOCAL_WIN}\\Google\\Chrome\\User Data\\Default`;
    const fs = fakeFs({ dirs: [dir, `${dir}\\Extensions\\${CLAUDE_EXT_ID}`] });
    expect(hasExtension(dir, CLAUDE_EXT_ID, fs)).toBe(true);
    // And the negative, so the case above cannot be passing on a fake that says
    // yes to everything.
    expect(hasExtension(`${dir}2`, CLAUDE_EXT_ID, fs)).toBe(false);
  });
});

describe("the composed answer the rest of Browser Watch consumes", () => {
  describe("this machine's own shape, as measured", () => {
    // Chrome and Brave with one profile each and the extension in both; Edge,
    // Vivaldi, Chromium and Arc present with no profile inside. Reproduced as a
    // fake so it is the same case on all three CI legs.
    //
    // Called from inside each case rather than once in the describe body. A
    // describe body runs at COLLECTION time, so a `discoverProfiles` that threw
    // — the shape a dropped guard around readdir takes — would fail the whole
    // file with no case name attached, and the one assertion written to catch it
    // would never get to say so.
    const discover = () => discoverProfiles("darwin", {}, HOME_MAC, fakeFs({
      dirs: [
        ...withExt(`${SUPPORT}/Google/Chrome/Default`),
        ...withExt(`${SUPPORT}/BraveSoftware/Brave-Browser/Default`),
        `${SUPPORT}/Microsoft Edge`, `${SUPPORT}/Vivaldi`,
        `${SUPPORT}/Chromium`, `${SUPPORT}/Arc/User Data`,
      ],
    }));

    it("reports exactly the two browsers that have a profile", () => {
      expect(discover().map((p: { browser: string }) => p.browser)).toEqual(["chrome", "brave"]);
    });

    it("gives each row the profile name, the directory and both file paths", () => {
      expect(discover()[0]).toEqual({
        browser: "chrome",
        name: "Google Chrome",
        profile: "Default",
        dir: `${SUPPORT}/Google/Chrome/Default`,
        historyPath: `${SUPPORT}/Google/Chrome/Default/History`,
        securePrefsPath: `${SUPPORT}/Google/Chrome/Default/Secure Preferences`,
        hasClaudeExt: true,
      });
    });

    it("does not invent a row for a root that exists with no profiles in it", () => {
      // Edge, Vivaldi, Chromium and Arc are all on this disk. A row for any of
      // them would point the History reader at a file that will never be there.
      const found = discover();
      for (const key of ["edge", "vivaldi", "chromium", "arc"]) {
        expect(found.some((p: { browser: string }) => p.browser === key), `${key} was reported`).toBe(false);
      }
    });
  });

  it("reports a profile WITHOUT the extension instead of dropping it", () => {
    // The sentence this whole panel exists to say: "you have Brave here and the
    // extension is not in it". Filtering these out would make an un-extended
    // browser look exactly like an absent one.
    const fs = fakeFs({
      dirs: [
        ...withExt(`${SUPPORT}/Google/Chrome/Default`),
        `${SUPPORT}/Google/Chrome/Profile 1`,
        `${SUPPORT}/BraveSoftware/Brave-Browser/Default`,
      ],
    });
    const found = discoverProfiles("darwin", {}, HOME_MAC, fs);
    expect(found.map((p: { browser: string; profile: string; hasClaudeExt: boolean }) =>
      [p.browser, p.profile, p.hasClaudeExt])).toEqual([
      ["chrome", "Default", true],
      ["chrome", "Profile 1", false],
      ["brave", "Default", false],
    ]);
  });

  it("finds a Windows install from a Mac, User Data level and all", () => {
    const chrome = `${LOCAL_WIN}\\Google\\Chrome\\User Data`;
    const fs = fakeFs({
      dirs: [...withExt(`${chrome}\\Default`), `${chrome}\\Profile 10`],
    });
    const found = discoverProfiles("win32", { LOCALAPPDATA: LOCAL_WIN }, HOME_WIN, fs);
    expect(found).toEqual([
      {
        browser: "chrome", name: "Google Chrome", profile: "Default",
        dir: `${chrome}\\Default`,
        historyPath: `${chrome}\\Default\\History`,
        securePrefsPath: `${chrome}\\Default\\Secure Preferences`,
        hasClaudeExt: true,
      },
      {
        browser: "chrome", name: "Google Chrome", profile: "Profile 10",
        dir: `${chrome}\\Profile 10`,
        historyPath: `${chrome}\\Profile 10\\History`,
        securePrefsPath: `${chrome}\\Profile 10\\Secure Preferences`,
        hasClaudeExt: false,
      },
    ]);
  });

  it("reads `Default` back out of a Windows path, which posix basename cannot", () => {
    // The mixed-separator trap stated on its own. If the row's paths were joined
    // with POSIX rules, `profile` would be the entire absolute path — and on a
    // real Windows machine everything would still open, so nothing would ever
    // report it.
    const chrome = `${LOCAL_WIN}\\Google\\Chrome\\User Data`;
    const fs = fakeFs({ dirs: [`${chrome}\\Default`] });
    const [row] = discoverProfiles("win32", { LOCALAPPDATA: LOCAL_WIN }, HOME_WIN, fs);
    expect(row.profile).toBe("Default");
    expect(row.dir).not.toContain("/");
    expect(row.historyPath).not.toContain("/");
  });

  it("finds a Linux install, including the snap Chromium under ~/snap", () => {
    const gc = `${HOME_NIX}/.config/google-chrome`;
    const snap = `${HOME_NIX}/snap/chromium/common/chromium`;
    const fs = fakeFs({ dirs: [...withExt(`${gc}/Default`), `${snap}/Default`] });
    const found = discoverProfiles("linux", {}, HOME_NIX, fs);
    expect(found.map((p: { browser: string; hasClaudeExt: boolean }) =>
      [p.browser, p.hasClaudeExt])).toEqual([["chrome", true], ["chromium-snap", false]]);
    expect(found[1].historyPath).toBe(`${snap}/Default/History`);
  });

  it("answers empty on a machine with no Chromium browser at all", () => {
    // The honest empty, which has to be reachable — it is the answer a bad root
    // table would also give, and the only defence is the positive cases above.
    expect(discoverProfiles("darwin", {}, HOME_MAC, fakeFs())).toEqual([]);
    expect(discoverProfiles("win32", { LOCALAPPDATA: LOCAL_WIN }, HOME_WIN, fakeFs())).toEqual([]);
    expect(discoverProfiles("linux", {}, HOME_NIX, fakeFs())).toEqual([]);
  });

  it("keeps browsers in the table's order and profiles in numeric order within one", () => {
    const gc = `${SUPPORT}/Google/Chrome`;
    const brave = `${SUPPORT}/BraveSoftware/Brave-Browser`;
    const fs = fakeFs({
      dirs: [`${brave}/Default`, `${gc}/Profile 10`, `${gc}/Profile 2`, `${gc}/Default`],
    });
    const found = discoverProfiles("darwin", {}, HOME_MAC, fs);
    expect(found.map((p: { browser: string; profile: string }) => `${p.browser}/${p.profile}`))
      .toEqual(["chrome/Default", "chrome/Profile 2", "chrome/Profile 10", "brave/Default"]);
  });
});
