import React from "react";
import { graphemes } from "../git-chip";

// An author's avatar in the git view's Fork look: their initials on one of five
// colours, picked by a stable hash of the lower-cased e-mail (the name when
// there is none), so one person keeps one colour everywhere. Initials only:
// the deck never asks a network service for a picture.

/** How many avatar colours there are (`--fk-avatar-0` … `--fk-avatar-4`). */
export const AVATAR_TONES = 5;

/** The colour an author is drawn in, 0…4. */
export function avatarTone(name: string, email: string): number {
  const key = (email.trim() || name.trim()).toLowerCase();
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % AVATAR_TONES;
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

/** 16: a history row; 18: the commit strip; 42: the Commit tab. */
export type AvatarSize = 16 | 18 | 42;

export function FkAvatar({ name, email, size = 16 }: { name: string; email: string; size?: AvatarSize }) {
  return (
    <span className="fk-avatar" data-size={size} data-tone={avatarTone(name, email)} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
