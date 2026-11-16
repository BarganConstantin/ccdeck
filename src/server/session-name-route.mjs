// POST /api/session-name: a reader names a session in the deck, or clears the
// name they gave it (internal #101). The name is kept in session-names.json
// (session-deck-names.mjs) and announced on SessionNamed as `deckName`, so the
// list, the card, the Workspace header, the Inspector and quick open all read
// it from the one field they already read a session's name from.
//
//   { provider: "claude" | "codex", sessionId, name: string | null }
//
// An empty name, or null, clears it: the session reads by the provider's name
// again. Answers { ok: true, name } with the name as kept (cut to
// DECK_NAME_MAX, one line), or { ok: false, reason } — `bad_request` for a
// body that names no session or holds no name, `not_saved` when the file could
// not be written. Nothing is announced unless the write landed, so a page that
// saw an error still shows the name the deck has.
//
// It is behind the same three gates as every other route (index.mjs): a page
// of this deck, or a caller with its token.
import { PRODUCT } from "./brand.mjs";
import { readBody, send } from "./http-io.mjs";
import { cleanDeckName, deckNameKey, heldDeckNames, writeDeckName } from "./session-deck-names.mjs";
import { announceDeckName } from "./session-enrichment.mjs";

/**
 * At boot, after the log's replay: each kept name whose session the replay put
 * back in the ring, announced once and not logged again. The log normally
 * holds the write that set it already; this is for the log a rotation or a
 * size cap cut it out of, where the session's later events survived. A name
 * for a session not in the ring is left for that session's first live event
 * (session-enrichment.mjs, maybeAnnounceDeckName). Answers how many it told.
 */
export function announceKeptNames(envelopes, announce = announceDeckName) {
  const seen = new Set();
  for (const e of envelopes) {
    const sid = e?.payload?.session_id;
    if (typeof sid === "string" && sid) seen.add(sid);
  }
  let told = 0;
  for (const [, sid, name] of heldDeckNames()) {
    if (!seen.has(sid)) continue;
    announce(sid, name, { persist: false });
    told++;
  }
  return told;
}

export async function handleSessionNameWrite(req, res, { write = writeDeckName, announce = announceDeckName } = {}) {
  const raw = await readBody(req, res).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* answered below */ }
  if (!body || typeof body !== "object") return send(res, 400, { ok: false, reason: "bad_request" });
  const provider = body.provider ?? "claude";
  const { sessionId } = body;
  const name = cleanDeckName(body.name === "" ? null : body.name);
  if (!deckNameKey(provider, sessionId) || name === undefined) {
    return send(res, 400, { ok: false, reason: "bad_request" });
  }
  let kept;
  try {
    kept = await write(provider, sessionId, name);
  } catch (err) {
    // A data folder this user cannot write is the machine's to fix. The
    // error's code only: never the path, never the name.
    console.error(`${PRODUCT}: a session name was not saved (${err?.code ?? "error"})`);
    return send(res, 500, { ok: false, reason: "not_saved" });
  }
  announce(sessionId, kept);
  return send(res, 200, { ok: true, name: kept });
}
