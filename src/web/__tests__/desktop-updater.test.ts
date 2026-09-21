// The desktop app's own macOS updater and the pieces around it (#1160).
//
// What is pinned is the chain of checks an update must pass before it replaces
// a running app, because each one is the only thing standing between a user
// and whatever a compromised download would install:
//
//   newer version → the manifest's size and SHA-256 → an Ed25519 signature by
//   ccdeck's update key → (on a Mac) the running app's designated requirement
//
// The last one needs codesign and a real bundle, and was exercised end to end
// on a Mac in the phase-0 spike: 3.25.3 updated itself to 3.25.4; a tampered
// signature and a foreign app signed with the right update key were both
// refused. What runs here is every check that can run anywhere.
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import { createRequire } from "node:module";
// @ts-expect-error — plain .mjs, no types
import { isNewer, pickFile, verifyZip, bundleOf, UPDATE_PUBLIC_KEY, checkForUpdate, SWAP_SCRIPT } from "../../../desktop/updater-mac.mjs";
// @ts-expect-error — plain .mjs, no types
import { signEntry } from "../../../desktop/scripts/sign-update.mjs";
// @ts-expect-error — plain .mjs, no types
import { inked, markPng, STATES } from "../../../desktop/scripts/icons.mjs";

const require = createRequire(import.meta.url);
const { requirementForLeaf } = require("../../../desktop/scripts/sign-mac.cjs");

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("which version is newer", () => {
  it("orders releases by number", () => {
    expect(isNewer("3.25.4", "3.25.3")).toBe(true);
    expect(isNewer("3.26.0", "3.25.9")).toBe(true);
    expect(isNewer("3.25.3", "3.25.4")).toBe(false);
    expect(isNewer("3.25.4", "3.25.4")).toBe(false);
  });

  it("ranks a release above its own prerelease", () => {
    expect(isNewer("3.25.4", "3.25.4-beta.1")).toBe(true);
    expect(isNewer("3.25.4-beta.1", "3.25.4")).toBe(false);
    expect(isNewer("3.25.4-beta.10", "3.25.4-beta.9")).toBe(true);
  });

  it("never treats something unparseable as newer", () => {
    // A manifest that cannot be read must not be able to talk the app into an
    // install.
    expect(isNewer("latest", "3.25.3")).toBe(false);
    expect(isNewer(undefined, "3.25.3")).toBe(false);
  });
});

describe("the download", () => {
  const bytes = Buffer.from("pretend this is a zip");

  it("passes when the size, the hash and the signature all match", () => {
    const { pub, priv } = keys();
    const entry = signEntry(bytes, { name: "ccdeck-3.25.4-mac.zip", arch: "arm64", keyPem: priv });
    expect(entry.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(verifyZip(bytes, entry, pub)).toBe(true);
  });

  it("fails when one byte changed on the way", () => {
    const { pub, priv } = keys();
    const entry = signEntry(bytes, { name: "z", arch: "x64", keyPem: priv });
    const altered = Buffer.from(bytes);
    altered[0] ^= 1;
    expect(verifyZip(altered, { ...entry, size: altered.length, sha256: createHash("sha256").update(altered).digest("hex") }, pub)).toBe(false);
  });

  it("fails when signed by any key but ccdeck's", () => {
    // The hash and size can be recomputed by whoever serves the file; only the
    // signature cannot.
    const theirs = keys(), ours = keys();
    const entry = signEntry(bytes, { name: "z", arch: "x64", keyPem: theirs.priv });
    expect(verifyZip(bytes, entry, ours.pub)).toBe(false);
  });

  it("fails on a wrong size or a garbage signature, without throwing", () => {
    const { pub, priv } = keys();
    const entry = signEntry(bytes, { name: "z", arch: "x64", keyPem: priv });
    expect(verifyZip(bytes, { ...entry, size: entry.size + 1 }, pub)).toBe(false);
    expect(verifyZip(bytes, { ...entry, signature: "not base64 at all!" }, pub)).toBe(false);
  });

  it("ships a real Ed25519 public key", () => {
    expect(UPDATE_PUBLIC_KEY).toMatch(/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----\n$/);
  });
});

describe("finding the update", () => {
  const manifest = {
    version: "3.25.4",
    files: [
      { arch: "arm64", url: "ccdeck-3.25.4-arm64-mac.zip", size: 1, sha256: "a", signature: "s" },
      { arch: "x64", url: "ccdeck-3.25.4-mac.zip", size: 1, sha256: "b", signature: "s" },
    ],
  };
  const fetchImpl = async () => ({ ok: true, json: async () => manifest });

  it("picks the file for this CPU and resolves it against the manifest", async () => {
    const u = await checkForUpdate({
      manifestUrl: "https://github.com/o/r/releases/latest/download/latest-mac.json",
      currentVersion: "3.25.3", arch: "arm64", fetchImpl,
    });
    expect(u.version).toBe("3.25.4");
    expect(u.url).toBe("https://github.com/o/r/releases/latest/download/ccdeck-3.25.4-arm64-mac.zip");
  });

  it("finds nothing when this version is current, or no file fits this CPU", async () => {
    expect(await checkForUpdate({ manifestUrl: "https://x/m.json", currentVersion: "3.25.4", arch: "x64", fetchImpl })).toBeNull();
    expect(pickFile(manifest, "ia32")).toBeNull();
  });

  it("finds the bundle from the executable's path", () => {
    expect(bundleOf("/Applications/ccdeck.app/Contents/MacOS/ccdeck")).toBe("/Applications/ccdeck.app");
  });

  it("swaps with every path as argv, never inside the script text", () => {
    // A bundle path with a space or a quote must be data to the shell.
    expect(SWAP_SCRIPT).not.toMatch(/\$\{|Applications/);
    expect(SWAP_SCRIPT).toContain('mv "$target" "$backup"');
  });
});

describe("the macOS signing requirement", () => {
  it("pins the app id and the certificate, not the build", () => {
    // An ad-hoc requirement is `cdhash H"…"`, a different app on every build;
    // this one is satisfied by every build signed with the same certificate.
    expect(requirementForLeaf("101d26314e1de3458ab863561d63937395792a34", "dev.ccdeck.app"))
      .toBe('identifier "dev.ccdeck.app" and certificate leaf = H"101d26314e1de3458ab863561d63937395792a34"');
  });
});

describe("the icons", () => {
  it("draws the favicon's four shapes", () => {
    expect(STATES).toEqual(["idle", "running", "waiting", "offline"]);
    // Centre: only running (dot) and waiting (disc) are inked.
    expect(inked("idle", 16, 16)).toBe(false);
    expect(inked("running", 16, 16)).toBe(true);
    expect(inked("waiting", 16, 16)).toBe(true);
    // On the ring at 3 o'clock every state but waiting's disc edge agrees.
    expect(inked("idle", 28, 16)).toBe(true);
    // Offline's gap is at the top.
    expect(inked("offline", 16, 4)).toBe(false);
    expect(inked("idle", 16, 4)).toBe(true);
  });

  it("writes a real PNG", () => {
    const png = markPng("idle", 16, [0, 0, 0]);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });
});
