// The one thing an uninstall leaves behind that is not data: this deck's LAN
// private key.
//
// `--uninstall` is deliberately narrow — it takes the hook entries out and says
// so, because the event log and the port registry are things somebody may still
// want. That narrowness has bent once already, for the login item, on the
// argument that a machine which keeps starting a deck whose hooks were just
// removed is not data either. The key is the second case and a sharper one.
//
// WHAT IS ACTUALLY LEFT. `prefs.json` is the one file the deck writes with a
// secret in it — deck-home.mjs says so where it names the mode: "0600 on the
// preferences is load-bearing: it is the one file with a private key in it".
// That key is this deck's LAN identity: every machine paired with it has pinned
// the key, and it is what decrypts what crosses between them. An uninstall that
// reports success and leaves it on the disk has left a credential behind.
//
// AND IT IS LEFT IN TWO PLACES, WHICH IS THE PART NOBODY COULD HAVE GUESSED.
// `migrateDeckFiles` moved prefs.json from `~/.claude/agent-dag` to the
// platform's data directory by COPYING it and leaving the original exactly
// where it was — deliberately, so a downgrade finds what it had. So an upgraded
// machine has the key twice, and the second copy sits in a directory the deck's
// own documentation describes as holding "the forwarder and the discovery
// directory". Deleting one of the two is not deleting the key.
//
// SO THIS MODULE ANSWERS TWO QUESTIONS AND NOTHING ELSE: where, on THIS machine,
// is there still a prefs.json that could hold a key, and — when somebody asks
// for it — take those files off the disk. It does not rewrite prefs.json to
// strip the field: a partial rewrite of the file that holds the pairings is a
// worse thing to get wrong than an unlink, and after an uninstall there is
// nothing left the rest of the file is for.
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deckDataDir, legacyDeckDir } from "./deck-home.mjs";

/** The file. Named once, because it is spelled in deck-prefs.mjs too and the
 *  two must not drift — see `prefsPath`, which is the same join. */
export const KEY_FILE = "prefs.json";

/**
 * Every directory on this machine that may still hold one.
 *
 * Deduplicated, and that is not tidiness: on a machine with CLAUDE_CONFIG_DIR
 * set, `deckDataDir` deliberately answers `legacyDeckDir` — those people keep
 * one directory rather than being moved — so the two are the SAME path and
 * reporting it twice would tell somebody there are two copies of their key when
 * there is one.
 */
export function keyDirs({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  return [...new Set([deckDataDir(platform, env, home), legacyDeckDir(env, home, platform)])];
}

/**
 * What is really on disk, per directory, and whether a key is in it.
 *
 * `holds` is three-valued on purpose:
 *
 *   "key"      parsed, and `lan.secret` is a non-empty string. This is the file
 *              the whole module is about.
 *   "no-key"   parsed, and there is no secret in it. A deck that never turned
 *              LAN sync on, or one whose file predates it. Reported so a caller
 *              can offer to remove it without claiming a key is in there —
 *              telling somebody their private key is on the machine when it is
 *              not is the same defect as the silence, pointing the other way.
 *   "unknown"  there is a file and this could not read it as JSON: a BOM from
 *              Notepad, a half-written file, a permission. UNKNOWN IS NOT
 *              "NO": a file that cannot be parsed is exactly the one nobody can
 *              rule a key out of, so it is offered for removal like a "key".
 *
 * A file that is not there at all is not in the list. ENOENT is the ordinary
 * answer on a machine where the deck never ran, and an uninstall that announces
 * the absence of a file is noise at the moment somebody least wants it.
 */
export async function findKeyFiles(dirs = keyDirs(), deps = {}) {
  const read = deps.readFile ?? readFile;
  const out = [];
  for (const dir of dirs) {
    const path = join(dir, KEY_FILE);
    let raw;
    try {
      raw = await read(path, "utf8");
    } catch (err) {
      // Anything but "no such file" means there IS something there and this
      // could not see into it, which is the "unknown" case with the read having
      // failed rather than the parse.
      if (err?.code === "ENOENT") continue;
      out.push({ path, holds: "unknown", why: err?.message ?? String(err) });
      continue;
    }
    try {
      // The BOM, stripped the way installer.mjs strips it off settings.json:
      // `JSON.parse` throws on one and a file Notepad saved is not damaged.
      // Spelled out rather than imported because installer.mjs's `stripBom` is
      // private to that module today — #1056 exports it, and this call should
      // become that import once it lands, so the rule has one spelling.
      const text = String(raw);
      const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      const secret = parsed?.lan?.secret;
      out.push({ path, holds: typeof secret === "string" && secret !== "" ? "key" : "no-key", why: "" });
    } catch (err) {
      out.push({ path, holds: "unknown", why: err?.message ?? String(err) });
    }
  }
  return out;
}

/**
 * Take those files off the disk, and never let one failure hide another.
 *
 * `force: true` so a file that vanished between the listing and the unlink — a
 * second deck, a person deleting it by hand in the other window — is a removal
 * that succeeded rather than an error somebody has to interpret. `maxRetries`
 * is the Windows rule the rest of this repo already follows: a scanner or the
 * indexer holds a handle for a moment after the file is touched, and the first
 * unlink answers EBUSY. rm-temp-dir.ts paid for that knowledge twice.
 *
 * Returns both halves rather than throwing on the first failure, because an
 * uninstall that removed one of two copies and stopped has to say WHICH — the
 * caller's exit code and the user's next move both depend on it.
 */
export async function purgeKeyFiles(files, deps = {}) {
  const remove = deps.rm ?? rm;
  const removed = [];
  const failed = [];
  for (const file of files) {
    const path = typeof file === "string" ? file : file.path;
    try {
      await remove(path, { force: true, maxRetries: 5, retryDelay: 20 });
      removed.push(path);
    } catch (err) {
      failed.push({ path, why: err?.message ?? String(err) });
    }
  }
  return { removed, failed };
}
