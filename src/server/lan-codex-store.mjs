// This deck's Codex accounts as Local network reads, gives and takes them — the
// store half of lan-codex.mjs's rules, as the claude-swap adapters in
// lan-deck.mjs are Claude's. The engine never opens a credential: it asks this
// for rows, for one login sealed as a share, and to place one that arrived.
//
// WHAT IS READ is each registered home's auth.json, for three things: who it is
// signed in as (the id_token's email), which workspace (the account id, hashed
// into the key), and a hash of the refresh token it holds now. No token leaves
// this file except inside the share `exportAccount` builds for a `want` the
// engine has already proved and checked, and nothing is ever refreshed here.
//
// WHAT IS KEPT is each profile's token history, as hashes, in
// codex-lan-lineage.json beside the Codex registry: the token it holds now and
// the ones it held before. That history is how a paired deck proves its copy
// of a login is dead (see codexSyncAction), and it outlives a restart because a
// renewal can happen while the deck is not running.
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTemp, renameWithRetry } from "./atomic-write.mjs";
import { nextLineage } from "./lan-codex.mjs";
import { codexLoginOf } from "./codex-lan-identity.mjs";

export { codexLoginOf };

const AUTH_MAX_BYTES = 32_000;
const LINEAGE_MAX_BYTES = 256_000;

/** The login on file in one home, or null: no file, a file that is not a
 *  plain bounded one, or one that is not a ChatGPT login. */
export async function codexLoginOnFile(home) {
  try {
    const file = join(home, "auth.json");
    const info = await lstat(file);
    if (!info.isFile() || info.size > AUTH_MAX_BYTES) return null;
    return codexLoginOf(JSON.parse(await readFile(file, "utf8")));
  } catch { return null; }
}

/**
 * The adapter the LAN engine takes as `codex`. `options` reaches the Codex
 * registry and share modules (a store directory in the suite); `readSelection`,
 * `share` and `settle` may replace those modules' functions there too.
 */
export function createCodexLan(options = {}) {
  const selectionModule = () => import("./codex-selection.mjs");
  const shareModule = () => import("./codex-share.mjs");
  const readSelection = async () => (options.readSelection ?? (await selectionModule()).readCodexSelection)(options);

  let lineage = null;
  let writing = Promise.resolve();
  const lineageFile = async () => join(dirname((await selectionModule()).codexSelectionPath(options)), "codex-lan-lineage.json");
  const loadLineage = async () => {
    if (lineage) return lineage;
    let kept = {};
    try {
      const file = await lineageFile();
      if ((await lstat(file)).size <= LINEAGE_MAX_BYTES) {
        const raw = JSON.parse(await readFile(file, "utf8"));
        if (raw && typeof raw.profiles === "object" && raw.profiles && !Array.isArray(raw.profiles)) kept = raw.profiles;
      }
    } catch { /* none yet: every profile starts with no history */ }
    lineage = lineage ?? { profiles: { ...kept } };
    return lineage;
  };
  const saveLineage = () => {
    const text = JSON.stringify(lineage) + "\n";
    writing = writing.then(async () => {
      const target = await lineageFile();
      // The deck's data folder, which nothing may have made yet on a deck that
      // never took a Codex lock.
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const { tmp, handle } = await createTemp(target, { mode: 0o600 });
      try {
        try { await handle.writeFile(text, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await renameWithRetry(tmp, target);
      } catch (err) { await unlink(tmp).catch(() => {}); throw err; }
    }).catch(() => { /* kept in memory; the next change writes it again */ });
    return writing;
  };

  return {
    /** Every registered home signed in to a ChatGPT account, in the rules' shape:
     *  `num` is the profile id, `active` the one Codex runs on here. */
    async readAccounts() {
      const selection = await readSelection();
      const kept = await loadLineage();
      let changed = false;
      const rows = [];
      const seen = new Set();
      for (const profile of selection.profiles ?? []) {
        seen.add(profile.id);
        if (!profile.available) continue;
        const login = await codexLoginOnFile(profile.home);
        const next = nextLineage(kept.profiles[profile.id], login?.rt ?? null);
        if (next.changed) { kept.profiles[profile.id] = next.entry; changed = true; }
        if (!login) continue;
        rows.push({
          key: login.key, email: login.email, alive: true, readable: true, unreadableWhy: "export failed",
          num: profile.id, active: profile.id === selection.profileId, rt: login.rt, was: next.entry.was,
        });
      }
      // A profile removed here takes its history with it.
      for (const id of Object.keys(kept.profiles)) {
        if (!seen.has(id)) { delete kept.profiles[id]; changed = true; }
      }
      if (changed) await saveLineage();
      return rows;
    },

    /** One profile's login as a share holding exactly that login, or null. The
     *  share is read back before it goes, so a profile that changed accounts
     *  since the manifest never answers a `want` for the old one. */
    async exportAccount(id, expectedKey) {
      try {
        const { createCodexShare, readCodexShare } = await shareModule();
        const out = await (options.share ?? createCodexShare)({ ids: [id] }, options);
        const entries = readCodexShare(out?.blob);
        return entries.length === 1 && codexLoginOf(entries[0].auth)?.key === expectedKey ? out.blob : null;
      } catch (err) {
        if (err?.code === 'windows_permissions_required') throw Object.assign(new Error('windows_permissions_required'), { code: 'windows_permissions_required' });
        return null;
      }
    },

    /**
     * Place one login that arrived. An add registers a new profile, as Import
     * does; a heal puts it in place of the dead copy `mine` names, and only
     * while that copy is still the token the other deck renewed past.
     *
     * NARROWED TO THE ONE ACCOUNT ASKED FOR. The seal binds the envelope to the
     * key that was requested, not its contents, and a share can carry twenty
     * logins: one that is not exactly the asked-for account is refused whole.
     */
    async importAccount(blob, step, mine) {
      const { importCodexShare, readCodexShare, replaceCodexLoginFromShare } = await shareModule();
      let entries;
      try { entries = readCodexShare(blob); } catch { return { ok: false, why: "import refused" }; }
      if (entries.length !== 1 || codexLoginOf(entries[0].auth)?.key !== step?.key) return { ok: false, why: "import refused" };
      if (step.action === "heal") {
        if (!mine?.num || !mine.rt) return { ok: false, why: "import refused" };
        try {
          const { home } = await replaceCodexLoginFromShare({
            blob, id: mine.num,
            stillDead: auth => {
              const here = codexLoginOf(auth);
              return here?.key === step.key && here.rt === mine.rt;
            },
          }, options);
          // The account did not change, its login did: keep a good reading's
          // floor and drop a failed one, as a sign-in moved in place does.
          try { await (options.settle ?? (await import("./codex-native-account.mjs")).settleMovedLogin)(home); }
          catch { /* the next read settles it */ }
          return { ok: true };
        } catch (err) {
          return { ok: false, why: err?.code === "login_changed" ? "import refused" : "import failed" };
        }
      }
      // A conflict is somebody else changing the registry between the read and
      // the write; one fresh read is enough to tell that from a real failure.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const { revision } = await readSelection();
          const out = await importCodexShare({ blob, expectedRevision: revision }, options);
          return out?.results?.[0]?.status === "imported" ? { ok: true } : { ok: false, why: "import refused" };
        } catch (err) {
          if (err?.code !== "selection_conflict" || attempt) return { ok: false, why: "import failed" };
        }
      }
      return { ok: false, why: "import failed" };
    },
  };
}
