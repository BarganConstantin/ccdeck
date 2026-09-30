// "Start at login" on Linux (#1781).
//
// Electron's app.setLoginItemSettings and getLoginItemSettings exist on macOS
// and Windows only: on Linux the first does nothing and the second always says
// openAtLogin: false. The app called them on every platform — for the tray's
// checkbox, its click and the first-run answer — so on Linux the box was
// always drawn unchecked, ticking it did nothing, and the first run's "Start
// ccdeck when I log in" registered nothing. And "Replace it with the app"
// deleted the npm deck's systemd unit FIRST and then made that no-op call, so
// from the next login nothing started at all.
//
// login-item.mjs now owns it: an XDG autostart entry on Linux, Electron's own
// call elsewhere, and the npm item taken away only once the app's own entry is
// in place and reads back as on. Every case here runs against a temporary
// config directory and a stand-in for Electron's app; nothing reaches the real
// ~/.config or the real login items.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { AUTOSTART_FILE, autostartEntry, openAtLogin, replaceNpmLoginItem, setOpenAtLogin } from "../../../desktop/login-item.mjs";

const APPIMAGE = "/home/u/Applications/ccdeck-linux-x86_64.AppImage";

/** Electron's app as each platform has it: on Linux the pair is inert. */
function fakeApp(platform: string) {
  let on = false;
  const calls: unknown[] = [];
  return {
    calls,
    setLoginItemSettings(s: { openAtLogin: boolean }) { calls.push(s); if (platform !== "linux") on = s.openAtLogin; },
    getLoginItemSettings() { return { openAtLogin: platform === "linux" ? false : on }; },
  };
}

const dirs: string[] = [];
function configHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-login-item-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) rmTempDir(dirs.pop()!); });

/** The Exec line of an entry, as a desktop reads it. */
const execOf = (text: string) => /^Exec=(.*)$/m.exec(text)?.[1];

describe("start at login on Linux", () => {
  it("writes an autostart entry that starts the AppImage, reads it back, and takes it away", () => {
    const home = configHome();
    const opts = { platform: "linux", configHome: home, execPath: "/tmp/.mount_ccdeckAbCdEf/ccdeck-desktop", env: { APPIMAGE }, app: fakeApp("linux") };
    const file = join(home, "autostart", AUTOSTART_FILE);
    expect(AUTOSTART_FILE).toBe("ccdeck-desktop.desktop");
    expect(openAtLogin(opts)).toBe(false);

    expect(setOpenAtLogin(true, opts)).toBe(true);
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith("[Desktop Entry]\n")).toBe(true);
    expect(text).toMatch(/^Type=Application$/m);
    // The AppImage's own path, never the mount it is running from: that one is
    // gone by the next login.
    expect(execOf(text)).toBe(`"${APPIMAGE}"`);
    expect(openAtLogin(opts)).toBe(true);

    expect(setOpenAtLogin(false, opts)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(openAtLogin(opts)).toBe(false);
  });

  it("starts the installed binary when the app is not an AppImage, quoted for the desktop", () => {
    const home = configHome();
    const opts = { platform: "linux", configHome: home, execPath: "/opt/My Apps/ccdeck/ccdeck-desktop", env: {}, app: fakeApp("linux") };
    expect(setOpenAtLogin(true, opts)).toBe(true);
    expect(execOf(readFileSync(join(home, "autostart", AUTOSTART_FILE), "utf8"))).toBe('"/opt/My Apps/ccdeck/ccdeck-desktop"');
  });

  it("escapes what the Desktop Entry spec reserves inside a quoted Exec argument", () => {
    // Quote-level first (" ` $ \ take a backslash), then the string-level
    // escape doubles every backslash; % is a field code and is doubled.
    expect(execOf(autostartEntry({ exec: '/a "b" $c `d` \\e 100%' }))).toBe('"/a \\\\"b\\\\" \\\\$c \\\\`d\\\\` \\\\\\\\e 100%%"');
  });

  it("finds the config directory through XDG_CONFIG_HOME when it is not handed one", () => {
    const home = configHome();
    const opts = { platform: "linux", home: "/nonexistent-home", execPath: "/usr/bin/ccdeck-desktop", env: { XDG_CONFIG_HOME: home }, app: fakeApp("linux") };
    expect(setOpenAtLogin(true, opts)).toBe(true);
    expect(existsSync(join(home, "autostart", AUTOSTART_FILE))).toBe(true);
  });

  it("reads an entry the desktop has switched off as off", () => {
    const home = configHome();
    const opts = { platform: "linux", configHome: home, execPath: "/usr/bin/ccdeck-desktop", env: {}, app: fakeApp("linux") };
    expect(setOpenAtLogin(true, opts)).toBe(true);
    const file = join(home, "autostart", AUTOSTART_FILE);
    writeFileSync(file, readFileSync(file, "utf8").replace("X-GNOME-Autostart-enabled=true", "X-GNOME-Autostart-enabled=false"));
    expect(openAtLogin(opts)).toBe(false);
    writeFileSync(file, `${readFileSync(file, "utf8")}Hidden=true\n`.replace("X-GNOME-Autostart-enabled=false", "X-GNOME-Autostart-enabled=true"));
    expect(openAtLogin(opts)).toBe(false);
  });

  it("says so, rather than throwing, when the entry cannot be written", () => {
    const home = configHome();
    // A file where the autostart directory has to go.
    writeFileSync(join(home, "autostart"), "");
    const opts = { platform: "linux", configHome: home, execPath: "/usr/bin/ccdeck-desktop", env: {}, app: fakeApp("linux") };
    expect(setOpenAtLogin(true, opts)).toBe(false);
    expect(openAtLogin(opts)).toBe(false);
  });

  it("never asks Electron, whose answer on Linux is always no", () => {
    const home = configHome();
    const app = fakeApp("linux");
    setOpenAtLogin(true, { platform: "linux", configHome: home, execPath: "/usr/bin/ccdeck-desktop", env: {}, app });
    expect(app.calls).toEqual([]);
  });
});

