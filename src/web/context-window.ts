// How many tokens a model's context holds, for the context donut.
//
// Moved out of pricing.ts, which held it because both tables are keyed on the
// same model ids. They answer different questions, and pricing.ts's bare gpt-5
// row argues the difference: a window is a coarse capability that only sizes a
// donut, so an id this build has never heard of gets a good guess here, while a
// price is the number a user checks their bill against, so the same id reaches
// no row there.

import { bareModelId } from "./model-id";

// The 1M-token window begins at the 4.6 generation -- it is NOT "every model
// above Haiku". Anthropic's context-windows page names the list exactly:
// Fable 5.1, Mythos 5.1, Fable 5, Mythos 5, Opus 5, Opus 4.8, Opus 4.7,
// Opus 4.6, Sonnet 5, Sonnet 4.6. "Other Claude models, including Claude
// Sonnet 4.5, have a 200k-token context window" -- and Opus 4.5 is one of the
// others. It was in the list below for five releases, which drew its donut at
// a fifth of the fullness it had. The model id sometimes carries a `[1m]`
// suffix (CC's UI banner uses it) -- treat that as an explicit override
// regardless of family.
const CONTEXT_WINDOW_DEFAULT = 200_000;
const CONTEXT_WINDOW_BIG = 1_000_000;

const BIG_CONTEXT_PATTERNS: RegExp[] = [
  /\[1m\]/i,                                  // explicit suffix
  /^claude[-_]opus[-_]5\b/i,                  // Opus 5
  /^claude[-_]sonnet[-_]5\b/i,                // Sonnet 5
  /^claude[-_]opus[-_]4[-_.](?:6|7|8)\b/i,    // Opus 4.6+ (4.5 is 200K)
  /^claude[-_]sonnet[-_]4[-_.]6\b/i,          // Sonnet 4.6
  /^claude[-_](fable|mythos)[-_]5\b/i,        // Fable/Mythos 5
];

// Codex context-window defaults, used only until the live
// `model_context_window` reaches the agent node — which comes from the rollout's
// `task_started` and `token_count` records, not from `session_meta`, whose
// `context_window` key holds a terminal window id and no token count (#399).
//
// These are the API's real windows. Note the Codex CLI reports something
// smaller — 258,400 for the gpt-5.6 family, being 272,000 x 95% — because it
// deliberately clamps a session below OpenAI's >272K-input pricing boundary
// rather than letting one silently cross it. The live value wins wherever it
// is available; these only cover first paint.
const CODEX_CONTEXT_DEFAULTS: Array<{ match: RegExp; window: number }> = [
  { match: /^gpt[-_]6[-_]astra/i,                 window: 1_050_000 },
  { match: /^gpt[-_]6[-_.]1[-_]sol/i,             window: 1_050_000 },
  { match: /^gpt[-_]6[-_](?:sol|luna)/i,          window: 1_050_000 },
  { match: /^gpt[-_]5[-_.]6[-_]cyber/i,           window:   400_000 },
  { match: /^gpt[-_]5[-_.]6/i,                    window: 1_050_000 },
  { match: /^gpt[-_]5[-_.]5/i,                    window: 1_050_000 },
  { match: /^gpt[-_]5[-_.]4[-_](?:mini|nano)/i,   window:   400_000 },
  { match: /^gpt[-_]5[-_.]4/i,                    window: 1_050_000 },
  { match: /^gpt[-_]5[-_.]3[-_]codex[-_]spark/i,  window:   128_000 },
  { match: /^gpt[-_]5[-_.]3[-_]codex/i,           window:   400_000 },
  { match: /^gpt[-_]5[-_.]2/i,                    window:   400_000 },
  { match: /^gpt[-_]5/i,                          window:   400_000 },
  { match: /^codex[-_]mini/i,                     window:   200_000 },
  { match: /^o\d/i,                               window:   200_000 },
];

export function contextWindowForModel(modelId: string | undefined): number {
  if (!modelId) return CONTEXT_WINDOW_DEFAULT;
  // Same strip as ratesForModel, and for the same reason: five of the six
  // BIG_CONTEXT_PATTERNS are `^claude`-anchored, so without it a Bedrock Opus 5
  // fell through to the 200K default and drew a context donut five times too
  // full. CODEX_CONTEXT_DEFAULTS needs no such care — no third party serves
  // OpenAI models to Claude Code, so a `gpt-*` id never carries this prefix —
  // but it costs nothing to pass the same string to both, and a table that had
  // to be told which half of the id to look at would be the thing that drifts.
  const bare = bareModelId(modelId);
  for (const p of BIG_CONTEXT_PATTERNS) if (p.test(bare)) return CONTEXT_WINDOW_BIG;
  for (const e of CODEX_CONTEXT_DEFAULTS) if (e.match.test(bare)) return e.window;
  return CONTEXT_WINDOW_DEFAULT;
}

/** The window to render for an agent. A live `model_context_window` observed
 *  from the CLI always wins; the static table above only covers first paint
 *  and providers that never report one. */
export function effectiveContextWindow(
  live: number | undefined,
  modelId: string | undefined,
): number {
  if (typeof live === "number" && live > 0) return live;
  return contextWindowForModel(modelId);
}
