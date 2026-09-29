// The model a hook payload names, wherever in the payload it names it.
//
// Both CLIs put the id on different keys per event, so this walks the payload
// rather than reading one field — the envelope's own namespace only, never the
// tool's (see `FOREIGN_KEYS`). Nothing here touches the graph: which agent the
// answer is stamped on is the reducer's call.
import { bareModelId } from "./model-id";

/** Model ids we recognise. Claude family: claude-* . Codex family: gpt-*,
 *  o*-, codex-* . The regex is permissive on purpose — Codex publishes new
 *  slugs frequently and we'd rather pick up an unknown gpt variant than
 *  miss it.
 *
 *  Tested against the id with its provider namespace stripped (#475). This is
 *  the gate the whole Bedrock story turns on and the reason the issue's own
 *  account of the bug was one step short: a Bedrock id is
 *  `us.anthropic.claude-opus-5`, which failed `^claude` HERE, so the model was
 *  never attached to an agent at all and `ratesForModel` was never reached to
 *  return the `null` it was blamed for. Fixing the rate table without this one
 *  would have changed nothing a Bedrock user could see. */
const MODEL_PATTERN = /^(?:claude[-_]|gpt[-_]|o\d|codex[-_])/i;

/** The tool's own namespace, which is not the envelope's.
 *
 *  `tool_input` and `tool_response` are the only two fields on the wire that
 *  carry arbitrary foreign nested data — they are whatever the tool was called
 *  with and whatever it returned — and types.ts declares both `any`. Scanning
 *  into them let a tool's ARGUMENTS rename the session that called it:
 *
 *    after ModelObserved:                     gpt-5.6-sol
 *    after a tool_input naming another model: claude-opus-4-5
 *    after a nested tool_response model:      o3-mini
 *
 *  The first was an ordinary MCP call — `mcp__openai__chat` with
 *  `tool_input: { model: "claude-opus-4-5", messages: [...] }`. One call from
 *  any LLM-calling MCP server did it.
 *
 *  And it re-priced the session, not only the chip: usage-models.ts falls back
 *  to `[{ model: a.model, usage: a.usage }]` whenever `usageByModel` is absent,
 *  which is every Codex session, so the whole bill was recomputed at the stolen
 *  model's rate — $14.50 to $22.50 on a 2M/400K/5M session. The Codex path is
 *  also the least shielded: pushEvent's top-level stamp reads modelBySession,
 *  which is Claude-only.
 *
 *  NOT applied to extractUsage, which has no equivalent hole: its only caller
 *  is `extractUsage(p.tool_response)` in PostToolUse, and that one is
 *  deliberate — it reads a Task's usage off the tool result and assigns it to
 *  the TOOL CALL (`tc.usage`), never to the session. It is never handed a whole
 *  envelope, so there is nothing for it to wander into. */
const FOREIGN_KEYS = new Set(["tool_input", "tool_response"]);

/** Recursively look for a `model` string anywhere in the payload — both
 *  CCs surface it on different keys per event. Accept Claude or Codex ids. */
export function extractModel(node: unknown, depth = 0): string | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.model === "string" && MODEL_PATTERN.test(bareModelId(obj.model))) {
    // The RAW id is what is stored and passed on. pricing.ts and model-label.ts
    // each strip it again for their own matching, and both of them also have to
    // handle an id that arrives from somewhere other than here — so normalising
    // once, here, would buy nothing and would lose the string the model chip's
    // `title` and the usage panel's per-model key are meant to show.
    return obj.model;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (FOREIGN_KEYS.has(k)) continue;
    const m = extractModel(v, depth + 1);
    if (m) return m;
  }
  return null;
}
