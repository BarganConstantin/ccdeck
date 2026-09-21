// Windows and Linux updates (#1160): electron-updater downloads the installer,
// and with no paid signature it checks only a SHA-512 that lives in the same
// release as the file. So every file in latest.yml / latest-linux.yml also
// carries an Ed25519 signature by ccdeck's update key, written by CI
// (scripts/sign-yml.mjs) and verified by the app (updater.mjs) before the
// update may install. These pin both halves meeting.
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { signManifest } from "../../../desktop/scripts/sign-yml.mjs";
// @ts-expect-error — plain .mjs, no types
import { signatureFor, verifyFileSignature } from "../../../desktop/updater.mjs";

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("the signature CI writes and the app checks", () => {
  it("signs every listed file, and the app accepts exactly those bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-yml-"));
    try {
      const installer = Buffer.from("pretend installer");
      writeFileSync(join(dir, "ccdeck-3.26.0-win-x64.exe"), installer);
      const { pub, priv } = keys();
      const doc = signManifest({
        version: "3.26.0",
        files: [{ url: "ccdeck-3.26.0-win-x64.exe", sha512: "x", size: installer.length }],
        path: "ccdeck-3.26.0-win-x64.exe",
      }, dir, priv);
      const downloaded = join("C:\\Users\\u\\AppData\\Local\\ccdeck-updater\\pending", "ccdeck-3.26.0-win-x64.exe");
      const sig = signatureFor(doc, downloaded);
      expect(sig).toBe(doc.files[0].ed25519);
      expect(verifyFileSignature(installer, sig, pub)).toBe(true);
      expect(verifyFileSignature(Buffer.from("something else"), sig, pub)).toBe(false);
    } finally {
      rmTempDir(dir);
    }
  });

  it("refuses a download the manifest has no signature for", () => {
    expect(signatureFor({ files: [{ url: "a.exe" }] }, "/tmp/b.exe")).toBeNull();
    expect(verifyFileSignature(Buffer.from("x"), null)).toBe(false);
  });

  it("refuses a signature by any key but ccdeck's", () => {
    const theirs = keys(), ours = keys();
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-yml-"));
    try {
      writeFileSync(join(dir, "a.AppImage"), "bytes");
      const doc = signManifest({ files: [{ url: "a.AppImage" }] }, dir, theirs.priv);
      expect(verifyFileSignature(Buffer.from("bytes"), doc.files[0].ed25519, ours.pub)).toBe(false);
    } finally {
      rmTempDir(dir);
    }
  });
});
