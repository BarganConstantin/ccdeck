// Token usage as the wire carries it, read into the deck's `TokenUsage`.
//
// Two producers write these objects and they do not spell them alike: the
// server's transcript readers (snake_case, in either provider's spelling of the
// cache lines) and a finished Task's tool result (Anthropic's own shape, nested
// wherever the response put it). Nothing here touches the graph: where a
// reading lands, and whether it is assigned or kept, is the reducer's call.
import type { TokenUsage } from "./types";

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
}

/** The TTL split of the cache-creation tokens, in either shape it reaches us:
 *  nested under `cache_creation` the way Anthropic writes it into a transcript
 *  line, or flattened onto the totals our own UsageObserved carries. Returns
 *  nothing at all when neither field is present — absent is not zero, and
 *  pricing.ts leans on that to keep a split-less session at the dollars it
 *  already showed. */
function cacheTtlSplit(
  obj: Record<string, unknown>,
): Pick<TokenUsage, "cacheCreate1hTokens" | "cacheCreate5mTokens"> {
  const nested = obj.cache_creation;
  const src = nested && typeof nested === "object"
    ? nested as Record<string, unknown>
    : obj;
  const h1 = src.ephemeral_1h_input_tokens;
  const m5 = src.ephemeral_5m_input_tokens;
  if (typeof h1 !== "number" && typeof m5 !== "number") return {};
  return {
    cacheCreate1hTokens: Number(h1 ?? 0),
    cacheCreate5mTokens: Number(m5 ?? 0),
  };
}

/** One wire usage object — the server's snake_case shape — as a `TokenUsage`.
 *
 *  Both spellings of the cache lines: Codex writes `cached_input_tokens` and
 *  `cache_write_input_tokens`, Claude writes `cache_read_input_tokens` and
 *  `cache_creation_input_tokens`, and this has to read whichever provider's
 *  reader produced it.
 *
 *  The cache-WRITE line took both spellings only from #400 on. Codex has
 *  carried `cache_write_input_tokens` in every `total_token_usage` object this
 *  machine holds, and it arrives here verbatim from the rollout, but the read
 *  asked for Claude's spelling alone and so dropped it — which mattered because
 *  gpt-5.6 is the first OpenAI family to publish a separate cache-write price
 *  ($6.25/Mtok on sol), and a rate with no token count to multiply is a line
 *  item pinned at $0.00 forever.
 *
 *  Written once here, and read for both the session's flat total and its
 *  per-model buckets, so the buckets cannot come to disagree with the total
 *  they were split out of (#686). The two TTL fields are always present, set to
 *  undefined when the wire carried no split: `UsageObserved` assigns this over
 *  the stored totals, and a key left off would keep a stale split standing. */
export function usageFromWire(u: Record<string, unknown>): TokenUsage {
  const ttl = cacheTtlSplit(u);
  const out: TokenUsage = {
    inputTokens: Number(u.input_tokens ?? 0),
    outputTokens: Number(u.output_tokens ?? 0),
    cacheReadTokens: Number(u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0),
    cacheCreateTokens: Number(u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? 0),
    cacheCreate1hTokens: ttl.cacheCreate1hTokens,
    cacheCreate5mTokens: ttl.cacheCreate5mTokens,
  };
  if (typeof u.reasoning_output_tokens === "number") {
    out.reasoningOutputTokens = Number(u.reasoning_output_tokens);
  }
  return out;
}

/** `UsageObserved`'s `usageByModel` as the reducer stores it, or undefined when
 *  the event carries none. An empty map is undefined too: "the scan attributed
 *  nothing" and "there is no split" are the same instruction to every reader,
 *  which is to price the flat total at the agent's own model. */
export function usageByModelFromWire(raw: unknown): Record<string, TokenUsage> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, TokenUsage> = {};
  for (const [model, u] of Object.entries(raw as Record<string, unknown>)) {
    if (!model || !u || typeof u !== "object") continue;
    const bucket = u as Record<string, unknown>;
    out[model] = usageFromWire(bucket);
    const bySpeed = speedSharesFromWire(bucket.speeds);
    if (bySpeed) out[model].bySpeed = bySpeed;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A per-model bucket's `speeds` — the share of its tokens the transcript
 *  billed at each speed other than standard (#754) — or undefined when it has
 *  none. Left off rather than set empty, so a bucket that never ran fast is the
 *  object it always was. */
function speedSharesFromWire(raw: unknown): Record<string, TokenUsage> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const shares = Object.entries(raw as Record<string, unknown>)
    .filter(([speed, u]) => speed && u && typeof u === "object")
    .map(([speed, u]) => [speed, usageFromWire(u as Record<string, unknown>)] as const);
  // fromEntries defines each key as its own property, so a speed spelled
  // `__proto__` is a share like any other rather than a prototype assignment.
  return shares.length ? Object.fromEntries(shares) : undefined;
}

/** Recursively look for a `usage` object with numeric token fields in any
 *  shape Anthropic / CC might deliver (top-level, nested under message, etc.).
 */
export function extractUsage(node: unknown, depth = 0): TokenUsage | null {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const obj = node as Record<string, unknown>;
  // Direct shape: { input_tokens, output_tokens, ... }
  if (
    typeof obj.input_tokens === "number" ||
    typeof obj.output_tokens === "number" ||
    typeof obj.cache_read_input_tokens === "number" ||
    typeof obj.cache_creation_input_tokens === "number"
  ) {
    return {
      inputTokens: Number(obj.input_tokens ?? 0),
      outputTokens: Number(obj.output_tokens ?? 0),
      cacheReadTokens: Number(obj.cache_read_input_tokens ?? 0),
      cacheCreateTokens: Number(obj.cache_creation_input_tokens ?? 0),
      ...cacheTtlSplit(obj),
    };
  }
  // Nested: { usage: { ... } } or { message: { usage: {...} } } etc.
  for (const v of Object.values(obj)) {
    const u = extractUsage(v, depth + 1);
    if (u) return u;
  }
  return null;
}
