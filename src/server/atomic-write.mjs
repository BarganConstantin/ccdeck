// Replacing a file that other processes read, in one step none of them can land
// inside — and reading it first, without mistaking a damaged file for an empty
// one.
//
// These lived in src/server/installer.mjs, between the hook entry matcher and
// the hook script installer. The installer is one caller among many: the
// retired sound hook, deck-prefs, the browser-watch store, the Codex token
// writer, uv-bootstrap, macmon, deck-home and the account-projects cache all
// reach for them too, and none of those installs a hook. So they moved to a
// leaf of their own, with the note on why each one is exported. Every one of
// those modules imports what it uses from here, as installer.mjs does: going
// through the installer loaded its whole module graph to reach a rename.
import { readFile, unlink, rename, open, stat, chmod, realpath, readlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PRODUCT } from "./brand.mjs";

// Notepad and PowerShell's Set-Content write UTF-8 with a byte-order mark, and
// JSON.parse throws on it when the file is read as utf8. A BOM is not damage —
// the JSON behind it is fine — so it never gets to look like a corrupt file.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function unreadableSettings(p, why) {
  const err = new Error(
    `${p} could not be read as JSON (${why}). Refusing to overwrite it — ` +
    `fix the file or move it aside, then run ${PRODUCT} again.`,
  );
  err.code = "SETTINGS_UNREADABLE";
  err.settingsPath = p;
  // The bare reason, without the path and without the remedy sentence, so a
  // caller that wants to phrase its own advice — `--uninstall` does; "run
  // ccdeck again" is the wrong instruction there — does not have to take this
  // message apart with a regex to get at the only part it cannot re-derive.
  err.why = why;
  return err;
}

/**
 * Read settings we are about to rewrite. Only ENOENT means "nothing there yet";
 * every other failure is a file whose contents we cannot reproduce — a stray
 * comma, a half-written file from another process, a permission error — and
 * writing our hooks over it would destroy every setting the user has. So the
 * install refuses instead, loudly, and leaves the file exactly as it found it.
 */
async function readSettingsForWrite(p) {
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { settings: {}, raw: null };
    throw unreadableSettings(p, err?.message ?? String(err));
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch (err) {
    throw unreadableSettings(p, err?.message ?? String(err));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw unreadableSettings(p, "top level is not a JSON object");
  }
  return { settings: parsed, raw };
}

// Rename over an open file is the one thing Windows does differently here.
// libuv's rename is one MoveFileExW with MOVEFILE_REPLACE_EXISTING and nothing
// else — no retry, no MOVEFILE_COPY_ALLOWED — and MoveFileEx honours share
// modes: it fails outright while ANY other handle is open on the source or the
// target without FILE_SHARE_DELETE. A virus scanner or the search indexer opens
// files the instant they are written, so the target is briefly untouchable on a
// perfectly healthy machine. Node has declined to paper over this (nodejs/node
// #29481, closed wontfix: "not something that's really under Node's or libuv's
// control"), and libuv reverted its own four-attempt ladder for the same
// reason. So the policy lives here, where the stakes are known.
//
// The ladder is 10 attempts over ~1.4s, and the second number is the one that
// matters. It used to be 5 over 200ms, which is comfortably enough for the
// indexer and not enough for a scanner: the argument on libuv#2098 for
// reverting their retry was in part that an AV hold can outlast 2s, and 200ms
// of patience on a hold like that is the same as none.
//
// What that thinness cost is not an install. codex-auth.mjs stages a REFRESH
// TOKEN through this call, the old one is spent server-side by the time it runs,
// and a rename that gives up too early destroys the only copy of the new
// credential — the deck reports refresh_rejected and the user has to run
// `codex login` again. Trading a second of latency against that is not close.
// The comparison points: steno retries a rename 10 times at 100ms, npm's
// bin-links 5 times at 500ms exponential, and write-file-atomic does not retry
// at all (npm/write-file-atomic#227).
//
// POSIX never hits this path, and a genuinely permanent permission error costs
// that second and a half once, on a path that was already failing.
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function renameWithRetry(from, to, attempts = 10) {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts || !RENAME_RETRY_CODES.has(err?.code)) throw err;
      // Linear: 30, 60, 90 … 270ms, ~1.4s across the nine waits. Linear rather
      // than exponential because the holds this exists for are short and
      // frequent, and a doubling ladder spends its whole budget on the last
      // two waits.
      await delay(30 * attempt);
    }
  }
}

