// The agent a commit message names in its trailers — evidence for commits the
// deck never watched being made, and weaker than having watched: the view
// labels it "from the commit message", never as seen.
//
// What counts:
//   Co-Authored-By: Claude …            Claude Code's default (any spelling of
//   Co-authored-by: … <…@anthropic.com>  the key; a name with the word Claude or
//                                        an anthropic.com address)
//   Co-authored-by: Codex <noreply@openai.com>   Codex CLI's default (the word
//                                        Codex, or an openai.com address)
//   Claude-Session: <link>               the session link Claude Code can add
//
// Only the trailer block counts — the message's last paragraph, as git reads
// it — so a body that merely mentions a trailer names nothing. The deck never
// writes a trailer; it only reads the ones that are there.
//
// Pure.

const CO_AUTHOR = /^co-?authored[- ]by$|^co-?author$/i;
const SESSION = /^claude[- ]session$/i;
const LINE = /^([A-Za-z0-9][A-Za-z0-9 _-]*?)\s*:\s*(.*)$/;

/** The agent one trailer names, or null. */
function agentOf(key, value) {
  const k = key.trim().toLowerCase().replace(/\s+/g, "-");
  if (SESSION.test(k)) return { agent: "claude", trailer: "claude-session" };
  if (!CO_AUTHOR.test(k)) return null;
  const v = String(value ?? "");
  const email = /<([^<>]*)>/.exec(v)?.[1]?.toLowerCase() ?? "";
  const name = v.replace(/<[^<>]*>/g, " ");
  if (/\bclaude\b/i.test(name) || /@anthropic\.com$/.test(email)) return { agent: "claude", trailer: "co-authored-by" };
  if (/\bcodex\b/i.test(name) || /@openai\.com$/.test(email)) return { agent: "codex", trailer: "co-authored-by" };
  return null;
}

/** `Key: value` pairs out of a message's trailer block (its last paragraph). */
function blockOf(message) {
  const lines = message.replace(/\r\n?/g, "\n").split("\n").filter(l => !l.startsWith("#"));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let start = lines.length;
  while (start > 0 && lines[start - 1].trim()) start--;
  // The subject paragraph is never a trailer block.
  if (start === 0) return [];
  return lines.slice(start);
}

/**
 * The agent a commit's trailers name: `{ agent, source: "trailer", trailer }`
 * for the first one that names an agent, else null.
 *
 * @param {unknown} input the full commit message; or the trailers already
 *   split out of it, as `"Key: value"` lines or `{ key, value }` pairs
 * @returns {{ agent: "claude" | "codex", source: "trailer", trailer: string } | null}
 */
export function trailerAttribution(input) {
  let pairs = [];
  if (typeof input === "string") {
    for (const line of blockOf(input)) {
      const m = LINE.exec(line.trim());
      if (m) pairs.push([m[1], m[2]]);
    }
  } else if (Array.isArray(input)) {
    for (const t of input) {
      if (typeof t === "string") {
        const m = LINE.exec(t.trim());
        if (m) pairs.push([m[1], m[2]]);
      } else if (t && typeof t === "object" && typeof (t.key ?? t.token) === "string") {
        pairs.push([t.key ?? t.token, t.value]);
      }
    }
  } else {
    return null;
  }
  for (const [key, value] of pairs) {
    const hit = agentOf(key, value);
    if (hit) return { agent: hit.agent, source: "trailer", trailer: hit.trailer };
  }
  return null;
}
