// A name a reader can use, from a string that might be an id (#842).
//
// A card in a fresh tab was labelled `g-p-6aa65d20d024819183fe5a6484a9955c`.
// Cards and the session list name an agent by its directory's basename, and a
// subagent by the type it was spawned as — and either can be an id: a worktree
// or scratch directory named by a hash, a type minted with one in it. An id
// tells the reader nothing about which session it is, so a name that looks like
// one gives way to the nearest name that does not.

/** A run of hex this long is a hash or a uuid part, never a word somebody chose. */
const HEX_RUN = /[0-9a-f]{16,}/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(name: string): boolean {
  return HEX_RUN.test(name) || UUID.test(name);
}

/** The last segment of a path that reads as a name, walking up past any that
 *  look like ids. `/work/api/.worktrees/6aa65d20d024819183fe` gives `.worktrees`
 *  rather than the hash; a path of nothing but ids gives its last segment, so
 *  there is always an answer. */
export function readableBasename(path?: string): string | undefined {
  if (!path) return undefined;
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!looksLikeId(parts[i])) return parts[i];
  }
  return parts[parts.length - 1];
}