// Counts writes, not processes. The pid alone gave every call in one deck the
// same temp path, and there is more than one writer in a deck now: the sound
// toggle rewrites settings.json from a request handler, so two clients toggling
// within the same few milliseconds both opened that one path with O_TRUNC and
// both wrote their own JSON at offset zero. What got renamed over settings.json
// was the shorter payload with the tail of the longer one still behind it —
// unparseable, and readSettingsForWrite turns unparseable into a permanent
// SETTINGS_UNREADABLE refusal for every later toggle and install. The loser then
// found its temp file already renamed away and threw ENOENT on top of it.
let tmpSeq = 0;

/**
 * Create the temp file for one write, never sharing it with another writer.
 *
 * "wx" is the point of it: a name that already exists is an error here rather
 * than a silently truncated file two writers are both filling in. The only way
 * to meet a taken name is a deck killed between the write and the rename whose
 * pid the OS has since handed out again — that writer is gone by definition, so
 * the leftover is deleted and the next counter tried. Which is also the whole
 * story on litter: the names come from a small space, this pid crossed with the
 * first few counters, because a deck writes these files a handful of times per
 * run. Later runs walk the same names and sweep what they find instead of
 * piling fresh ones beside it. Digits and hyphens only — a legal filename
 * everywhere, Windows included.
 *
 * `mode` is the mode the file is created with, which matters when the bytes are
 * secret: codex-auth stages a rotated Codex refresh token here, and a temp file
 * that starts at the umask default is readable by every other account on the
 * box for as long as the write takes, whatever chmod follows it. O_EXCL is what
 * makes the mode binding — a create honours it only when it is the call that
 * makes the file, so adopting a leftover would keep the leftover's permissions.
 */
async function createTemp(target, { mode = 0o666, attempts = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const tmp = `${target}.agent-dag-${process.pid}-${tmpSeq++}.tmp`;
    try {
      return { tmp, handle: await open(tmp, "wx", mode) };
    } catch (err) {
      if (attempt >= attempts || err?.code !== "EEXIST") throw err;
      await unlink(tmp).catch(() => {});
    }
  }
}

// A chain longer than this is a loop, or something no real setup has: stow and
// chezmoi produce one hop, an encrypted volume two. The number is a bound on the
// walk below, not a promise about how deep a legitimate link goes.
const MAX_LINK_HOPS = 8;

/**
 * The file a name is really asking for — the one the links under it end at.
 *
 * A rename replaces the DIRECTORY ENTRY it is handed. Handed a symlink, it
 * deletes the link and leaves an ordinary file where it was, and
 * `~/.claude/settings.json` is a symlink on a great many machines: into a
 * dotfiles repo, a stow or chezmoi target, an encrypted volume. The content
 * survives — we write back what we read — so nothing looks wrong and nothing
 * says anything. The repo copy keeps what it said before, never goes dirty, and
 * from then on the user's edits there reach nobody while every launch rewrites
 * the detached file and widens the gap. This is a file the deck did not create
 * and does not own; quietly cutting it loose from the thing that manages it is
 * worse than failing to write it at all.
 *
 * persistAuth in codex-auth.mjs has resolved for exactly this reason since it
 * was written, on the file that is LESS often linked. This is the same rule at
 * the helper every settings writer in the deck goes through — and the same
 * function, so there is one of it rather than two that can drift.
 *
 * Resolving also decides which filesystem the temp file is staged on, and it has
 * to be the target's. A rename is atomic within one filesystem and fails with
 * EXDEV across two, so staging beside the LINK — a link into a dotfiles repo on
 * a separate volume — is a write that cannot land at all.
 *
 * A DANGLING link is the case realpath alone cannot answer: the target not
 * created yet, the encrypted volume not mounted. Answering it with the raw path
 * is the bug again, because that is precisely when the link gets replaced — so
 * the walk falls back to readlink, which reads a link without needing its target
 * to exist, and follows it the way opening the name for writing would.
 * `printf x > link` creates the target; it does not replace the link. If the
 * target's directory is gone the write then fails, which is the honest answer:
 * the bytes did not reach the file the user's setup points at.
 *
 * The ordinary case — a plain file, no link anywhere — is one realpath and the
 * first return.
 */
async function resolveWriteTarget(raw) {
  let at = raw;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    // Resolves every link on the path at once, when all of them lead somewhere.
    const real = await realpath(at).catch(() => null);
    if (real !== null) return real;
    const to = await readlink(at).catch(() => null);
    // Not a link, so nothing exists at this name yet and this name is the
    // answer: a first install, or the far end of a chain we have just followed.
    if (to === null) return at;
    at = resolve(dirname(at), to);
  }
  // Only a cycle gets here. Say so rather than pick a link out of it and
  // destroy that one — the OS answers a write through such a name the same way.
  const err = new Error(`too many symbolic links resolving ${raw}`);
  err.code = "ELOOP";
  throw err;
}

