// The Linux AppImage's "Restart to update" (#1630).
//
// electron-updater restarted the app by spawning the new AppImage from inside
// the old process while it still ran. The child inherited every descriptor
// Chromium had opened without close-on-exec — its pak, ICU and V8 snapshot
// files — so the new app held the old version's mount open, the old AppImage
// never unmounted, and one more runtime and /tmp/.mount_ccdeck* were left
// behind per update. The app it started also came up with no tray icon.
//
// relaunch-linux.mjs replaces that restart. What is checked here is what the
// fix consists of: the script starts the new app only once the old pid is
// gone, it passes on none of what it inherited, and the new app does not
// start with the dying mount in its search paths. The scripts run for real,
// against a stand-in AppImage that reports what it was started with; they need
// bash and /dev/fd, which Windows does not have — and the AppImage is a Linux
// build only.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { RELAUNCH_SCRIPT, relaunchEnv, relaunchOnExit } from "../../../desktop/relaunch-linux.mjs";

const MOUNT = "/tmp/.mount_ccdeckAbCdEf";

describe("the environment the new version starts with", () => {
  it("drops the running AppImage's own variables and its mount from every search path", () => {
    const env = relaunchEnv({
      HOME: "/home/u",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      APPDIR: MOUNT,
      APPIMAGE: "/home/u/Applications/ccdeck-linux-x86_64.AppImage",
      ARGV0: "ccdeck-linux-x86_64.AppImage",
      OWD: "/home/u",
      APPIMAGE_SILENT_INSTALL: "true",
      PATH: `${MOUNT}:${MOUNT}/usr/sbin:/usr/local/bin:/usr/bin`,
      LD_LIBRARY_PATH: `${MOUNT}/usr/lib`,
      GSETTINGS_SCHEMA_DIR: `${MOUNT}/usr/share/glib-2.0/schemas`,
    });
    expect(env).toEqual({
      HOME: "/home/u",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      PATH: "/usr/local/bin:/usr/bin",
    });
  });

  it("drops older mounts of the same AppImage that earlier relaunches left in the lists", () => {
    // What an app seen after a few self-updates carried: its own mount, and
    // two from versions before it that no longer existed.
    const old1 = "/tmp/.mount_ccdeckaNAIMh", old2 = "/tmp/.mount_ccdeckNGdDEL";
    const env = relaunchEnv({
      APPDIR: MOUNT,
      XDG_DATA_DIRS: `${MOUNT}/usr/share/:${old1}/usr/share/:${old2}/usr/share/:/usr/share/ubuntu:/usr/share/`,
      LD_LIBRARY_PATH: `${MOUNT}/usr/lib:${old1}/usr/lib:${old2}/usr/lib`,
      GSETTINGS_SCHEMA_DIR: `${MOUNT}/usr/share/glib-2.0/schemas:${old1}/usr/share/glib-2.0/schemas:${old2}/usr/share/glib-2.0/schemas`,
      // Another AppImage's mount is not this one's to take out.
      PATH: `${MOUNT}:/tmp/.mount_OtherAXyZ12/usr/bin:/usr/bin`,
    });
    expect(env).toEqual({
      XDG_DATA_DIRS: "/usr/share/ubuntu:/usr/share/",
      PATH: "/tmp/.mount_OtherAXyZ12/usr/bin:/usr/bin",
    });
  });

  it("does not let XDG_DATA_DIRS grow by AppRun's share dirs on every update", () => {
    // AppRun appends these three each time it runs, so after two updates the
    // list carries them twice, behind the mount's own entry.
    const appended = "/usr/share/gnome:/usr/local/share/:/usr/share/";
    const env = relaunchEnv({
      APPDIR: MOUNT,
      XDG_DATA_DIRS: `${MOUNT}/usr/share/::/usr/share/ubuntu:${appended}:${appended}`,
    });
    expect(env.XDG_DATA_DIRS).toBe(`/usr/share/ubuntu:${appended}`);
  });

  it("keeps a path that only shares the mount's prefix", () => {
    const env = relaunchEnv({ APPDIR: MOUNT, PATH: `${MOUNT}:${MOUNT}Gh/bin:/usr/bin` });
    expect(env.PATH).toBe(`${MOUNT}Gh/bin:/usr/bin`);
  });

  it("changes nothing else, and does not touch the environment it was given", () => {
    const given = { APPDIR: MOUNT, PATH: `${MOUNT}:/usr/bin`, LANG: "ro_RO.UTF-8" };
    const env = relaunchEnv(given);
    expect(env).toEqual({ PATH: "/usr/bin", LANG: "ro_RO.UTF-8" });
    expect(given.PATH).toBe(`${MOUNT}:/usr/bin`);
  });
});

