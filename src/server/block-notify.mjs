// The half of "which agent is waiting on you" that no page can answer.
//
// The tab-side notifier (src/web/notify.ts) covers a deck that is open and
// hidden — behind another window, on another desktop, in a tab you have not
// looked at since lunch. It cannot cover the deck that is not open at all,
// because raising a notification from a page requires a page, and the case this
// whole feature exists for is the one where you walked away.
//
// WHAT IT SAYS IS WHAT AN OPEN DECK WOULD HAVE PLAYED. With a tab open you hear
// a turn finish and hear Claude ask; with none open nothing plays, and those are
// exactly the moments somebody who walked away wanted. So a closed deck stands
// in for its own sounds rather than keeping a narrower rule of its own. See
// `isChimeEvent`.
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

/**
 * Would an open deck have played a tone for this?
 *
 * The page's rule, not a new one: `Stop` is the "turn finished" tone and every
 * `Notification` is "Claude is asking" (src/web/sound.ts `chimeFor`).
 *
 * WIDER THAN IT USED TO BE, ON PURPOSE. This was permission prompts and
 * questions only — `idle_prompt` and every finished turn left out, because
 * #348 measured idle at three quarters of what CC emits. What that cost is
 * the setup the deck's owner runs: under `bypassPermissions` Claude Code almost
 * never raises a permission prompt (one log: 14 idle, 1 permission), so the
 * notification this switch promised could not happen. The noise is held back
 * by the memo instead — see `memoKeys` — and the channel is still off until
 * somebody turns it on (deck-prefs.mjs).
 *
 * WRITTEN TWICE BECAUSE IT HAS TO BE. sound.ts is TypeScript bundled for the
 * browser and this runs in bare node, so neither can import the other.
 * notify-mirror.test.ts runs both over the same events and fails the day they
 * disagree, which is the only thing that keeps a mirrored rule a mirror.
 */
export function isChimeEvent(raw) {
  return !!raw && (raw.hook_event_name === "Stop" || raw.hook_event_name === "Notification");
}

/** Which of the two tones it would have been — sound.ts's names, so the
 *  desktop app can play the same one with the notification. */
export function chimeOf(raw) {
  return raw?.hook_event_name === "Stop" ? "done" : "needs-input";
}

/**
 * How long one session stays quiet about a FINISHED TURN after saying so.
 *
 * Far shorter than `QUIET_MS`, because every `Stop` is a different turn and
 * somebody answering from the terminal can finish two inside a minute — each is
 * the tone an open deck would have played. What this still stops is one `Stop`
 * delivered twice: a retried hook, or a second deck feeding the same log.
 */
export const TURN_QUIET_MS = 10 * 1000;

/**
 * Which memo entries speak for this event: its own, and any whose having been
 * said makes this one old news.
 *
 * The case with an `also` is the idle prompt. CC sends one a minute after a
 * turn ends with the input box still empty — so after a `Stop` that was already
 * on the desktop it says nothing new, and a second notification for the same
 * turn a minute later is exactly the drumming that gets a channel muted. The
 * tab plays both tones because a tone is gone in a second; a notification sits
 * in the tray. An idle prompt whose `Stop` was NOT said — the tab was open when
 * the turn ended and closed since — still is.
 */
export function memoKeys(raw) {
  const sid = raw?.session_id ?? "";
  if (raw?.hook_event_name === "Stop") return { own: `${sid}#turn`, also: [] };
  if (raw?.notification_type === "idle_prompt") return { own: `${sid}#idle`, also: [`${sid}#turn`] };
  return { own: sid, also: [] };
}

/** The quiet window this event is measured against. */
export function quietFor(raw) {
  return raw?.hook_event_name === "Stop" ? TURN_QUIET_MS : QUIET_MS;
}

/** Longest quoted body. macOS shows about two lines of this; the rest is
 *  still worth having in Notification Center, but not a transcript. */
export const TURN_BODY_MAX = 160;

