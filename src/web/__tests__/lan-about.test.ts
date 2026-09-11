// What a paired deck says about itself, and the one rule that decides how it is
// said: in words its owner uses, worked out on the machine it describes.
//
// Every platform is tested from every platform. The translation takes the
// kernel's numbers as parameters, so a Mac runner checks the Windows answer
// and a Linux runner checks the Mac one — which is the only way "works on all
// three" is something a suite can say rather than something it assumes.
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { aboutThisDeck, linuxPrettyName, openAbout, osLabel, readAbout, sealAbout } from "../../server/lan-about.mjs";

describe("the operating system, in the words its owner uses", () => {
  it("names a Mac by its macOS version rather than by its kernel", () => {
    // Darwin 25 is the release Apple shipped as macOS 26, to match the year —
    // the one jump in the sequence, and the version this deck was written on.
    expect(osLabel({ platform: "darwin", release: "25.5.0" })).toBe("macOS 26.5");
    expect(osLabel({ platform: "darwin", release: "25.0.0" })).toBe("macOS 26.0");
    expect(osLabel({ platform: "darwin", release: "24.6.0" })).toBe("macOS 15.6");
    expect(osLabel({ platform: "darwin", release: "20.1.0" })).toBe("macOS 11.1");
    expect(osLabel({ platform: "darwin", release: "19.6.0" })).toBe("macOS 10.15");
    expect(osLabel({ platform: "darwin", release: "" })).toBe("macOS");
  });

  it("tells Windows 11 from 10 by the build, which is all that differs", () => {
    expect(osLabel({ platform: "win32", release: "10.0.26100" })).toBe("Windows 11");
    expect(osLabel({ platform: "win32", release: "10.0.22000" })).toBe("Windows 11");
    expect(osLabel({ platform: "win32", release: "10.0.19045" })).toBe("Windows 10");
    expect(osLabel({ platform: "win32", release: "6.3.9600" })).toBe("Windows");
  });

  it("uses the distribution's own name on Linux, and says Linux without one", () => {
    expect(osLabel({ platform: "linux", release: "6.8.0-45-generic", prettyName: "Ubuntu 24.04.1 LTS" }))
      .toBe("Ubuntu 24.04.1 LTS");
    expect(osLabel({ platform: "linux", release: "6.8.0" })).toBe("Linux");
    expect(osLabel({ platform: "freebsd", release: "14.1" })).toBe("freebsd");
  });

  it("reads PRETTY_NAME, quoted or not, and falls back to the second file", () => {
    const files: Record<string, string> = {
      "/usr/lib/os-release": 'NAME="Fedora Linux"\nPRETTY_NAME="Fedora Linux 40 (Workstation Edition)"\n',
    };
    const read = (f: string) => {
      if (!(f in files)) throw new Error("ENOENT");
      return files[f];
    };
    expect(linuxPrettyName(read)).toBe("Fedora Linux 40 (Workstation Edition)");
    expect(linuxPrettyName(() => "PRETTY_NAME=Arch Linux\n")).toBe("Arch Linux");
    expect(linuxPrettyName(() => { throw new Error("ENOENT"); })).toBe("");
  });

  it("builds this deck's card without reading a Linux file on any other platform", () => {
    const read = () => { throw new Error("must not be read"); };
    expect(aboutThisDeck({ version: "3.21.0", platform: "win32", release: "10.0.26100", arch: "x64", read }))
      .toEqual({ version: "3.21.0", os: "Windows 11", arch: "x64" });
    expect(aboutThisDeck({ version: "3.21.0", platform: "darwin", release: "25.5.0", arch: "arm64", read }))
      .toEqual({ version: "3.21.0", os: "macOS 26.5", arch: "arm64" });
  });
});

describe("a card that came off the network", () => {
  it("keeps what is well-formed and drops the rest", () => {
    expect(readAbout({ version: "3.21.0", os: "macOS 26.5", arch: "arm64" }))
      .toEqual({ version: "3.21.0", os: "macOS 26.5", arch: "arm64" });
    // A version is a version and an arch is a word; anything else is null, and
    // a card with nothing left in it is no card.
    expect(readAbout({ version: "3.21.0; rm -rf /", os: 5, arch: "x 64" }))
      .toEqual(null);
    expect(readAbout({ version: "3.21.0", os: null })).toEqual({ version: "3.21.0", os: null, arch: null });
    for (const junk of [null, "3.21.0", 5, [], {}]) expect(readAbout(junk), JSON.stringify(junk)).toBeNull();
  });

  it("takes control characters out, because the name reaches a terminal too", () => {
    const esc = String.fromCharCode(27);
    const out = readAbout({ os: `macOS${esc}[2J 26.5`, version: "3.21.0" });
    expect(out?.os).toBe("macOS [2J 26.5");
    expect(out?.os).not.toContain(esc);
  });

  it("is bounded, so a peer cannot hand the panel a paragraph", () => {
    const out = readAbout({ os: "x".repeat(500), version: "1".repeat(100) });
    expect(out?.os).toHaveLength(48);
    expect(out?.version).toHaveLength(32);
  });
});

describe("the seal", () => {
  const key = randomBytes(32);
  const card = { version: "3.21.0", os: "Windows 11", arch: "x64" };

  it("opens for the connection and the direction it was sealed for", () => {
    const sealed = sealAbout(key, card, "aaa-aaa-aaa-aaa", "bbb-bbb-bbb-bbb");
    expect(JSON.stringify(sealed)).not.toContain("Windows");
    expect(openAbout(key, sealed, "aaa-aaa-aaa-aaa", "bbb-bbb-bbb-bbb")).toEqual(card);
  });

  it("does not open turned round, under another key, or when it is not a seal", () => {
    const sealed = sealAbout(key, card, "aaa-aaa-aaa-aaa", "bbb-bbb-bbb-bbb");
    // Bounced back at the deck that sent it, as if it were the other one's.
    expect(openAbout(key, sealed, "bbb-bbb-bbb-bbb", "aaa-aaa-aaa-aaa")).toBeNull();
    expect(openAbout(randomBytes(32), sealed, "aaa-aaa-aaa-aaa", "bbb-bbb-bbb-bbb")).toBeNull();
    for (const junk of [null, undefined, "sealed", 5, {}, { iv: "x", tag: "y", body: "z" }]) {
      expect(openAbout(key, junk, "aaa-aaa-aaa-aaa", "bbb-bbb-bbb-bbb"), String(junk)).toBeNull();
    }
  });

  it("seals nothing for a deck that has no card", () => {
    expect(sealAbout(key, null, "a", "b")).toBeNull();
  });
});
