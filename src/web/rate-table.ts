// The rates pricing.ts prices a session from: one row per model family, each
// with where its numbers were read and when.
//
// Rates sourced from platform.claude.com/docs/en/about-claude/pricing on
// 2026-06-13. All values are USD per million tokens of the base API
// (no Batch discount, no data-residency multiplier). RATES is the standard
// speed. The fast-mode premium is FAST_RATES at the end of this file, and it
// applies only to the tokens whose usage says they ran fast (#754).
//
// Moved out of pricing.ts, which keeps the arithmetic: ratesForModel's
// lookup over this table, the cache-write split, what Codex bills its input
// on, and how a figure is printed. The rows are the half that changes
// whenever a vendor's page does, and the notes under them say why each row
// matches what it matches.

import type { ModelRates } from "./pricing";

// Sonnet 5 is $2 / $10, and this used to be a function of the clock.
//
// It launched on introductory pricing "through August 31, 2026", with an
// increase to $3 / $15 scheduled for September 1. So the rate was computed per
// call rather than pinned, precisely so the deck would not keep quoting the
// intro price after the cutover.
//
// THE INCREASE WAS CANCELLED. Anthropic's pricing page now says so outright:
// "The $2/$10 per million input/output token pricing for Claude Sonnet 5 …
// is now the standard price. The previously scheduled increase to $3/$15 per
// million input/output tokens on September 1, 2026 will not occur."
//
// The old code did the right thing with what had been announced, and then the
// announcement changed — so from 2026-09-01 until this was noticed, every
// Sonnet 5 session on every deck was costed fifty per cent high. That is the
// direction that matters: a rate table is a claim about somebody's money, and
// the failure mode of a scheduled change nobody re-checked is silent.
//
// A constant again, and no clock. Should a real increase ever be announced, the
// function this replaced is in the history and the shape is still supported by
// `ratesForModel` — but a date that has passed is not a thing to keep guessing
// at, and the introductory rate is now simply the rate.
const SONNET_5: ModelRates =
  { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 };

