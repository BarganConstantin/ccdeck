// The devices this deck may reach over SSH: devices.json in the deck's data
// folder, mode 0600, and nothing in it a stranger could use.
//
// A RECORD IS A NAME AND A DESTINATION. `{ id, name, alias }` or `{ id, name,
// host, user, port }`, the time it was added, and which way of starting
// ccdeck on that machine worked last (`launcher`, one of two fixed words; see
// device-remote.mjs). No password, no key, no key path, no command: every
// record goes through parseDeviceInput on the way in AND on the way out of the
// file, and only the fields it answers are written. A file someone edited by
// hand to add a ProxyCommand reads back without it.
//
// The host key a device is trusted under is not here either. It goes where
// ssh itself keeps it, the user's known_hosts (device-link.mjs), so the user's
// own `ssh` and this deck agree on what each machine is.
//
// THE WRITE IS THE INTEGRATIONS STORE'S: a temp file made 0600 with O_EXCL,
// fsynced, chmod'ed, then renamed over the old one with the retrying rename
// Windows needs. Writes and reads are queued one behind another, so a read can
// never move aside a file a write has just landed. A file that does not parse
// is moved aside rather than replaced with an empty list.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createTemp, renameWithRetry } from "./atomic-write.mjs";
import { PRODUCT } from "./brand.mjs";
import { deckDataDir } from "./deck-home.mjs";
import { destinationKey, parseDeviceInput } from "./device-input.mjs";

export const DEVICES_FILE = "devices.json";
/** More devices than anyone keeps, and a bound on what a caller can add. */
export const MAX_DEVICES = 32;
/** The ways of starting ccdeck on the device that a record may remember. */
export const LAUNCHERS = Object.freeze(["plain", "posix"]);

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

/** One record as it is kept and answered, or null when it is not a device. */
export function deviceRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !ID.test(raw.id)) return null;
  const parsed = parseDeviceInput(raw);
  if (!parsed.ok) return null;
  const addedAt = Number.isFinite(raw.addedAt) ? raw.addedAt : 0;
  const launcher = LAUNCHERS.includes(raw.launcher) ? raw.launcher : null;
  return { id: raw.id, ...parsed.value, addedAt, launcher };
}

export function createDeviceStore({ dir = () => deckDataDir(), now = Date.now, warn = msg => console.warn(msg) } = {}) {
  let chain = Promise.resolve();
  const queued = job => {
    const run = chain.then(job, job);
    chain = run.catch(() => {});
    return run;
  };

  async function load() {
    const path = join(dir(), DEVICES_FILE);
    let raw;
    try { raw = await readFile(path, "utf8"); }
    catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    let doc;
    try { doc = JSON.parse(raw.replace(/^\ufeff/, "")); }
    catch {
      const aside = `${path}.corrupt-${now()}`;
      try { await rename(path, aside); }
      catch (err) {
        if (err?.code === "ENOENT") return [];
        throw err;
      }
      warn(`${PRODUCT}: ${DEVICES_FILE} could not be read as JSON and was moved aside to ${aside}.`);
      return [];
    }
    const seen = new Set();
    const devices = [];
    for (const item of Array.isArray(doc?.devices) ? doc.devices : []) {
      const record = deviceRecord(item);
      if (!record) continue;
      const key = destinationKey(record);
      if (seen.has(key) || devices.some(d => d.id === record.id)) continue;
      seen.add(key);
      devices.push(record);
      if (devices.length >= MAX_DEVICES) break;
    }
    return devices;
  }

  async function write(devices) {
    const home = dir();
    await mkdir(home, { recursive: true, mode: DIR_MODE });
    const target = join(home, DEVICES_FILE);
    const { tmp, handle } = await createTemp(target, { mode: FILE_MODE });
    let landed = false;
    try {
      try {
        // deviceRecord again on the way out: only the fields it answers.
        const body = { version: 1, devices: devices.map(deviceRecord).filter(Boolean) };
        await handle.writeFile(JSON.stringify(body, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tmp, FILE_MODE);
      await renameWithRetry(tmp, target);
      landed = true;
    } finally {
      if (!landed) await unlink(tmp).catch(() => {});
    }
  }

  return {
    /** Every device, oldest first. */
    list: () => queued(load),

    /** One device by id, or null. */
    get: (id) => queued(async () => (await load()).find(d => d.id === id) ?? null),

    /**
     * Save a device: `{ ok: true, device }`, or `{ ok: false, field, code }`
     * for input parseDeviceInput refuses, `duplicate` for a destination
     * already saved, `full` past MAX_DEVICES.
     */
    add: (input) => queued(async () => {
      const parsed = parseDeviceInput(input);
      if (!parsed.ok) return parsed;
      const devices = await load();
      const key = destinationKey(parsed.value);
      const twin = devices.find(d => destinationKey(d) === key);
      if (twin) return { ok: false, field: parsed.value.alias ? "alias" : "host", code: "duplicate", id: twin.id };
      if (devices.length >= MAX_DEVICES) return { ok: false, field: "device", code: "full" };
      const device = deviceRecord({ id: randomUUID(), ...parsed.value, addedAt: now(), launcher: null });
      await write([...devices, device]);
      return { ok: true, device };
    }),

    /** Forget a device: the record removed, or null when there was none. */
    remove: (id) => queued(async () => {
      const devices = await load();
      const device = devices.find(d => d.id === id);
      if (!device) return null;
      await write(devices.filter(d => d.id !== id));
      return device;
    }),

    /** Remember which launcher worked on a device. A no-op when unchanged. */
    setLauncher: (id, launcher) => queued(async () => {
      if (!LAUNCHERS.includes(launcher)) return false;
      const devices = await load();
      const device = devices.find(d => d.id === id);
      if (!device || device.launcher === launcher) return false;
      await write(devices.map(d => (d.id === id ? { ...d, launcher } : d)));
      return true;
    }),
  };
}

/** The deck's own store, in its data folder. */
export const deviceStore = createDeviceStore();
