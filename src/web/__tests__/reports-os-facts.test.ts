// Which OS release, Linux distribution and WSL an install runs on (reports.mjs,
// os-version.mjs): three optional facts on every app event, each a fixed token
// or a yes, never a name the machine or its owner gave it.
//
// Every input is injected — the platform, the kernel's release, the os-release
// text, Omarchy's folder — so each platform's answer is checked on any runner.
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createReporter, distroToken, installFacts, osVersionToken, readDistro,
  // @ts-expect-error — plain JS module, no types
} from "../../server/reports.mjs";
// @ts-expect-error — plain JS module, no types
import { osReleaseFields, osVersionOf } from "../../server/os-version.mjs";
import { normalise } from "../../server/deck-prefs.mjs";
// @ts-expect-error — plain JS module, no types
import { createUsageDay } from "../../server/usage-day.mjs";

const SHAPE = /^[0-9A-Za-z.+_-]+$/;

const UBUNTU = [
  'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
  'NAME="Ubuntu"',
  'VERSION_ID="24.04"',
  'VERSION="24.04.1 LTS (Noble Numbat)"',
  "ID=ubuntu",
  "ID_LIKE=debian",
  'HOME_URL="https://www.ubuntu.com/"',
].join("\n");
const ARCH = ['NAME="Arch Linux"', 'PRETTY_NAME="Arch Linux"', "ID=arch", "BUILD_ID=rolling", "ANSI_COLOR=\"38;2;23;147;209\""].join("\n");
const FEDORA = ["NAME=\"Fedora Linux\"", "VERSION=\"41 (Workstation Edition)\"", "ID=fedora", "VERSION_ID=41", "VARIANT_ID=workstation"].join("\n");
const DEBIAN = ['PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"', 'NAME="Debian GNU/Linux"', 'VERSION_ID="12"', "ID=debian"].join("\n");

describe("the OS release, on macOS and Windows", () => {
  it("is the macOS major, as Apple numbers it", () => {
    expect(osVersionToken({ platform: "darwin", release: "24.6.0" })).toBe("macos-15");
    expect(osVersionToken({ platform: "darwin", release: "25.0.0" })).toBe("macos-26");
    expect(osVersionToken({ platform: "darwin", release: "25.5.0" })).toBe("macos-26");
    expect(osVersionToken({ platform: "darwin", release: "20.1.0" })).toBe("macos-11");
    expect(osVersionToken({ platform: "darwin", release: "19.6.0" })).toBe("macos-10");
  });

  it("tells Windows 11 from Windows 10 by the build", () => {
    expect(osVersionToken({ platform: "win32", release: "10.0.26100" })).toBe("windows-11");
    expect(osVersionToken({ platform: "win32", release: "10.0.22000" })).toBe("windows-11");
    expect(osVersionToken({ platform: "win32", release: "10.0.19045" })).toBe("windows-10");
  });

  it("is left out where it cannot be told, and on Linux, which says its distribution", () => {
    expect(osVersionToken({ platform: "darwin", release: "" })).toBeUndefined();
    expect(osVersionToken({ platform: "darwin", release: "4.1" })).toBeUndefined();
    expect(osVersionToken({ platform: "win32", release: "6.3.9600" })).toBeUndefined();
    expect(osVersionToken({ platform: "win32", release: "10.0" })).toBeUndefined();
    expect(osVersionToken({ platform: "linux", release: "6.8.0-45-generic" })).toBeUndefined();
    expect(osVersionToken({ platform: "freebsd", release: "14.1" })).toBeUndefined();
  });

  it("comes from the one translation the paired deck's card uses", () => {
    expect(osVersionOf({ platform: "darwin", release: "25.5.0" })).toEqual({ family: "macos", major: 26, minor: 5 });
    expect(osVersionOf({ platform: "darwin", release: "19.6.0" })).toEqual({ family: "macos", major: 10, minor: 15 });
    expect(osVersionOf({ platform: "win32", release: "10.0.26100" })).toEqual({ family: "windows", major: 11, minor: null });
    expect(osVersionOf({ platform: "linux", release: "6.8.0" })).toBeNull();
  });
});

