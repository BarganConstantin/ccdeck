// The trackers this deck is connected to (#2178): what each connection is, kept
// in one file, and the credential it uses, kept in another.
//
// TWO FILES, AND WHY. `integrations.json` holds what the page may see — the
// name, the address, which account answered, what the provider learned about
// the server — and is read for every list. `integrations-secrets.json` holds
// the tokens and nothing else, is read only when a request to the tracker is
// about to be signed, and is never serialised into an answer. Splitting them
// means no code path that returns connections can carry a token by accident:
// the token is not in the object it returns.
//
// There is no keychain anywhere in this deck, so both are plain files in a
// folder of their own, `integrations/` in the deck's home (deck-home.mjs, which
// honours CCDECK_HOME), kept at 0700 whatever the home itself is — written the way
// prefs.json and Codex's auth.json are: a fresh temp file created 0600 with
// O_EXCL, fsynced, chmod'ed, then renamed over the old one with the retrying
// rename Windows needs. writeFileAtomic is deliberately not used: it creates a
// new file at 0666 minus the umask, which is world-readable on most machines.
//
// THE SECRET IS OPAQUE. A string today (a Jira token), an object tomorrow (an
// OAuth access/refresh pair). Nothing in this file looks inside it; a provider
// decides what it is and the proxy hands it back to the provider to sign with.
//
// Nothing here is shared with paired decks: the LAN exchange is an explicit
// allowlist (lan-manifest.mjs, lan-copies.mjs) and prefs never sync, so a
// connection made on this machine stays on this machine.
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createTemp, renameWithRetry } from "../atomic-write.mjs";
import { deckDataDir } from "../deck-home.mjs";
import { PRODUCT } from "../brand.mjs";

export const META_FILE = "integrations.json";
export const SECRETS_FILE = "integrations-secrets.json";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** More than anybody connects by hand; a bound on what a list answer costs. */
export const MAX_CONNECTIONS = 50;
/** The folder both files live in, inside the deck's home. */
export const STORE_DIR = "integrations";

const text = (v, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");

/** A connection as it is kept: every field a known type, nothing else. */
function normaliseConnection(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.kind !== "string") return null;
  const account = raw.account && typeof raw.account === "object" ? raw.account : {};
  const origins = Array.isArray(raw.allowedOrigins) ? raw.allowedOrigins.filter(o => typeof o === "string").slice(0, 8) : [];
  return {
    id: text(raw.id, 64),
    kind: text(raw.kind, 32),
    name: text(raw.name, 120),
    baseUrl: text(raw.baseUrl, 500),
    account: {
      id: text(account.id, 200),
      login: text(account.login, 200),
      name: text(account.name, 200),
      avatarUrl: text(account.avatarUrl, 1000),
    },
    meta: raw.meta && typeof raw.meta === "object" && !Array.isArray(raw.meta) ? raw.meta : {},
    allowedOrigins: origins,
    createdAt: text(raw.createdAt, 40),
    updatedAt: text(raw.updatedAt, 40),
  };
}

/**
 * @param {object} [opts]
 * @param {() => string} [opts.dir] the directory both files live in; the deck's home by default
 * @param {(msg: string) => void} [opts.warn]
 */
