// A few characters of a session id, for the places that show one to tell two
// sessions apart: a cluster header, a row in the usage list, an export's file
// name.
//
// FROM THE TAIL, NOT THE HEAD (#1732). A Claude session id is a UUIDv4, random
// from its first character. A Codex one is a UUIDv7, and a UUIDv7 opens with
// the moment it was minted — 48 bits of Unix milliseconds — so its first four
// hex digits change only every 2^32 ms (about 49.7 days) and its first eight
// every 2^16 ms (about 65.5 s). Every Codex session started from late August to
// mid-October 2026 begins `01a0`, and two sessions launched together share
// their first eight. The last digits are random in both versions, so they are
// the ones that can tell two ids apart.

/** Only the letters and digits of an id: a uuid's dashes carry nothing, and a
 *  fragment that ends in one is a character wasted. */
function alnum(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "");
}

/** The last `n` letters and digits of `id` — all of them when it has fewer. An
 *  id with none at all is returned whole, rather than as an empty fragment. */
export function idTail(id: string, n: number): string {
  const s = alnum(id);
  return s ? s.slice(-n) : id.slice(-n);
}

/**
 * The shortest tail of `id`, never shorter than `min`, that no id in `peers`
 * ends in.
 *
 * For the places that exist only to disambiguate. Sixteen random bits make two
 * sessions' last four digits agree one time in 65,536, and "one time in 65,536
 * the two rows read the same" is the defect over again, so the fragment grows
 * by exactly as much as the ids it has to be told from require — which for
 * real ids is almost always not at all. An id listed among its own peers is
 * ignored, and two ids that are equal end to end cannot be told apart by any
 * length: the whole of it is returned.
 */
export function distinctIdTail(id: string, peers: Iterable<string>, min = 4): string {
  const mine = alnum(id);
  if (!mine) return idTail(id, min);
  let need = min;
  for (const peer of peers) {
    if (peer === id) continue;
    const theirs = alnum(peer);
    let shared = 0;
    while (shared < mine.length && shared < theirs.length
      && mine[mine.length - 1 - shared] === theirs[theirs.length - 1 - shared]) shared++;
    need = Math.max(need, shared + 1);
  }
  return mine.slice(-need);
}