// THE `(?![-_.]\d{1,7}(?!\d))` ON EVERY CLAUDE ROW (#688). It is one assertion
// repeated on each row rather than a shared constant, so every row states its
// whole pattern where it stands. The suite reads each row off this table:
// bedrock-model-ids.test.ts sweeps them for a pinned id, so that a row added
// tomorrow with no pinned id fails its coverage sweep instead of quietly going
// unproven, and unrecognised-model-version.test.ts checks every Claude row
// carries this guard.
//
// What it asserts is not what `\b` asserts. `\b` says the version number ended.
// This says nothing that follows it is ANOTHER version number — and the gap
// between the two questions is the whole of #688. `^claude[-_]opus[-_]4(?:[-_.]1)?\b`
// reads `claude-opus-4-9` by taking the EMPTY branch of its optional `.1` and
// finding a boundary between the `4` and the `-`, so an Opus 4.9 nobody has
// priced yet was billed at the RETIRED Opus 4 rate: $15/$75 against the current
// tier's $5/$25, three times the real spend, printed as a confident figure with
// nothing on screen to say it was invented. `claude-opus-4-10` got there the
// same way — it tries `-1`, fails the boundary between `1` and `0`, backtracks,
// and settles on the bare `4`. The bare Sonnet 4 row swallowed `claude-sonnet-4-7`
// and everything above it identically; that one costs nothing today only because
// Sonnet 4 and 4.5/4.6 happen to share a price, which is a coincidence and not a
// guarantee. The gpt-5 row three hundred lines down already refuses exactly this
// guess in its own words, and this is that argument with the multiplier the other
// way up: an unrecognised model must reach NO row, so every surface prints
// UNPRICED_LABEL beside a real token count.
//
// WHY A DIGIT-RUN LENGTH AND NOT THE OBVIOUS `(?![-_.]\d)`. Refusing every digit
// that follows the version would refuse the commonest tail a Claude id has:
// `claude-opus-4-20250514` is Bedrock's Opus 4 and `claude-opus-4-1-20250805` is
// first-party Opus 4.1, both live ids pinned in bedrock-model-ids.test.ts, and
// both would have stopped pricing altogether — a fix that quietly unprices a
// real model is worse than the bug it closes. The only all-digit token that
// legitimately follows a version here is the eight-digit release date, so the
// rule is drawn on length: a run SHORTER than a date is another version, and
// this row does not know it. Vertex's `@20250805`, Bedrock's `-v1:0` revision
// and CC's `[1m]` banner all start on a character `[-_.]` does not accept, so
// none of them is affected either way.
//
// `rates` is either a fixed table entry or a function of the current time, for
// a model whose published price changes on a known date. No row is a function
// today — Sonnet 5's was, until its increase was cancelled (see SONNET_5).
export const RATES: Array<{ match: RegExp; rates: ModelRates | ((now: number) => ModelRates) }> = [
  // Fable 5.1 / Mythos 5.1 — $10 / $50, and a cache read of $0.25.
  //
  // The base price is Fable 5's and the cache read is not: these two are the
  // only models Anthropic prices cache hits at 0.025x the input rate instead of
  // the usual 0.1x, which is a 75% cut and the whole point of the release. An
  // agentic session is mostly cache reads, so inheriting Fable 5's $1 here
  // would have overstated a long session by a wide margin.
  //
  // Above the Fable 5 row because it is the more specific of the two, and the
  // table is first-match.
  { match: /^claude[-_](fable|mythos)[-_]5[-_.]1\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5, cacheWrite1h: 20 } },

  // Fable 5 / Mythos 5 — $10 / $50
  { match: /^claude[-_](fable|mythos)[-_]5\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 } },

  // Opus 5.5 — $4 / $20, and a cache read of $0.20 (#1330).
  //
  // Read 2026-09-28 from platform.claude.com/docs/en/about-claude/pricing:
  // "Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok |
  // $20 / MTok", with the footnote "Cache hits and refreshes on Claude Opus 5.5
  // are priced at 0.05x the base input price." The same five numbers are the
  // `claude-opus-5-5` entry in LiteLLM's catalog, which is what ccusage prices
  // from, and ccusage's own cost for this machine's Opus 5.5 days of 2026-09-27
  // and -28 lands inside the range these rates give for its unsplit cache
  // writes (every write at 5 minutes to every write at 1 hour). Opus 5's rates
  // overshoot that range before the writes are counted at all.
  //
  // Until this row the Opus 5 row's version guard refused the id, correctly,
  // and the Projects report summed the refusal as $0 beside 282M real tokens.
  // Inheriting Opus 5's row instead would have been the other mistake: the
  // cache read is $0.20 against Opus 5's $0.50, and on a session that is
  // mostly cache reads — 98.5% of the issue's bucket — Opus 5's prices
  // come to about twice what Opus 5.5 is billed.
  //
  // Above the Opus 5 row because it is the more specific of the two, the order
  // the Fable 5.1 row keeps above Fable 5.
  { match: /^claude[-_]opus[-_]5[-_.]5\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } },

  // Opus 5 — $5 / $25. Must precede the Opus 4.x rows: "opus-5" shares no
  // prefix with them, but keeping the generations in order stops the next
  // person from inserting a looser pattern above it.
  { match: /^claude[-_]opus[-_]5\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 } },

  // Sonnet 5.5 — $2 / $10, the same five numbers as Sonnet 5 (#1700).
  //
  // Read 2026-09-29 from platform.claude.com/docs/en/about-claude/pricing:
  // "Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok |
  // $10 / MTok", with no footnote, so its cache read is the standard 0.1x.
  // LiteLLM's `claude-sonnet-5-5`, which ccusage prices from, carries the same
  // five numbers.
  //
  // A row of its own although the rates match Sonnet 5's today. Loosening
  // Sonnet 5's guard would have priced it too, and would also have priced every
  // Sonnet 5.x nobody has read a price for (#688) — Opus 5.5 is the proof that
  // a ".5" can come with a different cache rate. Above Sonnet 5 because it is
  // the more specific of the two.
  { match: /^claude[-_]sonnet[-_]5[-_.]5\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 } },

  // Sonnet 5 — $2 / $10, the introductory rate that became the standard one
  // (see SONNET_5 above). The version guard keeps an unrecognised Sonnet 5.x
  // from inheriting a price it was never quoted.
  { match: /^claude[-_]sonnet[-_]5\b(?![-_.]\d{1,7}(?!\d))/i, rates: SONNET_5 },

  // Opus 4.5 - 4.8 — $5 / $25 (the "new" Opus tier introduced with 4.5)
  { match: /^claude[-_]opus[-_]4[-_.](?:5|6|7|8)\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 } },

  // Opus 4 / 4.1 (deprecated, but may still show up in older sessions) — $15 / $75
  { match: /^claude[-_]opus[-_]4(?:[-_.]1)?\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 } },

  // Sonnet 4.5 / 4.6 — $3 / $15
  { match: /^claude[-_]sonnet[-_]4[-_.](?:5|6)\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 } },

  // Sonnet 4 (deprecated) — same as 4.5/4.6
  { match: /^claude[-_]sonnet[-_]4\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 } },

  // Haiku 4.5 — $1 / $5
  { match: /^claude[-_]haiku[-_]4[-_.]5\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 } },

  // Haiku 3.5 (retired except Bedrock/Vertex) — $0.80 / $4
  { match: /^claude[-_]haiku[-_]3[-_.]5\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6 } },

  // ── OpenAI / Codex family ────────────────────────────────────────────────
  // Rates verified 2026-08-12 against developers.openai.com/api/docs/pricing,
  // models.dev, and the LiteLLM catalog.
  //
  // Cached input is a DISCOUNT, not an addition: OpenAI's input_tokens already
  // includes the cached portion, so costForUsage subtracts it before applying
  // the full input rate. cacheWrite is 0 for every family except gpt-5.6,
  // gpt-6 and gpt-6.1, the ones that publish a separate cache-write price.
  //
  // Order matters — the first match wins, so each family's variants precede
  // its bare alias.

  // gpt-6-astra — $10 / $50  (cached $1, cache write $12.50).  1.05M.
  //
  // Read 2026-09-15 from developers.openai.com/api/docs/pricing, where it was
  // then the only gpt-6 id, and from .../models/gpt-6-astra for the window
  // (#754).
  // Until then the id reached no row, so a Codex session on it added nothing
  // to the board's cost. These are the short-context standard rates, as every
  // row here is. The >272K tier ($20 / $75) is left out for the reason given
  // at the long-context note in pricing.ts. So is the Fast tier: the model page
  // prices it at "2x the applicable rates", but a Codex session's cost is
  // priced from its running total, which carries no tier. The tier lives in a
  // separate `thread_settings_applied` event, as the setting requested, and
  // Codex names the Fast tier both "fast" and "priority". See FAST_RATES at the
  // end of this file.
  //
  // #688's named-sibling guard from the first day rather than after a
  // mispricing: an `-astra-mini` or `-astra-pro` nobody has read a rate for
  // prints `not priced` rather than Astra's $10 / $50. A dated snapshot still
  // matches, because the guard refuses only a letter after the separator.
  { match: /^gpt[-_]6[-_]astra\b(?![-_][A-Za-z])/i,
    rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.50 } },

  // gpt-6.1-sol — $2 / $10  (cached $0.10, cache write $2.50).  1.05M.
  // gpt-6-sol   — $2 / $10  (cached $0.20, cache write $2.50).  1.05M.
  // gpt-6-luna  — $0.10 / $0.50  (cached $0.01, cache write $0.125).  1.05M.
  //
  // Read 2026-10-07 from developers.openai.com/api/docs/pricing (Standard,
  // short context; gpt-6-sol sits under "All models") and from the "Text
  // tokens" panel and the window on .../models/gpt-6.1-sol, .../gpt-6-sol and
  // .../gpt-6-luna, which quote the same numbers (#1885). Until then none of
  // the three reached a row, so a Codex session on one read "not priced".
  // Short-context standard rates, as every row here is: the >272K tier and the
  // Fast tier are left out for the reasons given at gpt-6-astra above.
  //
  // The two Sols differ only in the cache hit, $0.10 against $0.20 — 5% and
  // 10% of input on their model pages — so neither row may price the other,
  // and they cannot: `gpt-6.1` never reads as `gpt-6-`. Each carries #688's
  // named-sibling guard, like Astra's, so a `-mini` or `-pro` of any of them
  // prints `not priced` until a rate for it is read. There is no bare `gpt-6`
  // or `gpt-6.1` alias on either page, so neither id reaches a row.
  { match: /^gpt[-_]6[-_.]1[-_]sol\b(?![-_][A-Za-z])/i,
    rates: { input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.50 } },
  { match: /^gpt[-_]6[-_]sol\b(?![-_][A-Za-z])/i,
    rates: { input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2.50 } },
  { match: /^gpt[-_]6[-_]luna\b(?![-_][A-Za-z])/i,
    rates: { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 } },

  // gpt-5.6-cyber — $12.50 / $75  (cached $1.25, cache write $15.625).  400K.
  //
  // The cache write is 1.25x uncached, as its three 5.6 siblings are. A zero
  // here did two things at once, because `billedInputTokens` keys on the rate
  // being non-zero: the written tokens stayed on the input line at $12.50 AND
  // the cache-write line rendered "-". Zero remains correct for the older
  // families -- gpt-5.1-codex-max publishes no cache-write line at all.
  { match: /^gpt[-_]5[-_.]6[-_]cyber/i,
    rates: { input: 12.50, output: 75, cacheRead: 1.25, cacheWrite: 15.625 } },

  // gpt-5.6-luna — $0.20 / $1.20  (cached $0.02, cache write $0.25)
  { match: /^gpt[-_]5[-_.]6[-_]luna/i,
    rates: { input: 0.20, output: 1.20, cacheRead: 0.02, cacheWrite: 0.25 } },

  // gpt-5.6-terra — $2 / $12  (cached $0.20, cache write $2.50)
  { match: /^gpt[-_]5[-_.]6[-_]terra/i,
    rates: { input: 2, output: 12, cacheRead: 0.20, cacheWrite: 2.50 } },

  // gpt-5.6 / gpt-5.6-sol — $4 / $20  (cached $0.40, cache write $5).
  // Bare `gpt-5.6` is an alias for sol, so one row covers both.
  //
  // Cut after this file's 2026-08-12 sweep — -20% input, -33% output — and the
  // row sat at the old $5/$30 for five releases. Sol is the DEFAULT Codex
  // model, so this row prices most of what the deck reports for Codex, and it
  // was reporting a session ~38% dearer than it was.
  //
  // The `(?![-_][A-Za-z])` is #688's guard for a NAMED sibling rather than a
  // version one. `\b` is satisfied by the `-` of any suffix, so this row was
  // pricing gpt-5.6-pro, -mini and -nano — ids nobody has read a number for —
  // at sol's rate. The 5.4 generation is the measured precedent for how far
  // that can be off: -nano is $0.20/$1.25 against -pro's $30/$180, 150x under
  // one family prefix.
  //
  // This file states the rule at its o-series block: "a family prefix may only
  // price the ids it has actually read a number for." There the answer was
  // rows, because those siblings had published numbers and refusing to price
  // them would invent a gap. Here there are none to read, so the honest answer
  // is #688's — reach no row, and print `not priced`.
  //
  // Scoped to 5.5 and 5.6 deliberately: they are the two newest, the two whose
  // sibling set is incomplete, and the two where an unread name is most likely
  // to turn up. 5.4 and below carry their full sets above them.
  { match: /^gpt[-_]5[-_.]6(?:[-_]sol)?\b(?![-_][A-Za-z])/i,
    rates: { input: 4, output: 20, cacheRead: 0.40, cacheWrite: 5 } },

  // gpt-5.5-pro — $30 / $180  (no cached rate published)
  { match: /^gpt[-_]5[-_.]5[-_]pro/i,
    rates: { input: 30, output: 180, cacheRead: 30, cacheWrite: 0 } },

  // gpt-5.5 — $5 / $30  (cached $0.50)
  // Same guard, same reason. gpt-5.5-cyber is in OpenAI's pricing listing with
  // no clearly published public rate, and it landed here.
  { match: /^gpt[-_]5[-_.]5\b(?![-_][A-Za-z])/i,
    rates: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 } },

  // gpt-5.4-pro — $30 / $180  (cached $3)
  { match: /^gpt[-_]5[-_.]4[-_]pro/i,
    rates: { input: 30, output: 180, cacheRead: 3, cacheWrite: 0 } },

  // gpt-5.4-mini — $0.75 / $4.50  (cached $0.075)  ← before plain 5.4
  { match: /^gpt[-_]5[-_.]4[-_]mini/i,
    rates: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 } },

  // gpt-5.4-nano — $0.20 / $1.25  (cached $0.02)  ← before plain 5.4
  { match: /^gpt[-_]5[-_.]4[-_]nano/i,
    rates: { input: 0.20, output: 1.25, cacheRead: 0.02, cacheWrite: 0 } },

  // gpt-5.4 — $2.50 / $15  (cached $0.25)
  { match: /^gpt[-_]5[-_.]4\b/i,
    rates: { input: 2.50, output: 15, cacheRead: 0.25, cacheWrite: 0 } },

  // gpt-5.3-codex (and -spark) — $1.75 / $14  (cached $0.175).
  // The last codex-tuned model: there is no gpt-5.4/5.5/5.6-codex.
  { match: /^gpt[-_]5[-_.]3[-_]codex/i,
    rates: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },

  // gpt-5.2-pro — $21 / $168  (no cached rate published)
  { match: /^gpt[-_]5[-_.]2[-_]pro/i,
    rates: { input: 21, output: 168, cacheRead: 21, cacheWrite: 0 } },

  // gpt-5.2 — $1.75 / $14  (cached $0.175)
  { match: /^gpt[-_]5[-_.]2\b/i,
    rates: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 } },

  // The 5.1 and 5 generations. Rates verified 2026-08-17 against
  // developers.openai.com/api/docs/pricing and the per-model pages under
  // developers.openai.com/api/docs/models/*.
  //
  // The table used to stop at 5.2, which was not a decision about old models —
  // it is what a Codex user can be running today. `model = "gpt-5.1-codex-max"`
  // in ~/.codex/config.toml pins a live session to one of these ids, and every
  // rollout written before 5.2 shipped carries one, so the whole 5.1/5 estate
  // priced out at exactly nothing. Note what that does NOT look like: the cost
  // does not read $0.00, it disappears — every surface hides its cost element
  // when the total is zero, so the tokens are counted and no money is shown
  // beside them and nothing says why.

  // gpt-5.1-codex-mini — $0.25 / $2  (cached $0.025)  ← before the 5.1 rows
  { match: /^gpt[-_]5[-_.]1[-_]codex[-_]mini/i,
    rates: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 } },

  // gpt-5.1 and its codex / codex-max / chat-latest variants — $1.25 / $10
  // (cached $0.125). OpenAI prices the codex-tuned 5.1 models identically to
  // the base one, so a single row is the whole generation minus the mini tier.
  //
  // `(?!\d)` rather than the `\b` the rows above use, and the difference is not
  // cosmetic: `\b` is a boundary between a word character and a non-word one,
  // and `_` is a word character — so `gpt_5_1_codex`, a spelling every `[-_]`
  // in this table exists to accept, fails `\b` after the version digit and
  // reaches no row at all. The lookahead says what the boundary was for, which
  // is that `gpt-5.10` must not be read as `gpt-5.1`.
  { match: /^gpt[-_]5[-_.]1(?!\d)/i,
    rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },

  // gpt-5-pro — $15 / $120  (no cached rate published)
  { match: /^gpt[-_]5[-_]pro\b/i,
    rates: { input: 15, output: 120, cacheRead: 15, cacheWrite: 0 } },

  // gpt-5-mini — $0.25 / $2  (cached $0.025)  ← before bare gpt-5
  { match: /^gpt[-_]5[-_]mini/i,
    rates: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 } },

  // gpt-5-nano — $0.05 / $0.40  (cached $0.005)  ← before bare gpt-5
  { match: /^gpt[-_]5[-_]nano/i,
    rates: { input: 0.05, output: 0.40, cacheRead: 0.005, cacheWrite: 0 } },

  // gpt-5 / gpt-5-codex — $1.25 / $10  (cached $0.125).
  //
  // The lookahead is what keeps this row from becoming the catch-all that
  // CODEX_CONTEXT_DEFAULTS ends with (`{ match: /^gpt[-_]5/i, window: 400_000 }`
  // — see context-window.ts), and the asymmetry between the two tables is
  // deliberate rather than an oversight. A context window is a coarse
  // capability that moves in powers of ten and only sizes a donut, so guessing
  // 400K for an unrecognised gpt-5* is a good guess and a cheap wrong one. A
  // PRICE is the number a user checks their bill against: if OpenAI ships a
  // gpt-5.7 at $4/$20 and this row swallowed it, every surface in the deck
  // would print a confident figure a third of the real spend, with nothing on
  // screen to suggest it was invented. `not priced` beside the token count is
  // the honest answer to a model this build has never heard of, and refusing
  // the guess is what makes it reachable.
  { match: /^gpt[-_]5(?![-_.]\d)/i,
    rates: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } },

  // codex-mini-latest — retired 2026-02-12. Kept so historical sessions still
  // cost out; new sessions can no longer produce it.
  { match: /^codex[-_]mini/i,
    rates: { input: 1.50, output: 6, cacheRead: 0.375, cacheWrite: 0 } },

  // ── o-series reasoning models ────────────────────────────────────────────
  // Every rate from here to the end of the table re-verified 2026-08-26 against
  // the "Text tokens" panel on developers.openai.com/api/docs/models/<id>, one
  // page per row. The per-model pages rather than the summary table, because the
  // summary table is where this went wrong: developers.openai.com/api/docs/pricing
  // lists o1, o1-pro, o3, o3-mini, o3-pro and o4-mini and stops there. The three
  // tiers it omits are exactly the three ids that had no row here.
  //
  // #690: A SIBLING WITHOUT A ROW DOES NOT GO UNPRICED — IT INHERITS. `/^o1\b/i`
  // finds its boundary between the `1` and the `-` of `o1-mini` and hands it o1's
  // $15/$60, thirteen times the $1.10/$4.40 o1-mini is actually billed at.
  // `/^o3\b/i` read `o3-deep-research` the same way and quoted $2/$8 against a
  // published $10/$40, a fifth of the real spend. The sweep for this fix found a
  // third the issue had not: `/^o4[-_]mini/i` swallowed `o4-mini-deep-research`,
  // which is $2/$8 and not o4-mini's $1.10/$4.40.
  //
  // WHY ROWS AND NOT THE #688 GUARD, WHICH IS THE SAME BUG WITH A DIFFERENT
  // ANSWER. #688's `claude-opus-4-9` was a version nobody has published, so the
  // honest answer was to reach no row and print `not priced`. These three are
  // real models with real published numbers, and refusing to price a model whose
  // rate is on OpenAI's own page would be inventing a gap rather than a figure.
  // The rule that falls out of both: a family prefix may only price the ids it
  // has actually read a number for, and the way an o-series row says which those
  // are is that its more specific siblings sit above it.
  //
  // Order is load-bearing in one direction only — first match wins, so each of
  // the three new rows must precede the row it was being eaten by. The `[-_]`
  // spellings are the table's convention and are not decorative here: `\b` after
  // a digit is false against `_` (a word character), so `o1_mini` reached no row
  // at all before this and reaches its own now.

  // o1-pro — $150 / $600  (no cached rate published)
  { match: /^o1[-_]pro/i,
    rates: { input: 150, output: 600, cacheRead: 150, cacheWrite: 0 } },

  // o1-mini — $1.10 / $4.40  (cached $0.55)  ← before bare o1 (#690)
  { match: /^o1[-_]mini/i,
    rates: { input: 1.10, output: 4.40, cacheRead: 0.55, cacheWrite: 0 } },

  // o1 — $15 / $60  (cached $7.50).
  //
  // `o1-preview` rides this row and is left doing so deliberately: its own page
  // publishes $15 / $7.50 / $60, the same three numbers, so it is priced right
  // and a duplicate row would only be a second place to keep them in step. That
  // it is correct is checked, not assumed — the id is pinned in
  // o-series-sibling-rates.test.ts, so if either price ever moves apart the
  // suite says so instead of this comment quietly going stale.
  { match: /^o1\b/i,
    rates: { input: 15, output: 60, cacheRead: 7.50, cacheWrite: 0 } },

  // o3-deep-research — $10 / $40  (cached $2.50)  ← before bare o3 (#690)
  { match: /^o3[-_]deep[-_]research/i,
    rates: { input: 10, output: 40, cacheRead: 2.50, cacheWrite: 0 } },

  // o3-mini — $1.10 / $4.40  (cached $0.55)  ← before plain o3
  { match: /^o3[-_]mini/i,
    rates: { input: 1.10, output: 4.40, cacheRead: 0.55, cacheWrite: 0 } },

  // o3-pro — $20 / $80  (no cached rate published)
  { match: /^o3[-_]pro/i,
    rates: { input: 20, output: 80, cacheRead: 20, cacheWrite: 0 } },

  // o4-mini-deep-research — $2 / $8  (cached $0.50)  ← before o4-mini (#690).
  // Not in the issue; found sweeping the other `\b`-and-prefix rows for the same
  // shape. o4-mini's row is a plain prefix, so it reached this id with no word
  // boundary needed at all.
  { match: /^o4[-_]mini[-_]deep[-_]research/i,
    rates: { input: 2, output: 8, cacheRead: 0.50, cacheWrite: 0 } },

  // o4-mini — $1.10 / $4.40  (cached $0.275)
  { match: /^o4[-_]mini/i,
    rates: { input: 1.10, output: 4.40, cacheRead: 0.275, cacheWrite: 0 } },

  // o3 — $2.00 / $8  (cached $0.50)
  { match: /^o3\b/i,
    rates: { input: 2.00, output: 8, cacheRead: 0.50, cacheWrite: 0 } },
];

