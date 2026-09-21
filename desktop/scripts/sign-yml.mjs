// Sign every file a Windows or Linux update manifest lists (#1160).
//
//   node scripts/sign-yml.mjs <dir>
//
// electron-builder writes latest.yml (Windows) and latest-linux.yml beside the
// installers, and electron-updater checks only the SHA-512 in them — which sits
// in the same release as the file it describes. This adds an `ed25519` field to
// each entry: a signature over the file's bytes by ccdeck's update key, which
// updater.mjs verifies against the public key compiled into the app before it
// lets an update install. The key: CCDECK_UPDATE_KEY (PEM text),
// CCDECK_UPDATE_KEY_FILE, or ~/.config/ccdeck-signing/ccdeck-update.key.pem.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createPrivateKey, sign } from "node:crypto";

function updateKey() {
  if (process.env.CCDECK_UPDATE_KEY) return process.env.CCDECK_UPDATE_KEY;
  return readFileSync(process.env.CCDECK_UPDATE_KEY_FILE
    || join(homedir(), ".config", "ccdeck-signing", "ccdeck-update.key.pem"), "utf8");
}

export function signManifest(doc, dir, keyPem) {
  const key = createPrivateKey(keyPem);
  const sigOf = name => sign(null, readFileSync(join(dir, basename(name))), key).toString("base64");
  for (const f of doc.files ?? []) if (f?.url) f.ed25519 = sigOf(f.url);
  if (doc.path) doc.ed25519 = sigOf(doc.path);
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
