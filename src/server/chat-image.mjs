// A picture pasted into Chat's box, kept on this machine for the session the
// pane shows.
//
// Term takes a screenshot the way a terminal does: Ctrl+V goes to the program,
// which reads the image off this machine's clipboard itself
// (use-terminal-session.ts, CTRL_V). Chat cannot do that. Its picture was
// pasted into the page some time before Send, and by then the clipboard may
// hold something else, or nothing; two pictures are never on it at once. So
// Send hands the deck the picture's bytes, the deck keeps them in a file of its
// own, and the page pastes that file's path into the session: what Term pastes
// for a file dropped on it (terminal-file-drop.ts), and what Claude Code and
// Codex take as an image.
//
// NOTHING LEAVES THIS MACHINE. The route is a mutation behind the deck's gates
// (request-gates.mjs), so only the deck's own page or a caller holding its
// token is answered, and the page sends the bytes only when Send is pressed.
// The file is read by the agent on this machine, as any file it is pointed at.
//
// THE BYTES SAY WHAT IT IS. PNG, JPEG, GIF or WebP by their first bytes, never
// by a name or a content type the page chose, and the file's extension is the
// one those bytes earn. Anything else is refused before a byte is written.
//
// A FOLDER OF ITS OWN, KEPT SMALL. `chat-images` in the deck's data folder,
// 0700, each file 0600 under a random name. The agent reads a picture when its
// path is pasted, so a file is needed for minutes, not weeks: every save first
// removes the folder's pictures older than a week, past the newest hundred,
// or past 256 MB together. Only names this module gives are ever removed.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";

/** The largest picture the deck keeps: a full 5K screenshot as a PNG fits. */
export const CHAT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** How long a kept picture stays. */
export const CHAT_IMAGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** How many kept pictures stay, the newest first. */
export const CHAT_IMAGE_KEEP_COUNT = 100;
/** How many bytes of kept pictures stay, the newest first. */
export const CHAT_IMAGE_KEEP_BYTES = 256 * 1024 * 1024;

/** The names this module gives, and the only ones it removes. */
const OWN_NAME = /^[0-9a-f]{32}\.(?:png|jpg|gif|webp)$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Where the pictures are kept. */
export function chatImageDir(dataDir = deckDataDir()) {
  return join(dataDir, "chat-images");
}

/** The picture's format by its first bytes, as the extension it is kept
 *  under, or null for anything that is not a PNG, a JPEG, a GIF or a WebP. */
export function chatImageKind(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG)) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (/^GIF8[79]a/.test(head)) return "gif";
  if (bytes.length >= 12 && head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * Keep `bytes` as a picture for a session: `{ ok: true, path }`, the file's
 * absolute path, or `{ ok: false, code }` with "not-image", "too-large" or
 * "failed". Never throws. `dir` and `now` are for tests.
 */
export async function saveChatImage(bytes, { dir = chatImageDir(), now = Date.now(), platform = process.platform } = {}) {
  const kind = chatImageKind(bytes);
  if (!kind) return { ok: false, code: "not-image" };
  if (bytes.length > CHAT_IMAGE_MAX_BYTES) return { ok: false, code: "too-large" };
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // A folder made before, or by a mkdir under another umask, is narrowed too.
    if (platform !== "win32") await chmod(dir, 0o700);
    await pruneChatImages(dir, now, bytes.length);
    const path = join(dir, `${randomBytes(16).toString("hex")}.${kind}`);
    // `wx`: never over a file that is already there, whatever put it there.
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    return { ok: true, path };
  } catch {
    return { ok: false, code: "failed" };
  }
}

/**
 * Remove the kept pictures that are too old, or that would leave more than
 * CHAT_IMAGE_KEEP_COUNT, or more than CHAT_IMAGE_KEEP_BYTES, once one of
 * `incoming` bytes is added. Only regular files under this module's own names;
 * one that cannot be read or removed is left, and the save goes on.
 */
export async function pruneChatImages(dir, now = Date.now(), incoming = 0) {
  let names;
  try { names = await readdir(dir); } catch { return; }
  const kept = [];
  for (const name of names) {
    if (!OWN_NAME.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = await lstat(path);
      if (info.isFile()) kept.push({ path, at: info.mtimeMs, size: info.size });
    } catch {}
  }
  kept.sort((a, b) => b.at - a.at);
  let bytes = incoming;
  for (const [i, file] of kept.entries()) {
    bytes += file.size;
    const stale = now - file.at > CHAT_IMAGE_KEEP_MS || i >= CHAT_IMAGE_KEEP_COUNT - 1 || bytes > CHAT_IMAGE_KEEP_BYTES;
    if (!stale) continue;
    try { await unlink(file.path); } catch {}
  }
}