/**
 * Replace a file in a single step readers cannot land inside.
 *
 * The temp file is created beside the target rather than in $TMPDIR, because
 * rename is only atomic within one filesystem and the two are routinely on
 * different ones. It is fsync'd before the rename so that a crash or power loss
 * just after a successful install cannot leave the new directory entry pointing
 * at blocks that were never flushed — the classic file-of-zero-bytes.
 *
 * "Beside the target" means beside the file the name resolves to, not beside the
 * name: see resolveWriteTarget, which is what keeps a symlinked settings.json a
 * symlink.
 */
async function writeFileAtomic(rawTarget, text) {
  const target = await resolveWriteTarget(rawTarget);
  const { tmp, handle } = await createTemp(target);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // A rename creates a fresh directory entry, so the old file's mode does not
    // come with it. Carry it over — a settings.json the user chmod'ed to 600 has
    // to stay 600. No-op on Windows, where chmod only toggles the read-only bit.
    const mode = await stat(target).then(s => s.mode, () => null);
    if (mode !== null) await chmod(tmp, mode).catch(() => {});
    // A READ-ONLY TARGET IS A DEAD END ON WINDOWS, and only there. libuv's
    // rename is one MoveFileExW(MOVEFILE_REPLACE_EXISTING), which refuses to
    // replace a destination carrying FILE_ATTRIBUTE_READONLY; POSIX rename(2)
    // over a 0444 file succeeds, because only the parent directory's write bit
    // decides. A settings.json picks that attribute up from a OneDrive restore,
    // a copy off a network share, or read-only media — and EACCES is in the
    // retry ladder, so the whole ~1.4s was spent before throwing, on every
    // boot, forever. Every settings writer goes through here, so hooks never
    // installed and the sound-hook retirement could never repair a stale entry
    // either.
    //
    // chmod on Windows toggles exactly that attribute and nothing else, which
    // is why this is safe to do unconditionally there: the mode carried above
    // is re-applied to the new file after the rename, so a file the user marked
    // read-only stays read-only.
    // ONLY WHEN THE TARGET IS ACTUALLY READ-ONLY. Two extra syscalls on the
    // path between the temp write and the rename are not free on Windows:
    // discovery-live.test.ts hammers writeDiscovery while a reader holds the
    // destination open, and the wider window turned a rename the retry ladder
    // used to win into an EPERM it gave up on. The attribute is what this
    // clears, so a file that does not carry it has nothing to clear.
    const readOnly = process.platform === "win32" && mode !== null && (mode & 0o200) === 0;
    if (readOnly) await chmod(target, 0o666).catch(() => {});
    await renameWithRetry(tmp, target);
    if (readOnly) await chmod(target, mode).catch(() => {});
  } catch (err) {
    // Cleanup covers the write and the fsync as well as the rename: a full disk
    // used to leave the half-written temp file sitting beside the target.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// Exported for the other modules that rewrite settings.json — the sound toggle
// today. Every one of them needs the same two guarantees: a file we cannot
// parse is never treated as an empty one, and the replacement is a single
// rename rather than a truncate a reader can land inside. installScript carries
// the same guarantee to the hook scripts themselves, which are the files live
// sessions are actually executing, and renameWithRetry goes out on its own for
// the files writeFileAtomic cannot write — the fetched uv binary in
// uv-bootstrap.mjs — which still need the Windows retry. createTemp goes out for
// the same reason one step lower: codex-auth.mjs needs the collision-free temp
// name but not writeFileAtomic's mode handling, which carries over the target's
// mode and so would leave a brand-new auth.json at whatever the umask allows.
// resolveWriteTarget goes with them, because auth.json is linked into a dotfiles
// repo for the same reasons settings.json is, and "never rename onto a link" is
// one rule: codex-auth.mjs called a realpath of its own before this existed, and
// two spellings of a rule are two things that can drift.
// `stripBom` goes out on the same argument at the smallest scale. Two stores
// now move an unparseable file aside instead of writing defaults over it —
// deck-prefs.mjs since #1002 and browser-watch-store.mjs since #1003 — and all
// three readers have to mean the same thing by "a BOM is not damage". If they
// do not, a prefs.json or a state.json somebody opened in Notepad gets
// quarantined for a mark settings.json has ignored since this function was
// written.
export { readSettingsForWrite, writeFileAtomic, renameWithRetry, createTemp, resolveWriteTarget, stripBom };