/**
 * The body for a finished turn: what the agent last said, cut to what a tray
 * shows, or a plain sentence when there is nothing to quote — Codex's `Stop`
 * carries no message, and neither does an older Claude Code's.
 */
export function turnBody(raw) {
  const said = typeof raw?.last_assistant_message === "string"
    ? raw.last_assistant_message.replace(/\s+/g, " ").trim()
    : "";
  if (!said) return "Finished its turn";
  const chars = [...said];
  return chars.length > TURN_BODY_MAX ? `${chars.slice(0, TURN_BODY_MAX - 1).join("").trimEnd()}…` : said;
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
  if (raw.hook_event_name === "Stop") return { title: `${who} — ${product}`, body: turnBody(raw) };
  const fallback = raw.notification_type === "idle_prompt" ? "Waiting for your input" : "Needs your permission";
  const said = typeof raw.message === "string" && raw.message ? raw.message : fallback;
  return { title: `${who} — ${product}`, body: said };
}

/**
 * Should this event put something on the desktop?
 *
 * Four gates, and three of them are about a burst rather than a single
 * notification — a channel that fires twelve times in a second is one the user
 * turns off within the minute:
 *
 *   - something an open deck would have played a tone for, per `isChimeEvent`
 *   - NOTHING LISTENING. A page is a better surface than this in every way, so
 *     wherever there is one, this stays out of the way.
 *   - NOT A REPLAY. The server replays events.jsonl into itself at boot to
 *     rebuild the ring, and that log holds every permission prompt of the last
 *     50MB. Without this gate, starting the deck would announce the entire
 *     history of the machine at once.
 *   - the session has not just been announced, per `quietFor`.
 */
export function shouldNotify(raw, { clients, replay, lastAt, now }) {
  if (!isChimeEvent(raw)) return false;
  if (clients > 0) return false;
  if (replay) return false;
  if (lastAt != null && now - lastAt < quietFor(raw)) return false;
  return true;
}

/**
 * The stateful wrapper index.mjs holds: the per-session memo, and the call out
 * to the OS.
 *
 * `notify` and `now` are injected so the suite drives this without a desktop
 * and without a clock.
 *
 * `enabled` USED TO BE READ ONCE at construction, on the argument that a switch
 * changing under a running process is one two events in the same second can
 * disagree about. That was right while the only way to set it was an
 * environment variable, which cannot change under a running process at all. It
 * is a user-facing switch now — deck-prefs.mjs, flipped from the sound menu —
 * and a mute that only takes effect after a restart is not a mute. So it may be
 * a function, asked per event; two events in the same second disagreeing is the
 * correct behaviour when somebody pressed the switch between them.
 */
export function createBlockNotifier({ notify, product, now = Date.now, enabled = true, onError }) {
  const isEnabled = typeof enabled === "function" ? enabled : () => enabled;
  /** memo key (see `memoKeys`) → when it was last announced. Bounded by pruning on read: a
   *  long-lived server sees many sessions and this must not become a second
   *  ring nobody empties. */
  const seen = new Map();

  return {
    /** Returns what it did, for the tests and for nothing else. */
    consider(raw, { clients, replay = false }) {
      if (!isEnabled()) return "off";
      const at = now();
      const { own, also } = memoKeys(raw);
      const said = [own, ...also].map(k => seen.get(k)).filter(t => t != null);
      const lastAt = said.length ? Math.max(...said) : undefined;
      if (!shouldNotify(raw, { clients, replay, lastAt, now: at })) return "skipped";
      seen.set(own, at);
      for (const [key, when] of seen) if (at - when > QUIET_MS) seen.delete(key);
      const { title, body } = blockNotice(raw, product);
      // Fire-and-forget, and the catch is not decoration. `notify` shells out —
      // osascript, PowerShell, notify-send — and on a Linux box with no
      // notification daemon the last of those simply is not there. A rejected
      // promise from a notification must never take down the ingest path that
      // every hook event in the process goes through.
      Promise.resolve(notify(title, body, { chime: chimeOf(raw) })).catch(err => onError?.(err));
      return "notified";
    },
  };
}
