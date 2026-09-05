// The half of "which agent is waiting on you" that no page can answer.
//
// The tab-side notifier (src/web/notify.ts) covers a deck that is open and
// hidden — behind another window, on another desktop, in a tab you have not
// looked at since lunch. It cannot cover the deck that is not open at all,
// because raising a notification from a page requires a page, and the case this
// whole feature exists for is the one where you walked away.
//
// The server can, and it already knows the one fact that makes it safe to:
// `sseClients.size`. Nobody is listening means nobody is being told by any
// other surface — the chip, the title, the favicon and the live region are all
// drawn inside a document that does not exist right now — so a notification
// here cannot duplicate one of them, and cannot arrive over a page the user is
// looking at. The two notifiers are exclusive by construction rather than by
// coordination, which is why neither has to know about the other.
//
// WHAT THIS DOES NOT DO IS DECIDE ANYTHING ABOUT AN AGENT. It reads one hook
// event and raises a desktop notification. The hook script still exits 0
// without writing to stdout, the deck still cannot allow, deny, defer or
// rewrite a tool call, and `hook-read-only.test.ts` still holds that. The
// distinction matters because "the deck notices your agent stopped" and "the
// deck answers for your agent" are one keystroke apart in this codebase and
// only one of them is a thing this product promises.
//
// Pure decisions here, the OS call injected, for the reason the web modules
// give: what the suite cannot run is what drifts. `notify` comes from
// browser-react.mjs, which already ships this on all three platforms for
// Browser Watch — osascript with argv on macOS, a WinRT toast on Windows,
// notify-send on Linux — so the platform work is done and tested and this is
// the second caller rather than a second implementation.
import { basename } from "node:path";

/** Set `AGENTS_DECK_NO_NOTIFY=1` to keep the deck off the desktop entirely.
 *  Same shape as AGENTS_DECK_NO_DOWNLOAD and AGENTS_DECK_NO_INSTALL, which is
 *  the sheet of switches a user already knows to look for. */
export const OFF_ENV = "AGENTS_DECK_NO_NOTIFY";

/**
 * How long one session stays quiet after it has been announced.
 *
 * The tab-side notifier keys its dedupe on `since`, which it can do because the
 * reducer refuses to re-stamp that field. Nothing here has a reducer: this sees
 * raw hook events, one at a time, and the same permission prompt can reach it
 * more than once — a hook retried, a deck replaying somebody else's log into
 * `POST /api/event`, or CC re-notifying about a prompt still standing.
 *
 * So the memo is a cooldown rather than an identity. Two minutes is chosen
 * against what it costs to be wrong in each direction: too short and one
 * unanswered prompt drums; too long and a genuinely new prompt on a busy
 * session is swallowed. A prompt answered inside two minutes did not need the
 * notification, and one that is still standing after two minutes is worth
 * saying again to somebody who is, by construction, not looking at a screen
 * that says it.
 */
export const QUIET_MS = 2 * 60 * 1000;

/** The one event that means a session has stopped and cannot start again
 *  without a human. `idle_prompt` is the other kind CC emits and is deliberately
 *  not here — #348 measured 16 idle to 5 permission, and an idle prompt is a
 *  turn that ended, not a session that is stuck. Three quarters noise is how a
 *  notification channel gets muted, and a muted channel is worse than none
 *  because the deck goes on believing it told somebody. */
export function isPermissionPrompt(raw) {
  return !!raw
    && raw.hook_event_name === "Notification"
    && raw.notification_type === "permission_prompt";
}

/**
 * What to put on the desktop.
 *
 * The title is the working directory's last segment, because that is what the
 * user calls the thing — "vcrm-core", not a UUID — and because a notification
 * title is the only line no platform truncates. The deck's own name goes in it
 * too: this arrives with no window and no tab beside it to say where it came
 * from, which is the one context the in-page notifier never has to supply.
 *
 * The body is CC's sentence, verbatim and alone. The tool guess that the tab
 * shows is deliberately absent: it is inferred by the REDUCER from the newest
 * call still in flight, and nothing on this side of the wire tracks in-flight
 * calls. Rebuilding that here to fill a notification body would be a second,
 * dimmer copy of a rule that already exists — the failure ambient-counts.ts and
 * block-announce.ts were both written to end.
 */
export function blockNotice(raw, product) {
  const cwd = typeof raw.cwd === "string" && raw.cwd ? basename(raw.cwd) : "";
  const who = cwd || (typeof raw.session_id === "string" ? raw.session_id.slice(0, 8) : "a session");
  const said = typeof raw.message === "string" && raw.message ? raw.message : "Needs your permission";
  return { title: `${who} — ${product}`, body: said };
}

/**
 * Should this event put something on the desktop?
 *
 * Four gates, and three of them are about a burst rather than a single
 * notification — a channel that fires twelve times in a second is one the user
 * turns off within the minute:
 *
 *   - a permission prompt, per `isPermissionPrompt`
 *   - NOTHING LISTENING. A page is a better surface than this in every way, so
 *     wherever there is one, this stays out of the way.
 *   - NOT A REPLAY. The server replays events.jsonl into itself at boot to
 *     rebuild the ring, and that log holds every permission prompt of the last
 *     50MB. Without this gate, starting the deck would announce the entire
 *     history of the machine at once.
 *   - the session has not just been announced, per `QUIET_MS`.
 */
export function shouldNotify(raw, { clients, replay, lastAt, now }) {
  if (!isPermissionPrompt(raw)) return false;
  if (clients > 0) return false;
  if (replay) return false;
  if (lastAt != null && now - lastAt < QUIET_MS) return false;
  return true;
}

/**
 * The stateful wrapper index.mjs holds: the per-session memo, and the call out
 * to the OS.
 *
 * `notify` and `now` are injected so the suite drives this without a desktop
 * and without a clock, and `enabled` is read once at construction rather than
 * per event — a switch that can change under a running process is a switch two
 * events in the same second can disagree about.
 */
export function createBlockNotifier({ notify, product, now = Date.now, enabled = true, onError }) {
  /** session_id → when it was last announced. Bounded by pruning on read: a
   *  long-lived server sees many sessions and this must not become a second
   *  ring nobody empties. */
  const seen = new Map();

  return {
    /** Returns what it did, for the tests and for nothing else. */
    consider(raw, { clients, replay = false }) {
      if (!enabled) return "off";
      const at = now();
      const id = raw?.session_id ?? "";
      if (!shouldNotify(raw, { clients, replay, lastAt: seen.get(id), now: at })) return "skipped";
      seen.set(id, at);
      for (const [key, when] of seen) if (at - when > QUIET_MS) seen.delete(key);
      const { title, body } = blockNotice(raw, product);
      // Fire-and-forget, and the catch is not decoration. `notify` shells out —
      // osascript, PowerShell, notify-send — and on a Linux box with no
      // notification daemon the last of those simply is not there. A rejected
      // promise from a notification must never take down the ingest path that
      // every hook event in the process goes through.
      Promise.resolve(notify(title, body)).catch(err => onError?.(err));
      return "notified";
    },
  };
}
