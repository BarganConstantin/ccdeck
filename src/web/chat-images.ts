// Pictures pasted into Chat's box: what one paste carries, what the box keeps,
// and how they reach the session once Send is pressed.
//
// ONE PASTE, EACH PICTURE ONCE. A browser lists a pasted screenshot twice, as
// an item and as a file of the same paste, so the items are read and the
// files only when there are none; and a picture listed twice over within one
// paste (the same name, size, type and time) is kept once. Words in the same
// paste are the textarea's, as any paste's: the box keeps them, and the
// picture goes beside them.
//
// NOTHING LEAVES THE PAGE BEFORE SEND. The box holds the clipboard's own
// bytes and draws them from memory. Only Send hands them to this machine's
// deck (POST /api/terminal/image, chat-image.mjs), which keeps each in a file
// of its own and answers its path.
//
// THE SESSION GETS WHAT TERM WOULD. Each path is pasted on its own, quoted as
// Term pastes a file dropped on it (terminal-file-drop.ts); Claude Code and
// Codex read a pasted picture's path as an image and put a placeholder in
// its place. They read the file in their own time, so the words and Enter go
// only once the screen shows the program took the picture: a new image
// placeholder ("[Image #1]"), or the file's own name if the program kept the
// path as words. Neither within IMAGE_TAKE_WAIT_MS, and nothing more is sent.
import { flatScreen } from "./ask-keys";
import { quoteDroppedPaths } from "./terminal-file-drop";

/** The agents that take a picture through their terminal: a pasted path to
 *  one (Chat's way), or Ctrl+V with one on the clipboard (Term's). */
export function takesImages(provider: string | undefined): boolean {
  return provider === "claude" || provider === "codex";
}

/** A picture in the box, waiting for Send. */
export interface ChatImage {
  id: number;
  blob: Blob;
}

/** The formats Claude Code and Codex take as an image, the deck keeps the same. */
export const CHAT_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** The pictures one message may carry. */
export const MAX_CHAT_IMAGES = 10;
/** The largest picture the deck keeps (chat-image.mjs CHAT_IMAGE_MAX_BYTES). */
export const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;
/** How long the program has to show it took a pasted picture. */
export const IMAGE_TAKE_WAIT_MS = 8000;

/** Why a pasted picture was not added. */
export type ImageRefusal = "type" | "size" | "count";

type PasteData = { items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }> | null; files?: ArrayLike<File> | null };

/** The pictures one paste carries, each once, in the clipboard's order. */
export function pastedImages(data: PasteData | null | undefined): File[] {
  if (!data) return [];
  const listed: File[] = [];
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) listed.push(file);
    }
  }
  if (!listed.length && data.files) {
    for (let i = 0; i < data.files.length; i++) {
      const file = data.files[i];
      if (file?.type.startsWith("image/")) listed.push(file);
    }
  }
  const seen = new Set<string>();
  return listed.filter(file => {
    const key = `${file.type}\n${file.size}\n${file.name}\n${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `images` with `files` added after them, and the first reason one was not. */
export function addImages(images: readonly ChatImage[], files: readonly Blob[]): { images: ChatImage[]; refused: ImageRefusal | null } {
  const next = [...images];
  let id = images.reduce((top, image) => Math.max(top, image.id), 0);
  let refused: ImageRefusal | null = null;
  for (const blob of files) {
    const why: ImageRefusal | null = !CHAT_IMAGE_TYPES.includes(blob.type) ? "type"
      : blob.size > MAX_CHAT_IMAGE_BYTES ? "size"
      : next.length >= MAX_CHAT_IMAGES ? "count" : null;
    if (why) { refused ??= why; continue; }
    next.push({ id: ++id, blob });
  }
  return { images: next, refused };
}

/** `images` without the one `id` names. */
export function removeImage(images: readonly ChatImage[], id: number): ChatImage[] {
  return images.filter(image => image.id !== id);
}

/** Where the focus goes once `id` is removed: the next picture's button, the
 *  one before when it was the last, or null for the box. */
export function focusAfterImage(images: readonly ChatImage[], id: number): number | null {
  const at = images.findIndex(image => image.id === id);
  if (at < 0) return null;
  return images[at + 1]?.id ?? images[at - 1]?.id ?? null;
}

/** What is pasted into the session for a kept picture: its path, quoted as a
 *  file dropped on Term is, or null for a path that could not be. */
export function imagePaste(path: string, platform?: string): string | null {
  return quoteDroppedPaths([path], platform);
}

/** The kept file's own name without its extension: what the screen shows of
 *  it when the program kept the path as words. */
export function imageToken(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  return name.replace(/\.[^.]*$/, "");
}

const placeholders = (screen: string) => (flatScreen(screen).match(/\[image\b/gi) ?? []).length;

/** Whether the screen shows the program took the picture pasted while it
 *  showed `before`: one image placeholder more than then, or the file's name
 *  (a wrapped line still reads whole). */
export function imageTaken(before: string, now: string, token: string): boolean {
  if (placeholders(now) > placeholders(before)) return true;
  return token.length > 0 && now.replace(/\s+/g, "").includes(token);
}
