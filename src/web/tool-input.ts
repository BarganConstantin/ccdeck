// The one line of a tool's input a human should be shown.
//
// `shortPreview` in tool-calls.ts JSON-stringifies whatever it is given, which is
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

/** The keys whose value names a file or a folder. */
const PATH_KEYS: ReadonlySet<string> = new Set(["file_path", "path", "notebook_path"]);

/** Longer than the sidebar can show and shorter than a notification body will
 *  hold, so both callers can trim further without this having thrown anything
 *  away that they wanted. */
const MAX = 120;

const clip = (s: string): string => (s.length > MAX ? `${s.slice(0, MAX - 1)}…` : s);

/** A path is kept whole up to this, which no real one reaches; past it, it
 *  loses its start and keeps its name, so a notification never carries an
 *  unbounded string. */
const PATH_MAX = 512;

const clipPath = (s: string): string => (s.length > PATH_MAX ? `…${s.slice(-(PATH_MAX - 1))}` : s);

/** The salient string, and whether it is a path. */
export interface SalientField {
  text: string;
  /** The string names a file or a folder: a row shortens it from the front
   *  (rail-row-copy.ts rowPath), so it is kept whole here. Clipped at the end
   *  like a command, a long path lost the one part that tells files apart,
   *  its name. */
  path: boolean;
}

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
  return salientField(input)?.text ?? null;
}

/** salientInput, saying whether the string is a path (see SalientField). */
export function salientField(input: unknown): SalientField | null {
  if (typeof input === "string") return input.trim() ? { text: clip(input.trim()), path: false } : null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  for (const key of KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) {
      const path = PATH_KEYS.has(key);
      return { text: path ? clipPath(v.trim()) : clip(v.trim()), path };
    }
    // The Codex `shell` tool passes an argv array. Joined rather than picked
    // apart: unwrapping the interpreter is skin work, and a human reading
    // "powershell.exe -NoProfile -Command git status" has still been told what
    // is about to run.
    if (Array.isArray(v) && v.length > 0 && v.every(x => typeof x === "string")) {
      const joined = (v as string[]).join(" ").trim();
      if (joined) return { text: clip(joined), path: false };
    }
  }
  return null;
}