describe("the desktop bundle", () => {
  it("packages every module main.mjs loads", () => {
    // electron-builder packs an explicit list. A module imported but left off
    // it is an app that builds, passes the suite and fails to start.
    const desktop = fileURLToPath(new URL("../../../desktop/", import.meta.url));
    const require = createRequire(import.meta.url);
    const files: string[] = require("../../../desktop/electron-builder.config.cjs").files;
    const seen = new Set<string>();
    const visit = (name: string) => {
      if (seen.has(name)) return;
      seen.add(name);
      const source = readFileSync(join(desktop, name), "utf8");
      for (const m of source.matchAll(/(?:\bfrom\s*|\bimport\(\s*)["']\.\/([^"']+)["']/g)) visit(m[1]);
    };
    visit("main.mjs");
    expect(seen).toContain("relaunch-linux.mjs");
    for (const name of seen) expect(files, `${name} is loaded by the app but not packaged`).toContain(name);
  });
});

describe.skipIf(process.platform === "win32")("the relaunch script, run for real", () => {
  let dir = "";
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
    if (dir) rmTempDir(dir);
    dir = "";
  });

  /** A stand-in AppImage that writes down what it was started with. */
  function fakeAppImage() {
    dir = mkdtempSync(join(tmpdir(), "ccdeck-relaunch-"));
    const marker = join(dir, "started");
    const app = join(dir, "ccdeck-linux-x86_64.AppImage");
    writeFileSync(app, [
      "#!/usr/bin/env bash",
      "if { : <&3; } 2>/dev/null; then fd3=open; else fd3=closed; fi",
      `printf 'fd3=%s\\nAPPDIR=%s\\nPATH=%s\\n' "$fd3" "\${APPDIR-unset}" "$PATH" > '${marker}.tmp'`,
      `mv '${marker}.tmp' '${marker}'`,
      "",
    ].join("\n"));
    chmodSync(app, 0o755);
    return { app, marker };
  }

  /** A process standing in for the app that is quitting. */
  function oldApp() {
    const c = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(c);
    return c;
  }

  async function startedWith(marker: string) {
    for (let i = 0; i < 100; i++) {
      if (existsSync(marker)) return Object.fromEntries(readFileSync(marker, "utf8").trim().split("\n").map(l => l.split(/=(.*)/s).slice(0, 2)));
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error("the new app was never started");
  }

  it("starts the new version only after the old one has exited, without the old mount in its paths", async () => {
    const { app, marker } = fakeAppImage();
    const old = oldApp();
    const mount = join(dir, ".mount_ccdeckOld");
    relaunchOnExit({
      pid: old.pid,
      appImage: app,
      env: { ...process.env, APPDIR: mount, APPIMAGE: "/old/ccdeck.AppImage", PATH: `${mount}:${mount}/usr/sbin:${process.env.PATH}` },
    });

    await new Promise(r => setTimeout(r, 600));
    expect(existsSync(marker), "the new app started while the old one was still running").toBe(false);

    old.kill();
    const seen = await startedWith(marker);
    expect(seen.APPDIR).toBe("unset");
    expect(seen.PATH.split(":").filter(p => p.startsWith(mount))).toEqual([]);
  }, 15_000);

  it("hands the new version none of the descriptors it inherited", async () => {
    // The leak was a descriptor opened without close-on-exec. Node opens
    // everything close-on-exec, so an extra stdio slot stands in for one:
    // the spawned shell gets it as fd 3, as the updater's child got Chromium's.
    const { app, marker } = fakeAppImage();
    const held = join(dir, "icudtl.dat");
    writeFileSync(held, "old version's file");
    const fd = openSync(held, "r");
    try {
      // First, that the stand-in can see an inherited fd 3 at all.
      const direct = spawn(app, [], { stdio: ["ignore", "ignore", "ignore", fd] });
      children.push(direct);
      expect((await startedWith(marker)).fd3).toBe("open");
      rmSync(marker);

      const old = oldApp();
      const script = spawn("bash", ["-c", RELAUNCH_SCRIPT, "ccdeck-relaunch", String(old.pid), app], {
        stdio: ["ignore", "ignore", "ignore", fd],
      });
      children.push(script);
      old.kill();
      expect((await startedWith(marker)).fd3).toBe("closed");
    } finally {
      closeSync(fd);
    }
  }, 15_000);
});
