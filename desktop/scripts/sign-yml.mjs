// Sign every file a Windows or Linux update manifest lists (#1160).
//
//   node scripts/sign-yml.mjs <dir>
//
// electron-builder writes latest.yml (Windows) and latest-linux.yml beside the
// installers, and electron-updater checks only the SHA-512 in them — which sits
// in the same release as the file it describes. This adds two fields to each
// entry, signatures by ccdeck's update key: `ed25519` over the file's bytes,
// and `ed25519Release` over its bytes, name and the yml's version
// (updater-mac.mjs, releaseMessage). updater.mjs verifies them against the
// public key compiled into the app before it lets an update install. Apps
// released before `ed25519Release` existed check only the first, so both are
// written. The key: CCDECK_UPDATE_KEY (PEM text), CCDECK_UPDATE_KEY_FILE, or
// ~/.config/ccdeck-signing/ccdeck-update.key.pem.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createPrivateKey, sign } from "node:crypto";
import { releaseMessage } from "../updater-mac.mjs";

function updateKey() {
  if (process.env.CCDECK_UPDATE_KEY) return process.env.CCDECK_UPDATE_KEY;
  return readFileSync(process.env.CCDECK_UPDATE_KEY_FILE
    || join(homedir(), ".config", "ccdeck-signing", "ccdeck-update.key.pem"), "utf8");
}

export function signManifest(doc, dir, keyPem) {
  if (!doc?.version) throw new Error("the manifest names no version to sign the files as");
  const key = createPrivateKey(keyPem);
  const signed = (target, url) => {
    const name = basename(url);
    const bytes = readFileSync(join(dir, name));
    target.ed25519 = sign(null, bytes, key).toString("base64");
    target.ed25519Release = sign(null, releaseMessage(doc.version, name, bytes), key).toString("base64");
  };
  for (const f of doc.files ?? []) if (f?.url) signed(f, f.url);
  if (doc.path) signed(doc, doc.path);
  return doc;
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: sign-yml.mjs <dir>"); process.exit(2); }
  // Here and not at the top: signManifest is pure and imported by the root
  // suite, whose install does not include desktop/'s dependencies.
  const { default: yaml } = await import("js-yaml");
  const key = updateKey();
  const ymls = readdirSync(dir).filter(n => /^latest.*\.yml$/.test(n) && n !== "latest-mac.yml");
  for (const name of ymls) {
    const doc = signManifest(yaml.load(readFileSync(join(dir, name), "utf8")), dir, key);
    writeFileSync(join(dir, name), yaml.dump(doc, { lineWidth: -1 }));
    console.log(`signed the files in ${name}`);
  }
}
