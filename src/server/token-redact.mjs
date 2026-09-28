// The deck's own token, taken back out of an event before anything stores it
// (#366).
//
// This lived in src/server/index.mjs, just above pushEvent, which calls it
// before anything else sees an event. It reads nothing but HOOK_TOKEN, so it
// moved to a leaf of its own; the walk is unchanged.
import { HOOK_TOKEN } from "./request-gates.mjs";

// What a redacted occurrence of the deck's token is replaced with. A visible
// marker rather than an empty string, because the reader of a mangled Bash
// output deserves to know the deck did it and why, and because the UI renders
// payload strings verbatim — a silent hole would look like a truncated tool
// response and get debugged as one.
const TOKEN_REDACTED = "[redacted: ccdeck token]";

/**
 * Take the deck's own token back out of an event, before anything stores it.
 *
 * #366 made HOOK_TOKEN the one credential separating "may read" from "may
 * mutate", and there is a path that copies it into a store needing no
 * credential to read. `POST /api/event` is deliberately open — hook/hook.js is
 * installed outside this package, into the user's ~/.claude, so requiring a
 * credential there would silence every session whose hook predates that change
 * — while `GET /api/events`, `GET /events` and events.jsonl are all readable
 * without one. So an agent session that merely LOOKS at the discovery file puts
 * the token into the ring buffer, and that is not an exotic act: `cat
 * ~/.claude/agent-dag/<pid>.json`, a `Read` of it, or a plain `grep -r
 * ~/.claude` all do it, and CC records both the tool input and the tool
 * response. From the buffer it is served to exactly the two callers #366 was
 * written for — the other local UID and the sandboxed subprocess — neither of
 * which can open the discovery file itself but both of which reach the API. For
 * them this turned "cannot mutate" back into "can mutate", the token read out
 * of the event log being the whole of the new gate. What keeps those two out of
 * the discovery file itself — a mode bit on Unix, the profile directory's ACL
 * on Windows, where the chmod is a no-op — is spelled out at presentsDeckToken.
 *
 * Why pushEvent calls this and not handleEventIngest, which is where the
 * report first put it. Events reach the buffer through more than one door:
 * handleEventIngest is the hook's, emitCodexEvent is the Codex rollout
 * watcher's — those events never pass through an HTTP handler at all —
 * replayLog is the boot replay's, `/api/clear` pushes its own marker, and six
 * enrichment sites push synthetic events off the back of a transcript read.
 * Redacting at the ingest handler covers one of those and leaves the next route
 * somebody adds uncovered. pushEvent is the one point every event passes
 * through exactly once, so the check is written once and cannot be forgotten.
 *
 * Why a walk over the string values rather than
 * `JSON.stringify(payload).includes(token)`, which is the obvious one-liner.
 * Measured rather than assumed, on 4.7k real payloads out of a 21MB
 * events.jsonl (mean 5KB serialized): the walk costs 1.3–3.6 µs per event and
 * serialize-then-search costs 14–48 µs, the same order as the JSON.parse the
 * ingest path already pays for the body. Serializing here would also defeat the
 * deliberate optimization in pushEvent, which skips serializing ENTIRELY when
 * nothing is subscribed and nothing is being logged — a headless deck, and the
 * boot replay of a log that only rotates at 50MB. The walk allocates nothing at
 * all until it finds something.
 *
 * Iterative rather than recursive on purpose. The payload arrives from
 * JSON.parse of a body capped at 5MB, which is free to nest as deeply as it
 * likes, and a recursive scan would be a new way to overflow the stack inside
 * the request listener — where nothing catches it.
 *
 * Scope is the token and nothing else in the discovery file. pid, port,
 * workspace, the log path and startedAt are not credentials — /api/health
 * already answers with the workspace path — and redacting the workspace would
 * mangle the `cwd` of every honest event the deck draws.
 *
 * What this does NOT catch, stated plainly so nobody mistakes it for more. A
 * token split across two string fields, or across two events, survives — but
 * every substring search has that shape, and the halves are individually
 * worthless: secretEquals is byte-exact, so a partial token authenticates
 * nothing. Case is not folded for the same reason; HOOK_TOKEN is lowercase hex
 * and an uppercased copy would not authenticate either.
 *
 * And this is not a new oracle. A caller who can POST here and read
 * /api/events can post a guess and watch whether it comes back redacted, which
 * tells them precisely what `x-ccdeck-token: <guess>` on any protected route
 * already tells them — against 256 bits with no structure to search.
 *
 * Returns the payload, because a top-level JSON string is a legal body for
 * `POST /api/event` and a primitive cannot be redacted in place.
 */
function redactDeckToken(raw) {
  // HOOK_TOKEN is request-gates.mjs's, and an import is bound before this
  // module's body runs, so it is set long before the first event arrives.
  const token = HOOK_TOKEN;
  if (typeof raw === "string") return raw.includes(token) ? raw.replaceAll(token, TOKEN_REDACTED) : raw;
  if (raw === null || typeof raw !== "object") return raw;

  const stack = [raw];
  while (stack.length > 0) {
    const node = stack.pop();
    // Arrays and objects are walked separately because an indexed loop over an
    // array is markedly cheaper than `for…in` over one, and this runs on every
    // event: a single PostToolUse response can be an array of thousands.
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === "string") {
          if (v.includes(token)) node[i] = v.replaceAll(token, TOKEN_REDACTED);
        } else if (v !== null && typeof v === "object") stack.push(v);
      }
    } else {
      // `for…in` is safe on these: they come from JSON.parse or from an object
      // literal in the server's own code, so the prototype chain is
      // Object.prototype, which has nothing enumerable. A `"__proto__"` key in
      // the posted JSON becomes an OWN data property — JSON.parse does not run
      // the setter — so it both enumerates here and takes the assignment below
      // as an ordinary write, leaving the prototype alone.
      for (const k in node) {
        const v = node[k];
        if (typeof v === "string") {
          if (v.includes(token)) node[k] = v.replaceAll(token, TOKEN_REDACTED);
        } else if (v !== null && typeof v === "object") stack.push(v);
      }
    }
  }
  return raw;
}

// What pushEvent calls. Listed rather than marked at the declaration, so the
// declaration reads as it did where it came from.
export { redactDeckToken };