// ── Fast mode ──────────────────────────────────────────────────────────────
// The rates for a Claude request that ran at `speed: "fast"` (#754). Read
// 2026-09-30 from platform.claude.com/docs/en/about-claude/pricing, "Fast mode
// pricing": "Claude Opus 5.5 | $8 / MTok | $40 / MTok" and "Claude Opus 5 /
// Claude Opus 4.8 | $10 / MTok | $50 / MTok", "across the full context window",
// and "Prompt caching multipliers apply on top of fast mode pricing". So the
// cache columns are the page's own multipliers on the fast input rate: 1.25x
// for a 5-minute write, 2x for a 1-hour one, and 0.1x for a hit, which the
// same page puts at 0.05x on Opus 5.5. Claude Code's fast-mode page quotes the
// same two pairs.
//
// WHY A SECOND TABLE AND NOT A MULTIPLIER. Fast mode runs the same model id, so
// nothing in the id can pick the row; the speed is on each request's usage
// object instead. The API documents `usage.speed` as "fast" or "standard", and
// Claude Code writes that object into the transcript verbatim. A separate table
// keeps what is priced explicit: only the three models Anthropic lists, each
// with the #688 version guard its standard row carries, so an Opus 5.6 nobody
// has read a fast price for reaches no row here and is not priced at all.
// Opus 4.6 is left out because it runs a fast request at standard speed and
// reports `"standard"`; Opus 4.7 rejects the request.
//
// Codex has no rows here. OpenAI publishes a Fast column for every gpt-6 row
// (Astra $20 / $100, both Sols $4 / $20, Luna $0.20 / $1, each model page
// calling it 2x; read 2026-10-07), but the deck prices a Codex session from the
// rollout's running total, which carries no tier, so there is no share of it
// to apply the column to. The only tier a rollout records is the one the
// session ASKED for, `thread_settings_applied`'s `service_tier`, and Codex's
// own page (developers.openai.com/codex/speed) says Fast runs "where
// available", depending on "plan, client, workspace settings, and rollout",
// so the request is not evidence of the bill. Pricing it waits on a rollout
// that shows the tier a request was actually served at (#1884).
export const FAST_RATES: Array<{ match: RegExp; rates: ModelRates | ((now: number) => ModelRates) }> = [
  // Opus 5.5 fast — $8 / $40, cache read $0.40 (0.05x). Above Opus 5, the
  // order the standard table keeps.
  { match: /^claude[-_]opus[-_]5[-_.]5\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, cacheWrite1h: 16 } },

  // Opus 5 fast — $10 / $50
  { match: /^claude[-_]opus[-_]5\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 } },

  // Opus 4.8 fast — $10 / $50
  { match: /^claude[-_]opus[-_]4[-_.]8\b(?![-_.]\d{1,7}(?!\d))/i,
    rates: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 } },
];
