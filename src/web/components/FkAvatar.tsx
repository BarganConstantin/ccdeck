import React from "react";
import { graphemes } from "../git-chip";

// An author's avatar in the git view's Fork look — the history's rows, the
// commit strip and the Commit tab all draw this one: their initials on one of
// five colours, picked by a stable hash of the lower-cased e-mail (the name
// when there is none), so one person is one colour everywhere. Initials only:
// the deck never asks a network service for a picture.

/** How many avatar colours there are (`--fk-avatar-0` … `--fk-avatar-4`). */
export const AVATAR_TONES = 5;

/** The colour an author is drawn in, 0…4: FNV-1a, 32-bit, over the key — the
 *  same answer in every browser and on every run. */
export function avatarTone(name: string, email: string): number {
  const key = (email.trim() || name.trim()).toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % AVATAR_TONES;
}

/** Up to two initials: the first and last words' first characters, one for a
 *  name of one word. Bots' `[bot]` and anything in brackets is left out. */
export function initials(name: string): string {
  const words = name.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").split(/[\s._-]+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return "?";
  const first = (w: string) => graphemes(w.replace(/^[^\p{L}\p{N}]+/u, ""))[0] ?? "";
  const out = words.length === 1 ? first(words[0]) : first(words[0]) + first(words[words.length - 1]);
  return out.toLocaleUpperCase();
}

/** row: 16px, a history row; strip: 18px, the commit strip; card: 42px, the
 *  Commit tab. */
export type AvatarSize = "row" | "strip" | "card";

export function FkAvatar({ name, email, size }: { name: string; email: string; size: AvatarSize }) {
  return (
    <span className="fkm-ava" data-size={size} data-tone={avatarTone(name, email)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
