// An update installs only as the version it was released as.
//
// CI signs each file's bytes, name and version together (`ed25519Release`,
// releaseMessage in updater-mac.mjs), the app requires that signature for the
// version it is offered as, and the release job checks what it signed with the
// key the app carries before anything is uploaded.
//
// The first signature, over the bytes, is still written exactly as before:
// apps already installed verify only it, and must go on updating.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs, no types
import { createUpdater, signatureFor, verifyFileSignature } from "../../../desktop/updater.mjs";
// @ts-expect-error — plain .mjs, no types
import { checkForUpdate, releaseMessage, stageUpdate, verifyZip } from "../../../desktop/updater-mac.mjs";
// @ts-expect-error — plain .mjs, no types
import { signEntry } from "../../../desktop/scripts/sign-update.mjs";
// @ts-expect-error — plain .mjs, no types
import { signManifest } from "../../../desktop/scripts/sign-yml.mjs";
// @ts-expect-error — plain .mjs, no types
import { updateProblems } from "../../../desktop/scripts/verify-updates.mjs";

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

const otherKeys = () => {
  const k = generateKeyPairSync("ed25519");
  return { pub: k.publicKey.export({ type: "spki", format: "pem" }).toString(), priv: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
};

let tmp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ccdeck-signed-version-"));
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
  const bytes = Buffer.from("a genuine ccdeck zip, built and signed as 3.25.0");
  const served = async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) });
  // Nothing past the signatures may run: a refused download is never unpacked.
  const noTools = vi.fn(async () => { throw new Error("unpacked a download that should have been refused"); });

  async function offeredAs(version: string, entry: Record<string, unknown>) {
    const manifest = { version, files: [entry] };
    return checkForUpdate({
      manifestUrl: "https://github.com/o/r/releases/latest/download/latest-mac.json",
      currentVersion: "3.32.0", arch: "arm64",
      fetchImpl: async () => ({ ok: true, json: async () => manifest }),
    });
  }

  it("refuses a zip released as 3.25.0 and offered as 99.0.0, before unpacking it", async () => {
    const entry = signEntry(bytes, { name: "ccdeck-mac-arm64.zip", arch: "arm64", keyPem: h.priv, version: "3.25.0" });
    const update = await offeredAs("99.0.0", entry);
    expect(update?.version).toBe("99.0.0");
    // The bytes are ccdeck's, so the first signature alone would pass them.
    expect(verifyZip(bytes, update.file, h.pub)).toBe(true);
    await expect(stageUpdate(update, { runningApp: "/Applications/ccdeck.app", fetchImpl: served, execFileImpl: noTools, publicKeyPem: h.pub }))
      .rejects.toThrow(/not signed as ccdeck 99\.0\.0/);
    expect(noTools).not.toHaveBeenCalled();
  });

  it("refuses a zip whose manifest entry carries only the signature over its bytes", async () => {
    const { ed25519Release: _dropped, ...entry } = signEntry(bytes, { name: "ccdeck-mac-arm64.zip", arch: "arm64", keyPem: h.priv, version: "99.0.0" });
    const update = await offeredAs("99.0.0", entry);
    await expect(stageUpdate(update, { runningApp: "/Applications/ccdeck.app", fetchImpl: served, execFileImpl: noTools, publicKeyPem: h.pub }))
      .rejects.toThrow(/not signed as ccdeck 99\.0\.0/);
  });

  it("refuses a zip renamed to another CPU's file", async () => {
    const entry = { ...signEntry(bytes, { name: "ccdeck-mac-x64.zip", arch: "x64", keyPem: h.priv, version: "99.0.0" }), arch: "arm64", url: "ccdeck-mac-arm64.zip" };
    const update = await offeredAs("99.0.0", entry);
    await expect(stageUpdate(update, { runningApp: "/Applications/ccdeck.app", fetchImpl: served, execFileImpl: noTools, publicKeyPem: h.pub }))
      .rejects.toThrow(/not signed as ccdeck 99\.0\.0/);
  });

  it("writes the signature apps already installed check, exactly as before", () => {
    const entry = signEntry(bytes, { name: "ccdeck-mac-arm64.zip", arch: "arm64", keyPem: h.priv, version: "3.34.0" });
    // What a shipped app reads: url, size, sha256 and `signature` over the
    // bytes. The new field sits beside them and changes none of them.
    expect(entry.signature).toBe(sign(null, bytes, h.priv).toString("base64"));
    expect(verifyZip(bytes, { arch: entry.arch, url: entry.url, size: entry.size, sha256: entry.sha256, signature: entry.signature }, h.pub)).toBe(true);
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

  /** The yml CI writes for an installer built as `builtAs`, signed with
   *  `keyPem` by the real sign-yml.mjs. */
  function yml(builtAs: string, keyPem = h.priv) {
    const installer = Buffer.from(`a genuine ccdeck installer, built as ${builtAs}`);
    writeFileSync(join(tmp, "ccdeck-win-x64.exe"), installer);
    const doc = signManifest({ version: builtAs, files: [{ url: "ccdeck-win-x64.exe", sha512: "x" }], path: "ccdeck-win-x64.exe", sha512: "x" }, tmp, keyPem);
    return { doc, installer };
  }

  /** What the updater makes of that download, with 3.32.0 running. */
  async function after(info: Record<string, unknown>) {
    const u = createUpdater({ app: { isPackaged: true, getVersion: () => "3.32.0", getPath: () => "/nowhere", quit: () => {} }, onChange: () => {} });
    await u.check();
    fake.emit("update-downloaded", { ...info, downloadedFile: join(tmp, "pending", "ccdeck-win-x64.exe") });
    for (let i = 0; i < 200 && (u.state.status === "checking" || u.state.status === "idle"); i++) await new Promise(r => setTimeout(r, 5));
    return u.state;
  }

  beforeEach(() => mkdirSync(join(tmp, "pending")));
  const downloaded = (installer: Buffer) => writeFileSync(join(tmp, "pending", "ccdeck-win-x64.exe"), installer);

  it("refuses an installer released as 3.25.0 whose yml says 3.40.0", async () => {
    const { doc, installer } = yml("3.25.0");
    downloaded(installer);
    // The file and both its signatures as released; only the version differs.
    const state = await after({ ...doc, version: "3.40.0" });
    expect(state.status).toBe("error");
    expect(state.error).toMatch(/not signed by ccdeck's update key as 3\.40\.0/);
  });

  it("refuses a yml that carries only the signature over the bytes", async () => {
    const { doc, installer } = yml("3.40.0");
    downloaded(installer);
    const stripped = { ...doc, ed25519Release: undefined, files: doc.files.map(({ ed25519Release: _r, ...f }: Record<string, unknown>) => f) };
    const state = await after(stripped);
    expect(state.status).toBe("error");
  });

  it("readies a release signed as the version it is offered as", async () => {
    const { doc, installer } = yml("3.40.0");
    downloaded(installer);
    expect(await after(doc)).toEqual({ status: "ready", version: "3.40.0" });
  });

  it("still writes the signature apps already installed check, exactly as before", () => {
    const { doc, installer } = yml("3.34.0");
    const file = join(tmp, "pending", "ccdeck-win-x64.exe");
    // A shipped app looks the entry up by the downloaded file's name and
    // verifies `ed25519` over the bytes; it never reads the new field.
    expect(signatureFor(doc, file)).toBe(sign(null, installer, h.priv).toString("base64"));
    expect(verifyFileSignature(installer, signatureFor(doc, file), h.pub)).toBe(true);
    expect(doc.ed25519).toBe(doc.files[0].ed25519);
  });
});

describe("the release job's check", () => {
  /** A release folder the way CI leaves it: installers, a signed
   *  latest-mac.json and a signed latest.yml. JSON is YAML, so the yml is
   *  written as JSON here and parsed with JSON.parse; CI parses it with
   *  js-yaml. */
  function release(version: string, keyPem = h.priv) {
    const dir = join(tmp, "dist");
    mkdirSync(dir, { recursive: true });
    const zip = Buffer.from(`mac zip ${version}`);
    writeFileSync(join(dir, "ccdeck-mac-arm64.zip"), zip);
    writeFileSync(join(dir, "latest-mac.json"), JSON.stringify({ version, files: [signEntry(zip, { name: "ccdeck-mac-arm64.zip", arch: "arm64", keyPem, version })] }));
    writeFileSync(join(dir, "ccdeck-win-x64.exe"), `win installer ${version}`);
    const doc = signManifest({ version, files: [{ url: "ccdeck-win-x64.exe", sha512: "x" }], path: "ccdeck-win-x64.exe", sha512: "x" }, dir, keyPem);
    writeFileSync(join(dir, "latest.yml"), JSON.stringify(doc));
    return dir;
  }
  const check = (dir: string, version: string, publicKeyPem = h.pub) => updateProblems(dir, version, { readYml: JSON.parse, publicKeyPem });

  it("passes a release signed with the key the app carries, as the version it is", () => {
    expect(check(release("3.34.0"), "3.34.0")).toEqual([]);
  });

  it("stops a release signed with a key the app does not carry", () => {
    const problems = check(release("3.34.0", otherKeys().priv), "3.34.0");
    expect(problems.join("\n")).toMatch(/ccdeck-mac-arm64\.zip/);
    expect(problems.join("\n")).toMatch(/latest\.yml: ccdeck-win-x64\.exe/);
  });

  it("stops manifests that name another version than the one being released", () => {
    expect(check(release("3.34.0"), "3.35.0").join("\n")).toMatch(/latest-mac\.json is 3\.34\.0, not 3\.35\.0/);
  });

  it("stops a release whose files lack the release signature", () => {
    const dir = release("3.34.0");
    const mac = JSON.parse(readFileSync(join(dir, "latest-mac.json"), "utf8"));
    delete mac.files[0].ed25519Release;
    writeFileSync(join(dir, "latest-mac.json"), JSON.stringify(mac));
    expect(check(dir, "3.34.0").join("\n")).toMatch(/release signature does not verify/);
  });

  it("stops a folder with no manifest in it", () => {
    const dir = join(tmp, "empty");
    mkdirSync(dir);
    expect(check(dir, "3.34.0")).toEqual([`no update manifest in ${dir}`]);
  });

  it("signs with the same message the app verifies", () => {
    const bytes = Buffer.from("x");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(releaseMessage("3.34.0", "ccdeck-win-x64.exe", bytes).toString("utf8"))
      .toBe(["ccdeck-update", "3.34.0", "ccdeck-win-x64.exe", sha].join("\u0000"));
  });
});