describe("the Linux distribution", () => {
  it("is os-release's ID with its VERSION_ID, lowercased", () => {
    expect(distroToken({ osRelease: UBUNTU })).toBe("ubuntu-24.04");
    expect(distroToken({ osRelease: FEDORA })).toBe("fedora-41");
    expect(distroToken({ osRelease: DEBIAN })).toBe("debian-12");
    expect(distroToken({ osRelease: "ID=OpenSUSE-Tumbleweed\nVERSION_ID='20241101'" })).toBe("opensuse-tumbleweed-20241101");
  });

  it("is the ID alone when there is no VERSION_ID — Arch", () => {
    expect(distroToken({ osRelease: ARCH })).toBe("arch");
  });

  it("is omarchy when Omarchy's folder is there, or os-release names it", () => {
    expect(distroToken({ osRelease: ARCH, omarchy: true })).toBe("omarchy");
    expect(distroToken({ osRelease: "ID=omarchy\nVERSION_ID=3.1" })).toBe("omarchy");
    expect(distroToken({ osRelease: 'ID=arch\nPRETTY_NAME="Omarchy (Arch Linux)"' })).toBe("omarchy");
    expect(distroToken({ osRelease: "", omarchy: true })).toBe("omarchy");
  });

  it("sends only what is already token-shaped, and never the free-text names", () => {
    // An ID with a space in it, or nothing but punctuation: nothing at all.
    expect(distroToken({ osRelease: 'ID="my distro"\nVERSION_ID=1' })).toBeUndefined();
    expect(distroToken({ osRelease: "ID=/home/alice\nVERSION_ID=1" })).toBeUndefined();
    expect(distroToken({ osRelease: 'NAME="Ubuntu"\nVERSION_ID="24.04"' })).toBeUndefined();
    expect(distroToken({ osRelease: "" })).toBeUndefined();
    // A version that is not a token, or that would take it past 32: the ID alone.
    expect(distroToken({ osRelease: 'ID=ubuntu\nVERSION_ID="24.04 LTS"' })).toBe("ubuntu");
    expect(distroToken({ osRelease: `ID=ubuntu\nVERSION_ID=${"9".repeat(40)}` })).toBe("ubuntu");
    // An ID past the cap is not cut into something it is not.
    expect(distroToken({ osRelease: `ID=${"a".repeat(33)}` })).toBeUndefined();
    for (const text of [UBUNTU, ARCH, FEDORA, DEBIAN]) {
      const t = distroToken({ osRelease: text });
      expect(t).toMatch(SHAPE);
      expect(t.length).toBeLessThanOrEqual(32);
      expect(t).not.toMatch(/LTS|Numbat|GNU|Linux|http/);
    }
  });

  it("never throws on a file that is not os-release", () => {
    for (const text of [undefined, null, 42, "garbage\0\n==\n", "ID"]) {
      expect(() => distroToken({ osRelease: text })).not.toThrow();
    }
  });

  it("reads /etc/os-release, then /usr/lib/os-release, and Omarchy's folder under the home folder", () => {
    const files: Record<string, string> = { "/usr/lib/os-release": FEDORA };
    const read = (file: string) => {
      if (file in files) return files[file];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    const asked: string[] = [];
    const isDir = (path: string) => { asked.push(path); return false; };
    expect(readDistro({ read, isDir, home: "/home/alice" })).toBe("fedora-41");
    expect(asked).toEqual([join("/home/alice", ".local", "share", "omarchy")]);

    files["/etc/os-release"] = ARCH;
    expect(readDistro({ read, isDir, home: "/home/alice" })).toBe("arch");
    expect(readDistro({ read, isDir: () => true, home: "/home/alice" })).toBe("omarchy");
    // Nothing readable and no folder: nothing, and no throw.
    expect(readDistro({ read: () => { throw new Error("EACCES"); }, isDir: () => { throw new Error("EACCES"); }, home: "/x" })).toBeUndefined();
  });

  it("parses os-release's quoting", () => {
    expect(osReleaseFields('A="x \\"y\\""\nB=\'z\'\n# C=no\nD=bare\n\nE=')).toEqual({ A: 'x "y"', B: "z", D: "bare", E: "" });
  });
});

describe("the three facts on an install's facts", () => {
  const base = { version: "3.81.2", versions: { node: "22.18.0" }, env: {}, checkout: false, deviceId: "0123456789abcdef" };

  it("carries osVersion on macOS and Windows, and no distro or wsl there", () => {
    const mac = installFacts({ ...base, platform: "darwin", release: "25.5.0", distro: "ubuntu-24.04", wsl: true });
    expect(mac.osVersion).toBe("macos-26");
    expect(mac).not.toHaveProperty("distro");
    expect(mac).not.toHaveProperty("wsl");
    const win = installFacts({ ...base, platform: "win32", release: "10.0.22631" });
    expect(win.osVersion).toBe("windows-11");
  });

  it("carries the distro on Linux, and wsl only when it is true", () => {
    const linux = installFacts({ ...base, platform: "linux", release: "6.8.0", distro: "ubuntu-24.04", wsl: false });
    expect(linux.distro).toBe("ubuntu-24.04");
    expect(linux).not.toHaveProperty("osVersion");
    expect(linux).not.toHaveProperty("wsl");
    const wsl = installFacts({ ...base, platform: "linux", release: "5.15.167.4-microsoft-standard-WSL2", distro: "ubuntu-24.04", wsl: true });
    expect(wsl).toMatchObject({ distro: "ubuntu-24.04", wsl: true });
  });

  it("leaves out a distro that is not a token, rather than reshaping it", () => {
    expect(installFacts({ ...base, platform: "linux", distro: "Ubuntu 24.04 LTS" })).not.toHaveProperty("distro");
    expect(installFacts({ ...base, platform: "linux", distro: "x".repeat(33) })).not.toHaveProperty("distro");
    expect(installFacts({ ...base, platform: "linux", wsl: "yes" })).not.toHaveProperty("wsl");
  });

  it("never reads another platform's answer off this machine", () => {
    const other = process.platform === "darwin" ? "win32" : "darwin";
    const facts = installFacts({ ...base, platform: other });
    expect(facts).not.toHaveProperty("osVersion");
    expect(facts).not.toHaveProperty("distro");
    expect(facts).not.toHaveProperty("wsl");
  });

  it("reads this machine's own, token-shaped, when nothing is injected", () => {
    const facts = installFacts({ env: {} });
    for (const key of ["osVersion", "distro"]) {
      if (facts[key] !== undefined) expect(String(facts[key]), key).toMatch(SHAPE);
    }
    if (process.platform !== "linux") expect(facts).not.toHaveProperty("distro");
    if (facts.wsl !== undefined) expect(facts.wsl).toBe(true);
  });
});

describe("on the wire", () => {
  function harness() {
    let prefs = normalise({});
    const store = {
      current: () => prefs,
      update: async (mutate: (prev: typeof prefs) => Partial<typeof prefs> | undefined) => {
        prefs = normalise({ ...prefs, ...(mutate(prefs) ?? {}) });
        return prefs;
      },
    };
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = async (url: string, init: { body?: string }) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : {} });
      return { ok: true, status: 202, headers: { get: () => null } };
    };
    const reporter = createReporter({
      fetchImpl, now: () => new Date("2026-11-04T10:00:00Z"), prefs: store, env: {}, home: "/home/alice", ready: Promise.resolve(),
      facts: {
        version: "3.81.2", os: "linux", arch: "x64", channel: "npm", runtime: "node-22.18.0",
        distro: "ubuntu-24.04", wsl: true, deviceId: "0123456789abcdef",
      },
      usage: createUsageDay({ now: () => new Date("2026-11-04T10:00:00Z") }), setup: () => ({}), setupKnown: () => Promise.resolve(),
      firstRun: () => false,
    });
    return { reporter, calls };
  }

  it("rides on the events, and never on the ping or an error", async () => {
    const h = harness();
    await h.reporter.checkIn();
    const events = h.calls.filter(c => c.url.endsWith("/v1/app/events"));
    expect(events.map(e => e.body.kind)).toEqual(["install", "active"]);
    for (const e of events) expect(e.body).toMatchObject({ distro: "ubuntu-24.04", wsl: true });

    await h.reporter.ping();
    const ping = h.calls.find(c => c.url.endsWith("/v1/app/ping"))!;
    expect(Object.keys(ping.body)).toEqual(["installId"]);

    expect(await h.reporter.reportError("server", new Error("boom"))).toBe(true);
    const error = h.calls.find(c => c.url.endsWith("/v1/app/errors"))!;
    for (const key of ["osVersion", "distro", "wsl"]) expect(error.body).not.toHaveProperty(key);
  });
});