describe("start at login on macOS and Windows", () => {
  for (const platform of ["darwin", "win32"]) {
    it(`is Electron's own login item on ${platform}, and writes no autostart entry`, () => {
      const home = configHome();
      const app = fakeApp(platform);
      const opts = { platform, configHome: home, execPath: "/Applications/ccdeck.app/Contents/MacOS/ccdeck", env: {}, app };
      expect(setOpenAtLogin(true, opts)).toBe(true);
      expect(app.calls).toEqual([{ openAtLogin: true }]);
      expect(openAtLogin(opts)).toBe(true);
      expect(existsSync(join(home, "autostart"))).toBe(false);
      expect(setOpenAtLogin(false, opts)).toBe(true);
      expect(openAtLogin(opts)).toBe(false);
    });
  }
});

describe("replacing the npm deck's login item", () => {
  it("never takes the npm item away when the app's own could not be set", () => {
    const calls: string[] = [];
    const out = replaceNpmLoginItem({
      registerApp: () => { calls.push("register"); return false; },
      uninstall: () => { calls.push("uninstall"); return { ok: true, existed: true, path: "/u/.config/systemd/user/ccdeck.service" }; },
    });
    expect(calls).toEqual(["register"]);
    expect(out.ok).toBe(false);
  });

  it("takes it away only after the app's own is in place", () => {
    const calls: string[] = [];
    const out = replaceNpmLoginItem({
      registerApp: () => { calls.push("register"); return true; },
      uninstall: () => { calls.push("uninstall"); return { ok: true, existed: true, path: "/u/.config/systemd/user/ccdeck.service" }; },
    });
    expect(calls).toEqual(["register", "uninstall"]);
    expect(out).toMatchObject({ ok: true, path: "/u/.config/systemd/user/ccdeck.service" });
  });

  it("ends with the app registered on Linux, and the unit gone, when both work", () => {
    // The whole of "Replace it with the app" as main.mjs runs it, on Linux.
    const home = configHome();
    const opts = { platform: "linux", configHome: home, execPath: "/usr/bin/ccdeck-desktop", env: { APPIMAGE }, app: fakeApp("linux") };
    let unitRemoved = false;
    const out = replaceNpmLoginItem({
      registerApp: () => setOpenAtLogin(true, opts),
      uninstall: () => { unitRemoved = true; return { ok: true, existed: true, path: "unit" }; },
    });
    expect(out.ok).toBe(true);
    expect(unitRemoved).toBe(true);
    expect(openAtLogin(opts)).toBe(true);
  });
});

describe("the app's wiring", () => {
  const desktop = (name: string) => readFileSync(fileURLToPath(new URL(`../../../desktop/${name}`, import.meta.url)), "utf8");
  const main = desktop("main.mjs");
  const fn = (name: string) => {
    const at = main.search(new RegExp(`(?:async )?function ${name}\\(`));
    expect(at, `${name} is gone or renamed`).toBeGreaterThan(-1);
    return main.slice(at, main.indexOf("\n}\n", at));
  };

  it("never asks Electron's login item directly, on any platform", () => {
    expect(main).not.toMatch(/app\.(?:set|get)LoginItemSettings\(/);
  });

  it("reads the checkbox, answers its click and the first run through login-item.mjs", () => {
    expect(fn("buildMenu")).toContain("openAtLogin: openAtLogin(loginItemOptions()),");
    expect(main).toMatch(/setOpenAtLogin: checked => \{[^\n]*setOpenAtLogin\(checked, loginItemOptions\(\)\)/);
    expect(fn("firstRun")).toContain("setOpenAtLogin(checkboxChecked, loginItemOptions())");
  });

  it("replaces the npm item through replaceNpmLoginItem, registering the app first", () => {
    const body = fn("offerToReplaceLoginItem");
    expect(body).toContain("replaceNpmLoginItem({");
    expect(body).toMatch(/registerApp: \(\) => setOpenAtLogin\(true, loginItemOptions\(\)\)/);
    // The unit and its record go only inside the step that runs after.
    const uninstall = body.indexOf("uninstall: () => {");
    expect(uninstall).toBeGreaterThan(-1);
    expect(body.indexOf("svc.uninstallService()")).toBeGreaterThan(uninstall);
    expect(body.indexOf("svc.writeServiceRecord(")).toBeGreaterThan(uninstall);
  });

  it("packs the module into the app", () => {
    expect(desktop("electron-builder.config.cjs")).toContain('"login-item.mjs"');
  });
});
