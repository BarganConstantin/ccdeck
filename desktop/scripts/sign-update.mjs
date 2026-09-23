// Sign one macOS update zip and record it in the release's manifest (#1160).
//
//   node scripts/sign-update.mjs <zip> <version> <arch> <manifest.json>
//
// Adds (or replaces) the entry for <arch> in <manifest.json>: the zip's file
// name, size, SHA-256, and an Ed25519 signature over its bytes by ccdeck's
// update key. updater-mac.mjs checks all four against the public key compiled
// into the app, so a zip that did not come from here is never installed.
//
// The key comes from CCDECK_UPDATE_KEY (PEM text, as CI passes a secret) or
// CCDECK_UPDATE_KEY_FILE, or ~/.config/ccdeck-signing/ccdeck-update.key.pem.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export function signEntry(bytes, { name, arch, keyPem }) {
  return {
    arch,
    url: name,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    signature: sign(null, bytes, createPrivateKey(keyPem)).toString("base64"),
  };
}

function updateKey() {
  if (process.env.CCDECK_UPDATE_KEY) return process.env.CCDECK_UPDATE_KEY;
  const file = process.env.CCDECK_UPDATE_KEY_FILE
    || join(homedir(), ".config", "ccdeck-signing", "ccdeck-update.key.pem");
  return readFileSync(file, "utf8");
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const [zip, version, arch, manifestPath] = process.argv.slice(2);
  if (!zip || !version || !arch || !manifestPath) {
    console.error("usage: sign-update.mjs <zip> <version> <arch> <manifest.json>");
    process.exit(2);
  }
  const bytes = readFileSync(zip);
  const entry = signEntry(bytes, { name: basename(zip), arch, keyPem: updateKey() });
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const files = (Array.isArray(manifest.files) ? manifest.files : []).filter(f => f.arch !== arch);
  writeFileSync(manifestPath, JSON.stringify({ version, files: [...files, entry] }, null, 2) + "\n");
  console.log(`signed ${basename(zip)} (${arch}, ${version}) into ${manifestPath}`);
}
