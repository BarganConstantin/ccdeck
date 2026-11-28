// The device store: devices.json in the deck's data folder, 0600, holding a
// name and a destination per device and nothing a stranger could use.
//
// Every case runs against a store pointed at its own temporary folder; nothing
// here reads or writes the user's own data folder.
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { DEVICES_FILE, MAX_DEVICES, createDeviceStore, deviceRecord } from "../../server/device-store.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-device-store-"));
afterAll(() => rmTempDir(ROOT));
let n = 0;
/** A store in a folder of its own that does not exist yet. */
function fresh() {
  const dir = join(ROOT, `s${n++}`, "data");
  const warnings: string[] = [];
  const store = createDeviceStore({ dir: () => dir, warn: (m: string) => warnings.push(m) });
  return { dir, store, warnings, file: join(dir, DEVICES_FILE) };
}

const SECRET_KEYS = ["password", "passphrase", "privateKey", "identityFile", "proxyCommand", "command", "token"];

describe("the device store", () => {
  it("adds, lists and removes, oldest first", async () => {
    const { store } = fresh();
    const a = await store.add({ alias: "studio" });
    const b = await store.add({ name: "Mac mini", host: "mac.home", user: "ana", port: 2222 });
    expect(a).toMatchObject({ ok: true, device: { name: "studio", alias: "studio", launcher: null } });
    expect(b.device).toMatchObject({ name: "Mac mini", host: "mac.home", user: "ana", port: 2222 });
    expect((await store.list()).map((d: { id: string }) => d.id)).toEqual([a.device.id, b.device.id]);
    expect(await store.get(b.device.id)).toEqual(b.device);
    expect(await store.remove(a.device.id)).toEqual(a.device);
    expect(await store.remove(a.device.id)).toBeNull();
    expect((await store.list()).map((d: { id: string }) => d.id)).toEqual([b.device.id]);
  });

  it("refuses the same destination twice and stops at the cap", async () => {
    const { store } = fresh();
    const first = await store.add({ host: "mac.home", user: "ana" });
    expect(await store.add({ name: "again", host: "MAC.home", user: "ana" })).toEqual({ ok: false, field: "host", code: "duplicate", id: first.device.id });
    expect((await store.add({ host: "mac.home", user: "bob" })).ok).toBe(true);
    for (let i = (await store.list()).length; i < MAX_DEVICES; i++) expect((await store.add({ alias: `box${i}` })).ok).toBe(true);
    expect(await store.add({ alias: "one-more" })).toEqual({ ok: false, field: "device", code: "full" });
  });

  it("refuses input the validator refuses, and writes nothing for it", async () => {
    const { store, file } = fresh();
    expect(await store.add({ alias: "-oProxyCommand=touch x" })).toEqual({ ok: false, field: "alias", code: "invalid" });
    expect(await store.add({ host: "mac.home", user: "ana", port: "22 -oX" })).toEqual({ ok: false, field: "port", code: "invalid" });
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("writes the file 0600 and makes a missing folder 0700", async () => {
    const { store, dir, file } = fresh();
    await store.add({ alias: "studio" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // No temp file is left beside it.
    expect(readdirSync(dir)).toEqual([DEVICES_FILE]);
  });

  it("writes no secret, whatever the request carried", async () => {
    const { store, file } = fresh();
    await store.add({
      alias: "studio", password: "hunter2", passphrase: "open sesame", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA",
      identityFile: "~/.ssh/id_ed25519", proxyCommand: "nc %h %p", command: "rm -rf ~", token: "tok_123",
    });
    const text = readFileSync(file, "utf8");
    for (const word of [...SECRET_KEYS, "hunter2", "open sesame", "PRIVATE KEY", "id_ed25519", "nc %h", "rm -rf", "tok_123"]) {
      expect(text, word).not.toContain(word);
    }
    const doc = JSON.parse(text);
    expect(doc.version).toBe(1);
    expect(Object.keys(doc.devices[0]).sort()).toEqual(["addedAt", "alias", "id", "launcher", "name"]);
  });

  it("reads back a hand-edited file without the fields it added or the records it broke", async () => {
    const { store, dir, file } = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({
      version: 1,
      devices: [
        { id: "aaaaaaaa-1", name: "ok", alias: "studio", addedAt: 5, launcher: "posix", proxyCommand: "evil", password: "x" },
        { id: "bbbbbbbb-2", name: "bad", alias: "-oProxyCommand=evil" },
        { id: "short", name: "bad id", alias: "other" },
        { id: "cccccccc-3", name: "twin", alias: "studio" },
        { id: "dddddddd-4", name: "odd launcher", host: "mac.home", user: "ana", launcher: "bash -c" },
      ],
    }));
    const list = await store.list();
    expect(list).toEqual([
      { id: "aaaaaaaa-1", name: "ok", alias: "studio", addedAt: 5, launcher: "posix" },
      { id: "dddddddd-4", name: "odd launcher", host: "mac.home", user: "ana", port: null, addedAt: 0, launcher: null },
    ]);
    // The next write keeps only those fields.
    await store.setLauncher("dddddddd-4", "plain");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("password");
    expect(text).not.toContain("bash -c");
  });

  it("moves a file it cannot parse aside instead of writing an empty list over it", async () => {
    const { store, dir, file, warnings } = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "{ not json");
    expect(await store.list()).toEqual([]);
    expect(readdirSync(dir).some(name => name.startsWith(`${DEVICES_FILE}.corrupt-`))).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("remembers a launcher only when it is one of the two words", async () => {
    const { store } = fresh();
    const { device } = await store.add({ alias: "studio" });
    expect(await store.setLauncher(device.id, "posix")).toBe(true);
    expect(await store.setLauncher(device.id, "posix")).toBe(false);
    expect(await store.setLauncher(device.id, "sh -c 'id'")).toBe(false);
    expect((await store.get(device.id)).launcher).toBe("posix");
    expect(deviceRecord({ ...device, launcher: "zsh" }).launcher).toBeNull();
  });

  it("serialises concurrent adds so none is lost", async () => {
    const { store } = fresh();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.add({ alias: `box${i}` })));
    expect(results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    expect(await store.list()).toHaveLength(10);
  });
});
