// The deck's settings routes: GET /api/prefs, which answers what a page may see
// of them and what the machine allows, and POST /api/prefs, which writes a
// patch and hands the result to the LAN engine.
//
// These lived in src/server/index.mjs, beside the desktop notifier that reads
// the same settings, and moved once the settings had (prefs-state.mjs) and the
// engine had (lan-deck.mjs): what is left of them is a body read, a write
// through the one, a push to the other, and an answer. The notifier stays in
// index.mjs, beside the desktop-app connections it notifies through.
import { notificationsOn, notificationsVetoed, prefsRefusalDetail, prefsWriteRefusal, publicPrefs, reportsVetoed } from "./deck-prefs.mjs";
import { PRODUCT } from "./brand.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { applyLanPrefs, forgetReach, resetLanLoaded } from "./lan-deck.mjs";
import { giveBackDeckFolders } from "./prefs-give-back.mjs";
import { readBody, send } from "./http-io.mjs";

/**
 * GET the deck's settings, and what the machine is allowing.
 *
 * THREE fields, not two, and the third is the one a first attempt got wrong.
 * `notificationsAllowed` is the effective answer, after the environment
 * variable has had its say — but "false" there means either "the user switched
 * it off" or "the machine forbids it", and the menu has to say a different
 * sentence for each. Deriving the second from the first made the switch read
 * "off — set at launch" the moment anybody turned it off on a deck launched
 * with no variable at all, which is the deck telling the user their own press
 * was somebody else's doing. `notificationsVetoed` answers only the machine's
 * half.
 */
function prefsPayload() {
  const prefs = heldPrefs.current();
  return {
    ok: true,
    // `publicPrefs`, never the held prefs whole. This route answers anything
    // that can reach the loopback port, and the LAN group passphrase is in the
    // stored object — one field, and sending it here would put it in front of
    // every page on the machine. What goes out is whether one is set.
    prefs: publicPrefs(prefs),
    notificationsAllowed: notificationsOn(prefs),
    notificationsVetoed: notificationsVetoed(),
    reportsVetoed: reportsVetoed(),
  };
}

export function handlePrefsRead(req, res) {
  return send(res, 200, prefsPayload());
}

/** POST a patch. Fields nobody sent keep their value — see writePrefs. */
export async function handlePrefsWrite(req, res) {
  const raw = await readBody(req, res).catch(() => null);
  let body = null;
  try { body = JSON.parse(raw ?? ""); } catch { /* handled below */ }
  if (!body || typeof body !== "object") return send(res, 400, { ok: false, reason: "bad_request" });
  // The reports switch has consequences a plain write would skip — a deletion
  // asked for — so it is changed only through /api/reports, and its state never
  // by the page at all (#1853).
  const { reports: _reports, report: _report, ...patch } = body;
  try {
    await heldPrefs.write(patch);
  } catch (err) {
    // A settings file or folder this user cannot reach is the machine's to fix,
    // not the deck's, and `guard`'s bare 500 left the panel with nothing to say
    // about it (#1335). Anything else is still a bug and still goes to `guard`.
    const reason = prefsWriteRefusal(err);
    if (!reason) throw err;
    console.error(`${PRODUCT}: settings were not saved:`, err?.message ?? err);
    // What blocked it, from closed sets and without the path, so a screenshot
    // of the panel is enough to tell the cases apart (#1335).
    const detail = prefsRefusalDetail(err);
    return send(res, 500, detail ? { ok: false, reason, detail } : { ok: false, reason });
  }
  // The engine reads its settings from here rather than holding its own copy,
  // so turning the switch off in the panel really does stop the sockets rather
  // than only changing what the panel says.
  await applyLanPrefs();
  // Somebody has just switched this on and is watching the panel for the answer
  // to one question: is anything going to turn up. Whatever the probe said
  // before is about a deck whose sockets were down — see forgetReach.
  if (body.lan?.enabled === true) forgetReach();
  return send(res, 200, prefsPayload());
}

/**
 * POST: give the deck's settings folder back to this user, through macOS's own
 * password dialog (#1711). No body — every path is the deck's own; see
 * prefs-give-back.mjs.
 *
 * AND THEN READ THE FILE AGAIN, AS A BOOT WOULD. A deck that started on a folder
 * it could not open is running on the defaults, and its LAN engine on a key it
 * made up and could not keep. Once the file is readable that is the wrong deck:
 * the settings are re-read, and the engine is handed the fields it authors off
 * the file again — the stored key and pairings — which is what a restart would
 * have done, without the restart.
 */
export async function handlePrefsGiveBack(req, res) {
  const out = await giveBackDeckFolders();
  if (!out.ok) return send(res, 409, { ok: false, reason: out.reason });
  if ((await heldPrefs.reload()) === "file") {
    resetLanLoaded();
    await applyLanPrefs();
  }
  return send(res, 200, { ...prefsPayload(), changed: out.changed });
}