export function createIntegrationsStore({ dir = () => join(deckDataDir(), STORE_DIR), warn = msg => console.warn(msg) } = {}) {
  /** Every write, one at a time, so two pages saving at once cannot lose one. */
  let chain = Promise.resolve();
  const queued = job => {
    const run = chain.then(job, job);
    chain = run.catch(() => {});
    return run;
  };

  async function readJson(path, label) {
    let raw;
    try { raw = await readFile(path, "utf8"); }
    catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    try { return JSON.parse(raw.replace(/^﻿/, "")); }
    catch {
      // Kept aside rather than overwritten: a damaged secrets file is still
      // the user's tokens, and the next save would otherwise replace it with
      // an empty one. Its contents are never logged.
      const aside = `${path}.corrupt-${Date.now()}`;
      await rename(path, aside).catch(() => {});
      warn(`${PRODUCT}: ${label} could not be read as JSON and was moved aside to ${aside}.`);
      return null;
    }
  }

  async function load() {
    const home = dir();
    const meta = await readJson(join(home, META_FILE), META_FILE);
    const secrets = await readJson(join(home, SECRETS_FILE), SECRETS_FILE);
    const connections = (Array.isArray(meta?.connections) ? meta.connections : [])
      .map(normaliseConnection).filter(Boolean).slice(0, MAX_CONNECTIONS);
    const ids = new Set(connections.map(c => c.id));
    const kept = secrets?.secrets && typeof secrets.secrets === "object" ? secrets.secrets : {};
    // A secret whose connection is gone is dropped at the next write: a
    // disconnect that half-failed must not leave a token behind for ever.
    const secretMap = new Map(Object.entries(kept).filter(([id, value]) => ids.has(id) && value != null));
    return { connections, secrets: secretMap };
  }

  /** The safe write: temp at 0600 with O_EXCL, fsync, chmod, rename. */
  async function writeFile(name, value) {
    const home = dir();
    await mkdir(home, { recursive: true, mode: DIR_MODE });
    // Made 0700 by mkdir only when it did not exist yet; held there on every
    // write, so a folder someone loosened does not stay loose.
    if (process.platform !== "win32") await chmod(home, DIR_MODE).catch(() => {});
    const target = join(home, name);
    const { tmp, handle } = await createTemp(target, { mode: FILE_MODE });
    let landed = false;
    try {
      try {
        await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tmp, FILE_MODE);
      await renameWithRetry(tmp, target);
      landed = true;
    } finally {
      // A temp left behind may hold tokens in cleartext.
      if (!landed) await unlink(tmp).catch(() => {});
    }
  }

  const writeMeta = connections => writeFile(META_FILE, { version: 1, connections });
  const writeSecrets = map => writeFile(SECRETS_FILE, { version: 1, secrets: Object.fromEntries(map) });

  /** What a page may see of a connection: everything but the secret, and
   *  whether one is saved. */
  const publicOf = (conn, secrets) => ({ ...conn, tokenSaved: secrets.has(conn.id) });

  return {
    /** Every connection, as a page may see it. */
    async list() {
      const { connections, secrets } = await load();
      return connections.map(c => publicOf(c, secrets));
    },

    /** One connection, as a page may see it, or null. */
    async get(id) {
      const { connections, secrets } = await load();
      const conn = connections.find(c => c.id === id);
      return conn ? publicOf(conn, secrets) : null;
    },

    /** The opaque secret for one connection, or null. The ONE read of the
     *  secrets file, and its only caller is the proxy that signs requests. */
    async secret(id) {
      const { secrets } = await load();
      return secrets.get(id) ?? null;
    },

    /** Add a connection with its secret. Answers it as a page may see it. */
    create(fields, secret) {
      return queued(async () => {
        const { connections, secrets } = await load();
        if (connections.length >= MAX_CONNECTIONS) throw new Error("too many connections");
        const now = new Date().toISOString();
        const conn = normaliseConnection({ ...fields, id: randomUUID(), createdAt: now, updatedAt: now });
        // The secret first: if the second write fails the connection does not
        // exist, and the orphaned secret is dropped by the next write.
        if (secret != null) {
          secrets.set(conn.id, secret);
          await writeSecrets(secrets);
        }
        await writeMeta([...connections, conn]);
        return publicOf(conn, secrets);
      });
    },

    /** Change a connection. `secret` undefined keeps the saved one. */
    update(id, patch, secret) {
      return queued(async () => {
        const { connections, secrets } = await load();
        const at = connections.findIndex(c => c.id === id);
        if (at < 0) return null;
        const prev = connections[at];
        const next = normaliseConnection({ ...prev, ...patch, id: prev.id, kind: prev.kind, createdAt: prev.createdAt, updatedAt: new Date().toISOString() });
        if (secret !== undefined) {
          if (secret === null) secrets.delete(id); else secrets.set(id, secret);
          await writeSecrets(secrets);
        }
        const list = connections.slice();
        list[at] = next;
        await writeMeta(list);
        return publicOf(next, secrets);
      });
    },

    /** Forget a connection and its secret. True when there was one. */
    remove(id) {
      return queued(async () => {
        const { connections, secrets } = await load();
        const had = connections.some(c => c.id === id);
        // The secret goes first: a disconnect that fails halfway leaves a
        // connection with no token (visible, and Disconnect can be pressed
        // again), never a token with no connection.
        if (secrets.delete(id) || had) await writeSecrets(secrets);
        if (had) await writeMeta(connections.filter(c => c.id !== id));
        return had;
      });
    },
  };
}

/** The deck's own store, in its home. */
export const integrationsStore = createIntegrationsStore();
