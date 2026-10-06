// The Local network panel's four routes: what the panel draws, and the three
// writes it makes — an invite, a verb on one deck, and a round now.
//
// These lived in src/server/index.mjs, after the LAN engine, and moved once the
// engine had (see lan-deck.mjs). Each is a body read and handed to the engine,
// and the one that writes the settings — the peer route's accept and alias —
// writes through prefs-state.mjs, as the engine's own callbacks do. The route
// table and the gates in front of it stay in index.mjs, where the order they
// are asked in is written down.
import { cleanAlias, isAliasKey, lanEnabled, withAlias, withManualEntry } from "./deck-prefs.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { lanEngine, lastReach, refreshReach, tailnet } from "./lan-deck.mjs";
import { servedReach } from "./lan-reach.mjs";
import { IDLE_MS as TAILNET_IDLE_MS } from "./tailscale.mjs";
import { readBody, send } from "./http-io.mjs";

/** What the panel draws: the switch, this deck's own name and address, and who
 *  else is in the group. No passphrase, for the reason prefsPayload gives in
 *  prefs-routes.mjs. */
export function handleLanStatus(req, res) {
  refreshReach();
  // Behind the answer, like the reach probe: the dialog's poll is what finds a
  // Tailscale somebody installed while the deck was running.
  if (lanEnabled(heldPrefs.current())) void tailnet.freshen(TAILNET_IDLE_MS);
  // Read against what has got in since it was taken — see servedReach.
  const status = lanEngine.status();
  return send(res, 200, { ok: true, ...status, reach: servedReach(lastReach(), status.inboundAt) });
}

/**
 * Make an invite, put one away, or join on somebody else's.
 *
 * The token is the secret and it is never stored: minted on request, held in
 * memory until it expires or is used, and gone with the process. Nothing about
 * it reaches prefs.json, so a deck that restarts is offering nothing rather
 * than offering something its owner has forgotten they sent.
 */
export async function handleLanInvite(req, res) {
  const raw = await readBody(req, res).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* handled below */ }
  switch (body?.action) {
    case "make": {
      const made = lanEngine.invite();
      if (!made) return send(res, 409, { ok: false, reason: "not_running" });
      // AFTER the spread, not before: status carries its own `invite` — the
      // token and its expiry, which is all a panel needs — and letting that
      // overwrite this one dropped the address list the caller asked for.
      return send(res, 200, { ok: true, ...lanEngine.status(), invite: made });
    }
    case "withdraw":
      lanEngine.withdraw();
      return send(res, 200, { ok: true, ...lanEngine.status() });
    case "join": {
      const out = await lanEngine.join(body.token);
      if (!out.ok) return send(res, 200, { ok: false, ...out, ...lanEngine.status() });
      return send(res, 200, { ok: true, ...out, ...lanEngine.status() });
    }
    default:
      return send(res, 400, { ok: false, reason: "unknown_action" });
  }
}

/**
 * Accept a deck, dismiss a request, or unpair one.
 *
 * ONE ROUTE, THREE VERBS, in the shape the accounts panel already uses for its
 * own multi-verb writes. Each one takes a fingerprint and nothing else: the key
 * being pinned comes from what this deck actually saw on the wire, never from
 * the page, so a page cannot pair this deck with a key nobody has met.
 */
export async function handleLanPeer(req, res) {
  const raw = await readBody(req, res).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* handled below */ }
  const fp = body && typeof body.fp === "string" ? body.fp : null;
  if (!fp) return send(res, 400, { ok: false, reason: "bad_request" });
  switch (body.action) {
    case "accept": {
      const added = lanEngine.accept(fp);
      if (!added) return send(res, 409, { ok: false, reason: "not_seen" });
      // A deck we only HEARD is not pinned, it is dialled — see accept. The
      // address has to reach prefs or the next write of the settings wipes it:
      // setPeers replaces the dial list wholesale, on purpose, so an address
      // that lives only in memory disappears the first time anything else is
      // saved.
      if (added.dialled) {
        const entry = `${added.addr}:${added.port}`;
        // Inside the job, like `onDial` — the same whole-array patch computed
        // from the same stale copy, and the same address lost when two of them
        // land in one turn.
        try { await heldPrefs.update(withManualEntry(entry)); }
        catch { /* it is dialled this session; the next accept re-adds it */ }
      }
      return send(res, 200, { ok: true, added, ...lanEngine.status() });
    }
    case "dismiss":
      return send(res, 200, { ok: lanEngine.dismiss(fp), ...lanEngine.status() });
    // The undo for the one above. A deck that was told no stops asking; this is
    // how somebody who changed their mind lets it ask again.
    case "allow":
      return send(res, 200, { ok: lanEngine.allow(fp), ...lanEngine.status() });
    case "unpair":
      return send(res, 200, { ok: lanEngine.unpair(fp), ...lanEngine.status() });
    // WHAT THIS DECK CALLS THAT ONE, and nobody else sees it. Keyed by the
    // fingerprint, so it follows the machine across a new address or a new
    // name of its own choosing. An empty name takes the alias away.
    //
    // The whole map is rebuilt from the one on disk rather than sent by the
    // page, so two tabs renaming two decks cannot undo each other. It is
    // rebuilt inside the write's own job for that to be true: the held prefs
    // are an in-memory copy refreshed only when a previous write resolves, and
    // the patch is the whole map — so two renames in one turn both read before
    // either job ran, both answered 200, and the first name was never written.
    case "alias": {
      if (!isAliasKey(fp)) return send(res, 400, { ok: false, reason: "bad_request" });
      const name = cleanAlias(body.name);
      const next = await heldPrefs.update(withAlias(fp, name));
      await lanEngine.apply({ aliases: next.lan.aliases });
      return send(res, 200, { ok: true, ...lanEngine.status() });
    }
    default:
      return send(res, 400, { ok: false, reason: "unknown_action" });
  }
}

/** Ask every peer now rather than at the next tick — the button beside the
 *  list, for somebody who has just fixed a login on the other machine and does
 *  not want to wait a minute to see it arrive.
 *
 *  Or ONE peer, when the body names it: the `check now` in a deck's own
 *  dialog. A deck that only calls in has no address here, and says so rather
 *  than reporting a round that asked nobody. */
export async function handleLanSync(req, res) {
  const raw = await readBody(req, res).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* the whole-list press sends nothing to read */ }
  const fp = body && typeof body.fp === "string" ? body.fp : null;
  if (fp) {
    const done = await lanEngine.roundOne(fp);
    if (done == null) return send(res, 409, { ok: false, reason: "no_address" });
    return send(res, 200, { ok: true, done, ...lanEngine.status() });
  }
  const done = await lanEngine.round();
  return send(res, 200, { ok: true, done, ...lanEngine.status() });
}
