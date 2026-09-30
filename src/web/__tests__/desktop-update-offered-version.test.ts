// An update installs only as the version it was offered as, and only forward.
//
// The version the updater compares comes from the release's manifest, next to
// the file it describes. On macOS the app about to be installed can say for
// itself which version it is: its Info.plist is sealed by the code signature
// check 4 verifies, and electron-builder writes the packaged version into
// CFBundleShortVersionString. So a staged bundle that is not the version the
// manifest named is refused, and so is anything on Windows or Linux that
// is not newer than the app already running.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import { checkForUpdate, discard, releaseMessage, stageUpdate } from "../../../desktop/updater-mac.mjs";
// @ts-expect-error — plain .mjs, no types
import { signEntry } from "../../../desktop/scripts/sign-update.mjs";

const h = await vi.hoisted(async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const ours = generateKeyPairSync("ed25519");
  const pem = (k: { export: (o: object) => string | Buffer }, type: string) => k.export({ type, format: "pem" }).toString();
  return { pub: pem(ours.publicKey, "spki"), priv: pem(ours.privateKey, "pkcs8"), auto: null as unknown };
});

// Both specifiers, for the reason desktop-updater-state.test.ts gives (#1293).
vi.mock("electron-updater", () => ({ default: { get autoUpdater() { return h.auto; } } }));
vi.mock("../../../desktop/node_modules/electron-updater", () => ({ default: { get autoUpdater() { return h.auto; } } }));
vi.mock("../../../desktop/updater-mac.mjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UPDATE_PUBLIC_KEY: h.pub,
}));

let tmp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ccdeck-offered-version-"));
  // Everything stageUpdate makes lands in this test's own folder.
  for (const k of ["TMPDIR", "TMP", "TEMP", "CCDECK_UPDATE_FEED", "APPIMAGE"]) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const k of ["TMPDIR", "TMP", "TEMP"]) process.env[k] = tmp;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmTempDir(tmp);
});

describe("the macOS update", () => {
  const RUNNING = "/Applications/ccdeck.app";
  const REQUIREMENT = 'identifier "dev.ccdeck.app" and certificate leaf = H"101d26314e1de3458ab863561d63937395792a34"';
  const bytes = Buffer.from("a genuine ccdeck zip, built as 3.25.0");

  /** ditto, codesign and PlistBuddy as a Mac answers them, for a signed
   *  bundle whose Info.plist says it is `bundleVersion`. */
  const mac = (bundleVersion: string) => async (cmd: string, args: string[]) => {
    if (cmd === "ditto") { mkdirSync(join(args[3], "ccdeck.app"), { recursive: true }); return { stdout: "", stderr: "" }; }
    if (cmd === "codesign" && args[0] === "-d") return { stdout: `designated => ${REQUIREMENT}\n`, stderr: "" };
    if (cmd === "codesign" && args[0] === "--verify") return { stdout: "", stderr: "" };
    if (cmd === "/usr/libexec/PlistBuddy" && args[1] === "Print :CFBundleShortVersionString" && args[2].endsWith(join("ccdeck.app", "Contents", "Info.plist"))) {
      return { stdout: `${bundleVersion}\n`, stderr: "" };
    }
    throw new Error(`nothing here answers ${cmd} ${args.join(" ")}`);
  };

  /** A manifest naming `version`, over a zip genuinely signed by the key. */
  async function offered(version: string) {
    const manifest = { version, files: [signEntry(bytes, { name: "ccdeck-mac-arm64.zip", arch: "arm64", keyPem: h.priv, version })] };
    const update = await checkForUpdate({
      manifestUrl: "https://github.com/o/r/releases/latest/download/latest-mac.json",
      currentVersion: "3.32.0", arch: "arm64",
      fetchImpl: async () => ({ ok: true, json: async () => manifest }),
    });
    expect(update?.version).toBe(version);
    return update;
  }
  const served = async () => ({ ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

  it("refuses a signed bundle that is not the version the manifest offered it as", async () => {
    const update = await offered("99.0.0");
    await expect(stageUpdate(update, { runningApp: RUNNING, fetchImpl: served, execFileImpl: mac("3.25.0"), publicKeyPem: h.pub }))
      .rejects.toThrow(/3\.25\.0.*99\.0\.0/);
    // Thrown away with the refusal, like every other one.
    expect(readdirSync(tmp).filter(n => n.startsWith("ccdeck-update-"))).toEqual([]);
  });

  it("stages the bundle that is the version it was offered as", async () => {
    const update = await offered("3.33.0");
    const { dir } = await stageUpdate(update, { runningApp: RUNNING, fetchImpl: served, execFileImpl: mac("3.33.0"), publicKeyPem: h.pub });
    await discard(dir);
  });
});

describe("the Windows and Linux update", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  type Fake = { emit: (e: string, ...a: unknown[]) => boolean; checkForUpdates: () => Promise<void>; setFeedURL: () => void };
  let fake: Fake;

  beforeEach(async () => {
    Object.defineProperty(process, "platform", { ...realPlatform, value: "win32" });
    const { EventEmitter } = await import("node:events");
    fake = new EventEmitter() as unknown as Fake;
    fake.checkForUpdates = async () => {};
    fake.setFeedURL = () => {};
    h.auto = fake;
  });
  afterEach(() => Object.defineProperty(process, "platform", realPlatform));

  /** The state a signed download of `version` leaves the updater in, with
   *  3.26.0 running. */
  async function after(version: string) {
    const u = createUpdater({ app: { isPackaged: true, getVersion: () => "3.26.0", getPath: () => "/nowhere", quit: () => {} }, onChange: () => {} });
    await u.check();
    const file = join(tmp, "ccdeck-win-x64.exe");
    const installer = Buffer.from(`a genuine ccdeck installer, ${version}`);
    writeFileSync(file, installer);
    fake.emit("update-downloaded", {
      version,
      downloadedFile: file,
      files: [{
        url: basename(file), sha512: "x",
        ed25519: sign(null, installer, h.priv).toString("base64"),
        ed25519Release: sign(null, releaseMessage(version, basename(file), installer), h.priv).toString("base64"),
      }],
    });
    for (let i = 0; i < 200 && (u.state.status === "checking" || u.state.status === "idle"); i++) await new Promise(r => setTimeout(r, 5));
    return u.state;
  }

  it.each(["3.26.0", "3.25.0"])("never readies %s over a running 3.26.0, however well signed", async (version) => {
    const state = await after(version);
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/not newer/);
  });

  it("readies a newer one", async () => {
    expect(await after("3.27.0")).toEqual({ status: "ready", version: "3.27.0" });
  });
});
