// Devices over SSH, against a stand-in `ssh`: the test a device passes, the
// host-key confirmation, the connection kept open and reused, each failure the
// page has to word, and that nothing but the two read-only questions is ever
// asked of a device.
//
// The stand-in is fixtures/fake-ssh.mjs. On macOS and Linux it is found on
// PATH under the name `ssh`, through a two-line shim, exactly the way the deck
// finds the real one; on Windows, which runs no shebang script, the deck is
// handed node and the script instead. It reaches no network and reads no key:
// each machine is a line in scenario.json, and every run is written down.
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { TRUST_TTL_MS, appendKnownHosts, createDeviceLinks, privateControlDir } from "../../server/device-link.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createDeviceStore } from "../../server/device-store.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { fingerprintOf } from "../../server/device-ssh.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { POSIX_FIND, REMOTE_MIN_VERSION } from "../../server/device-remote.mjs";

const WIN = process.platform === "win32";
const FAKE = fileURLToPath(new URL("./fixtures/fake-ssh.mjs", import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-device-link-"));
// Control folders live straight under the temp folder, where a socket path is
// short enough; each is removed with the rest.
const CONTROL_DIRS: string[] = [];
afterAll(() => {
  for (const dir of CONTROL_DIRS) rmTempDir(dir);
  rmTempDir(ROOT);
});

function hostKeyBlob(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const type = Buffer.from("ssh-ed25519");
  const len = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([len(type.length), type, len(raw.length), raw]).toString("base64");
}
const K1 = hostKeyBlob();
const K2 = hostKeyBlob();

const ROW = { id: "sess-1", provider: "claude", cwd: "/home/ana/app", project: "app", name: "Fix login", model: "opus", state: "working", since: 1, startedAt: 1, lastEventAt: 2, waiting: null };
const deck = (extra = {}) => ({ version: "4.5.0", path: "plain", deck: true, sessions: [ROW], ...extra });
const SCENARIO = {
  hosts: {
    "mac.home": { key: K1, ccdeck: deck() },
    "posixbox": { key: K1, ccdeck: deck({ path: "posix" }) },
    "nocc": { key: K1, ccdeck: null },
    "nodeck": { key: K1, ccdeck: deck({ deck: false }) },
    "oldie": { key: K1, ccdeck: deck({ version: "3.40.0" }) },
    "garbled": { key: K1, ccdeck: deck({ raw: "Segmentation fault\n", rawCode: 0 }) },
    "refused": { net: "refused" },
    "nowhere": { net: "dns" },
    "noroute": { net: "noroute" },
    "slow": { net: "hang" },
    "locked": { key: K1, auth: "denied", ccdeck: deck() },
    "rekeyed": { key: K2, fingerprint: fingerprintOf(K2), ccdeck: deck() },
    "twin-a": { key: K1, ccdeck: deck() },
    "twin-b": { key: K1, ccdeck: deck() },
  },
};

type Call = { argv: string[]; env: { LC_ALL: string | null; SSH_ASKPASS_REQUIRE: string | null } };

/** A sandbox: the stand-in's folder, the user's known_hosts, a store, links. */
function rig({ shared, ...opts }: { shared: boolean; now?: () => number; connectMs?: number; execMs?: number; bin?: string }) {
  const dir = mkdtempSync(join(ROOT, "rig-"));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(SCENARIO));
  writeFileSync(join(dir, "calls.jsonl"), "");
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_SSH_DIR: dir };
  let bin = opts.bin ?? "ssh";
  let prefix: string[] = [];
  if (WIN) {
    bin = opts.bin ?? process.execPath;
    prefix = opts.bin ? [] : [FAKE];
  } else {
    const shimDir = join(dir, "bin");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "ssh"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(join(shimDir, "ssh"), 0o755);
    env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ""}`;
  }
  let ctl: string | null = null;
  if (shared) {
    ctl = mkdtempSync(join(tmpdir(), "cc-ctl-"));
    CONTROL_DIRS.push(ctl);
    chmodSync(ctl, 0o700);
  }
  const store = createDeviceStore({ dir: () => join(dir, "data") });
  const links = createDeviceLinks({
    store, bin, prefix, env,
    controlDir: () => ctl, namespace: () => "abcdef", home: () => join(dir, "home"),
    connectMs: opts.connectMs ?? 4_000, execMs: opts.execMs ?? 4_000, ...(opts.now ? { now: opts.now } : {}),
  });
  const knownHosts = join(dir, "home", ".ssh", "known_hosts");
  const calls = (): Call[] => readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
  const trustHost = (name: string, key = K1) => appendKnownHosts(knownHosts, [`${name} ssh-ed25519 ${key}`]);
  return { dir, ctl, store, links, knownHosts, calls, trustHost };
}

/** The remote command of every run that carried one. */
const remoteCommands = (calls: Call[]) => calls
  .filter(c => !c.argv.includes("-G") && !c.argv.includes("-O") && !c.argv.includes("-M"))
  .map(c => c.argv[c.argv.indexOf("--") + 2])
  .filter(Boolean);

const ALLOWED = new Set([
  "ccdeck --version", "ccdeck sessions --json",
  `sh -c '${POSIX_FIND}' ccdeck --version`, `sh -c '${POSIX_FIND}' ccdeck sessions --json`,
  "exit",
]);

const waitFor = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  return cond();
};

let open: Array<{ links: { closeAll(): void } }> = [];
beforeEach(() => { open = []; });
afterEach(async () => {
  for (const r of open) r.links.closeAll();
  await new Promise(r => setTimeout(r, 100));
});
const make = (o: Parameters<typeof rig>[0]) => { const r = rig(o); open.push(r); return r; };

const MODES = [
  { name: "through one kept connection", shared: true, skip: WIN },
  { name: "with a connection per command", shared: false, skip: false },
];

for (const mode of MODES) {
  describe.skipIf(mode.skip)(`a device reached ${mode.name}`, () => {
    it("shows an unknown host key's fingerprint, writes nothing until it is confirmed, then passes", async () => {
      const r = make({ shared: mode.shared });
      const draft = { name: "Mac", host: "mac.home", user: "ana", port: null, launcher: null };
      const first = await r.links.check(draft);
      expect(first).toMatchObject({ type: "host_key_unknown", keys: [{ keyType: "ssh-ed25519", fingerprint: fingerprintOf(K1) }] });
      expect(typeof first.confirm).toBe("string");
      expect(existsSync(r.knownHosts)).toBe(false);
      // The key was read into a throwaway file, with signing in switched off.
      const learn = r.calls().find(c => c.argv.includes("StrictHostKeyChecking=accept-new"))!;
      expect(learn.argv).toContain("PubkeyAuthentication=no");
      expect(learn.argv.find(a => a.startsWith("UserKnownHostsFile="))).not.toContain(r.knownHosts);

      const trusted = await r.links.trust(first.confirm);
      expect(trusted).toEqual({ type: "ok", version: "4.5.0", deckVersion: "4.5.0", sessions: 1 });
      expect(readFileSync(r.knownHosts, "utf8")).toBe(`mac.home ssh-ed25519 ${K1}\n`);
      // Single use.
      expect(await r.links.trust(first.confirm)).toEqual({ type: "trust_expired" });
      expect(await r.links.trust("made-up")).toEqual({ type: "trust_expired" });
      // A draft is tested, never saved.
      expect(await r.store.list()).toEqual([]);
    });

    it("pins batch mode and strict keys on every run, and asks the device nothing but the two reads", async () => {
      const r = make({ shared: mode.shared });
      await r.trustHost("mac.home");
      await r.trustHost("posixbox");
      await r.links.check({ name: "Mac", alias: "mac.home" });
      await r.links.sessions({ id: "dev-posix-1", name: "Box", alias: "posixbox" });
      await r.links.check({ name: "Gone", alias: "rekeyed" });
      const calls = r.calls();
      expect(calls.length).toBeGreaterThan(3);
      for (const c of calls) {
        expect(c.env).toEqual({ LC_ALL: "C", SSH_ASKPASS_REQUIRE: "never" });
        if (c.argv.includes("-O")) continue;
        const dash = c.argv.indexOf("--");
        expect(dash, c.argv.join(" ")).toBeGreaterThan(0);
        expect(["mac.home", "posixbox", "rekeyed"]).toContain(c.argv[dash + 1]);
        if (c.argv.includes("-G")) continue;
        expect(c.argv).toContain("BatchMode=yes");
        expect(c.argv).toContain("ClearAllForwardings=yes");
        expect(c.argv).toContain("ForwardAgent=no");
        if (!c.argv.includes("StrictHostKeyChecking=accept-new")) expect(c.argv).toContain("StrictHostKeyChecking=yes");
        // Never a ControlPersist master the user's config could fork away.
        expect(c.argv).not.toContain("ControlPersist=yes");
      }
      for (const cmd of remoteCommands(calls)) expect(ALLOWED.has(cmd), cmd).toBe(true);
    });

    it("reads each failure as the type the page words", async () => {
      const r = make({ shared: mode.shared, connectMs: 1_500, execMs: 1_500 });
      for (const name of ["locked", "nocc", "nodeck", "oldie", "garbled"]) await r.trustHost(name);
      await r.trustHost("rekeyed", K1);
      const before = readFileSync(r.knownHosts, "utf8");
      const check = (alias: string) => r.links.check({ name: alias, alias });
      expect(await check("refused")).toEqual({ type: "unreachable", detail: "refused" });
      expect(await check("nowhere")).toEqual({ type: "unreachable", detail: "dns" });
      expect(await check("noroute")).toEqual({ type: "unreachable", detail: "network" });
      expect(await check("slow")).toEqual({ type: "unreachable", detail: "timeout" });
      expect(await check("locked")).toEqual({ type: "auth_failed" });
      expect(await check("rekeyed")).toEqual({ type: "host_key_changed", fingerprint: fingerprintOf(K2) });
      expect(await check("nocc")).toEqual({ type: "no_remote_ccdeck", detail: "not_installed" });
      expect(await check("nodeck")).toEqual({ type: "no_remote_ccdeck", detail: "not_running", version: "4.5.0" });
      expect(await check("oldie")).toEqual({ type: "version_too_old", version: "3.40.0", minimum: REMOTE_MIN_VERSION });
      expect(await check("garbled")).toEqual({ type: "failed", detail: "sessions_unreadable" });
      // A changed key is a hard stop: nothing was added, replaced or removed.
      expect(readFileSync(r.knownHosts, "utf8")).toBe(before);
      // Both launchers were tried before ccdeck was called missing.
      const tried = remoteCommands(r.calls()).filter(c => c.endsWith("--version"));
      expect(tried).toContain("ccdeck --version");
      expect(tried).toContain(`sh -c '${POSIX_FIND}' ccdeck --version`);
    });

    it("answers ssh_missing when this machine has no ssh", async () => {
      const r = make({ shared: mode.shared, bin: join(ROOT, "no-such-ssh") });
      expect(await r.links.check({ name: "Mac", alias: "mac.home" })).toEqual({ type: "ssh_missing" });
    });

    it("remembers which launcher worked, and starts with it next time", async () => {
      const r = make({ shared: mode.shared });
      await r.trustHost("posixbox");
      const { device } = await r.store.add({ name: "Box", alias: "posixbox" });
      expect(await r.links.check(device)).toMatchObject({ type: "ok" });
      const saved = await r.store.get(device.id);
      expect(saved.launcher).toBe("posix");
      r.links.disconnect(saved);
      const before = r.calls().length;
      expect(await r.links.check(saved)).toMatchObject({ type: "ok" });
      const next = remoteCommands(r.calls().slice(before));
      expect(next[0]).toBe(`sh -c '${POSIX_FIND}' ccdeck --version`);
    });

    it("keeps the same session on two devices as two rows, each tied to its device", async () => {
      const r = make({ shared: mode.shared });
      await r.trustHost("twin-a");
      await r.trustHost("twin-b");
      const a = await r.links.sessions({ id: "dev-a-0001", name: "Laptop", alias: "twin-a" });
      const b = await r.links.sessions({ id: "dev-b-0002", name: "Desktop", alias: "twin-b" });
      expect(a).toMatchObject({ type: "ok", device: { id: "dev-a-0001", name: "Laptop" } });
      expect(a.sessions[0]).toMatchObject({ key: "dev-a-0001:sess-1", name: "Fix login", device: { name: "Laptop" } });
      expect(b.sessions[0]).toMatchObject({ key: "dev-b-0002:sess-1", name: "Fix login", device: { name: "Desktop" } });
    });

    it("lets a confirmation lapse after its time", async () => {
      let t = 1_000_000;
      const r = make({ shared: mode.shared, now: () => t });
      const first = await r.links.check({ name: "Mac", alias: "mac.home" });
      expect(first.type).toBe("host_key_unknown");
      t += TRUST_TTL_MS + 1;
      expect(await r.links.trust(first.confirm)).toEqual({ type: "trust_expired" });
      expect(existsSync(r.knownHosts)).toBe(false);
    });
  });
}

describe.skipIf(WIN)("one kept connection per device", () => {
  it("connects once, reuses it, disconnects, and reconnects to the same sessions", async () => {
    const r = make({ shared: true });
    await r.trustHost("mac.home");
    const device = { id: "dev-mac-0001", name: "Mac", alias: "mac.home" };
    const first = await r.links.sessions(device);
    const second = await r.links.sessions(device);
    expect(first.sessions.map((s: { key: string }) => s.key)).toEqual(["dev-mac-0001:sess-1"]);
    expect(second.sessions).toEqual(first.sessions);
    const masters = () => r.calls().filter(c => c.argv.includes("-M"));
    expect(masters()).toHaveLength(1);
    const socket = masters()[0].argv[masters()[0].argv.indexOf("-S") + 1];
    expect(socket.startsWith(`${r.ctl}`)).toBe(true);
    expect(socket.endsWith(`/abcdef${socket.slice(-10)}`)).toBe(true);
    // Every command after the master rode it.
    for (const c of r.calls().filter(c => !c.argv.includes("-M"))) expect(c.argv).toContain(socket);
    expect(r.links.status(device)).toMatchObject({ state: "connected", last: "ok" });

    r.links.disconnect(device);
    expect(await waitFor(() => !existsSync(socket))).toBe(true);
    expect(r.links.status(device).state).toBe("offline");

    const again = await r.links.sessions(device);
    expect(masters()).toHaveLength(2);
    // The same session, not a second one: nothing was started on the device.
    expect(again.sessions.map((s: { key: string }) => s.key)).toEqual(["dev-mac-0001:sess-1"]);
    for (const cmd of remoteCommands(r.calls())) expect(ALLOWED.has(cmd), cmd).toBe(true);
  });

  it("sweeps a socket an earlier run of this deck left, and leaves another deck's alone", async () => {
    const r = make({ shared: true });
    writeFileSync(join(r.ctl!, "abcdef0123456789"), "");
    writeFileSync(join(r.ctl!, "fedcba0123456789"), "");
    await r.trustHost("mac.home");
    await r.links.check({ name: "Mac", alias: "mac.home" });
    expect(existsSync(join(r.ctl!, "abcdef0123456789"))).toBe(false);
    expect(existsSync(join(r.ctl!, "fedcba0123456789"))).toBe(true);
  });

  it("keeps nothing open for a draft that failed, and keeps what a passing draft learned once it is saved", async () => {
    const r = make({ shared: true });
    await r.trustHost("nocc");
    await r.trustHost("posixbox");
    expect(await r.links.check({ name: "No", alias: "nocc" })).toMatchObject({ type: "no_remote_ccdeck" });
    const master = r.calls().find(c => c.argv.includes("-M"))!;
    const socket = master.argv[master.argv.indexOf("-S") + 1];
    expect(await waitFor(() => !existsSync(socket))).toBe(true);

    expect(await r.links.check({ name: "Box", alias: "posixbox", launcher: null })).toMatchObject({ type: "ok" });
    const { device } = await r.store.add({ name: "Box", alias: "posixbox" });
    expect(await r.links.sessions(device)).toMatchObject({ type: "ok" });
    // Asked through the connection the draft opened, and its launcher kept.
    expect(r.calls().filter(c => c.argv.includes("-M"))).toHaveLength(2);
    expect((await r.store.get(device.id)).launcher).toBe("posix");
  });

  it("removes the device's state with it", async () => {
    const r = make({ shared: true });
    await r.trustHost("mac.home");
    const device = { id: "dev-mac-0001", name: "Mac", alias: "mac.home" };
    await r.links.sessions(device);
    r.links.forget(device);
    expect(r.links.status(device)).toEqual({ state: "offline", checkedAt: null, last: null });
  });
});

describe.skipIf(WIN)("the control folder", () => {
  it("is this user's alone, or not used at all", async () => {
    const base = mkdtempSync(join(ROOT, "rt-"));
    const uid = process.getuid!();
    const dir = await privateControlDir({ env: { XDG_RUNTIME_DIR: base }, tmp: base, uid });
    expect(dir).toBe(join(base, "ccdeck-ssh"));
    expect((await import("node:fs")).statSync(dir!).mode & 0o777).toBe(0o700);
    // Somebody else's folder, or a loosened one, is refused: no runtime dir,
    // and the temp candidate made group-writable before the deck got there.
    const loose = join(base, `ccdeck-ssh-${uid}`);
    mkdirSync(loose);
    chmodSync(loose, 0o775);
    expect(await privateControlDir({ env: {}, tmp: base, uid })).toBeNull();
    expect(await privateControlDir({ env: {}, tmp: base, uid: uid + 1 })).toBeNull();
    expect(await privateControlDir({ platform: "win32", env: {}, tmp: base, uid })).toBeNull();
    // A path with a space, or one too long for a socket, is not used.
    expect(await privateControlDir({ env: {}, tmp: join(base, "a b"), uid })).toBeNull();
    expect(await privateControlDir({ env: {}, tmp: join(base, "x".repeat(90)), uid })).toBeNull();
  });
});
