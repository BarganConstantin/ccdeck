// The one line of a tool's input a human should be shown.
//
// `shortPreview` in reducer.ts JSON-stringifies whatever it is given, which is
// right for what it was written for — the tool modal, where the reader wants the
// shape of the object. It is wrong everywhere the string is read as a sentence:
// a sidebar tooltip and a desktop notification saying
//
//     Likely on: Bash · {"command":"rm -rf node_modules"}
//
// have buried the only four words that matter inside punctuation, in the exact
// place somebody is deciding whether to approve that command. The braces are
// noise and the key name is noise; `rm -rf node_modules` is the whole message.
//
// WHY THIS IS NOT ToolBursts' `commandStringOf`. That function answers a
// different question and answers it with more machinery: it feeds a bubble SKIN,
// so it unwraps Codex `script` payloads to find the program underneath, digs the
// real command out of a `["powershell.exe","-Command",…]` wrapper, and hands the
// result to a parser that reduces it to one token for an emoji. What it returns
// is an input to more processing. This returns the string a person reads, keeps
// the whole command rather than its first word, and is DOM-free so the reducer
// and the bare-node suite can both call it — which the component cannot be.
//
// The overlap is the field precedence, and that is deliberately narrow here: the
// two keys that carry almost every permission prompt, plus the handful that make
// the rest legible instead of blank.

/** Keys worth reading, in the order a prompt is likely to be about them.
 *  `command` first because Bash is what gets asked about most and is the one
 *  where the words genuinely change the answer; `file_path` next because Edit
 *  and Write are the rest of it. */
const KEYS = ["command", "cmd", "file_path", "path", "url", "pattern", "notebook_path"] as const;

/** Longer than the sidebar can show and shorter than a notification body will
 *  hold, so both callers can trim further without this having thrown anything
 *  away that they wanted. */
const MAX = 120;

const clip = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

/**
 * The salient string in a tool input, or null when there is not one.
 *
 * NULL RATHER THAN A STRINGIFIED OBJECT is the point of the whole module. A
 * tool whose input has no key worth reading — an MCP call with six options, a
 * tool taking a structured document — is better shown as its bare name than as
 * a brace-heavy fragment of JSON that stops at 80 characters mid-key. The
 * callers already render the name on its own, so null costs nothing and buys
 * every unrecognised shape a clean line.
 */
export function salientInput(input: unknown): string | null {
  if (typeof input === "string") return input.trim() ? clip(input.trim()) : null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  for (const key of KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return clip(v.trim());
    // The Codex `shell` tool passes an argv array. Joined rather than picked
    // apart: unwrapping the interpreter is skin work, and a human reading
    // "powershell.exe -NoProfile -Command git status" has still been told what
    // is about to run.
    if (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string")) {
      const joined = (v as string[]).join(" ").trim();
      if (joined) return clip(joined);
    }
  }
  return null;
}
