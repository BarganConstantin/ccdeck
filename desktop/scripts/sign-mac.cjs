// Sign the macOS app with ccdeck's own certificate — electron-builder's
// `afterPack` hook (#1160).
//
// WHY NOT electron-builder's OWN SIGNING. It will only sign with an identity
// the keychain trusts, and a self-signed certificate is trusted nowhere until
// somebody types an admin password to trust it. rcodesign (apple-codesign)
// signs with a PEM key and certificate directly, on any OS, with no keychain.
// electron-builder is told `identity: null`, so it signs nothing itself and
// this is the only signature the app carries.
//
// WHY A CERTIFICATE AT ALL, when ad-hoc signing is free too. An ad-hoc
// signature's designated requirement is the build's own code hash, so every
// release is a different app to macOS: the notification permission granted to
// one build is refused to the next, silently. This pins the requirement to the
// app id and the certificate instead —
//
//     identifier "dev.ccdeck.app" and certificate leaf = H"<sha1 of cert>"
//
// — which every build signed with the same key satisfies, so a permission
// granted once survives every update. The key must therefore never change; it
// lives in CI secrets, with a backup kept by the owner.
//
// Inputs, all optional so a local `npm run pack:mac` works without CI:
//   CCDECK_SIGNING_CERT   PEM certificate  (default ~/.config/ccdeck-signing/ccdeck-signing.cert.pem)
//   CCDECK_SIGNING_KEY    PEM private key  (default ~/.config/ccdeck-signing/ccdeck-signing.key.pem)
//   RCODESIGN             path to rcodesign (default: `rcodesign` on PATH)
// With no certificate the app is left ad-hoc signed and the build says so.
const { execFileSync } = require("node:child_process");
const { createHash, X509Certificate } = require("node:crypto");
const { existsSync, mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { join } = require("node:path");

const APP_ID = "dev.ccdeck.app";

/** The designated requirement's expression, as text. Exported for the tests.
 *  A single requirement, not a `designated => …` set: rcodesign takes the
 *  compiled form of one requirement (blob magic 0xfade0c00) and files it as
 *  the designated one, and rejects a set (0xfade0c01) as a malformed header. */
function requirementFor(certPem, appId = APP_ID) {
  return requirementForLeaf(createHash("sha1").update(new X509Certificate(certPem).raw).digest("hex"), appId);
}

/** The same, from the certificate's SHA-1 directly. */
function requirementForLeaf(leafSha1, appId = APP_ID) {
  return `identifier "${appId}" and certificate leaf = H"${leafSha1}"`;
}

module.exports = async function signMac(context) {
  if (context.electronPlatformName !== "darwin") return;
  const home = join(homedir(), ".config", "ccdeck-signing");
  const certPath = process.env.CCDECK_SIGNING_CERT || join(home, "ccdeck-signing.cert.pem");
  const keyPath = process.env.CCDECK_SIGNING_KEY || join(home, "ccdeck-signing.key.pem");
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    // A certificate somebody NAMED that is not there is a broken setup, not a
    // build without one: CI names both only once it has written them. Signing
    // ad-hoc instead would ship an app whose requirement is its own hash —
    // which refuses every later update at check 4, and loses its notification
    // permission — with nothing but a warning in the log (#1176). A build that
    // names none, a fork's pull request or a local pack, is still ad-hoc.
    if (process.env.CCDECK_SIGNING_CERT || process.env.CCDECK_SIGNING_KEY) {
      throw new Error(`ccdeck: CCDECK_SIGNING_CERT / CCDECK_SIGNING_KEY name ${certPath} and ${keyPath}, and ${existsSync(certPath) ? keyPath : certPath} does not exist`);
    }
    console.warn(`  • ccdeck: no signing certificate at ${certPath}; the app stays ad-hoc signed and macOS will forget its permissions on every build`);
    return;
  }

  const work = mkdtempSync(join(tmpdir(), "ccdeck-sign-"));
  try {
    // rcodesign reads compiled requirements only; Apple's csreq compiles them.
    const req = join(work, "designated.csreq");
    // The id the build actually carries, so a build with an overridden appId
    // is not signed with a requirement it can never satisfy.
    const appId = context.packager.appInfo.id || APP_ID;
    execFileSync("csreq", ["-r", `=${requirementFor(readFileSync(certPath, "utf8"), appId)}`, "-b", req]);
    execFileSync(process.env.RCODESIGN || "rcodesign", [
      "sign",
      "--pem-file", certPath,
      "--pem-file", keyPath,
      "--code-requirements-file", req,
      app,
    ], { stdio: "inherit" });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

module.exports.requirementFor = requirementFor;
module.exports.requirementForLeaf = requirementForLeaf;
module.exports.APP_ID = APP_ID;
