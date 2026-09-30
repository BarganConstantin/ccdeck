# Product

<!-- impeccable:product-schema 1 -->

Derived from `README.md`, `LICENSING.md` and the code on 2026-09-26, revised
2026-09-27 after review, rather than from an interview — the README already carries
the product truth. Correct anything here that is wrong; it is the record every
design session reads first.

**Where this file and the README disagree, the README is right.** It is what users
actually read, and it is deliberately more careful than a summary tends to be.

## Platform

web

## Users

One person running several AI coding agents at once, on their own machines, in
their own terminals. Usually a developer with four to eight Claude Code and Codex
sessions live across several repositories, often across more than one machine.

They are not a team on a shared install. Everything is local and single-operator:
there is no ccdeck account and no sign-up. The Claude and Codex accounts the deck
manages are the user's own, held on their machine.

The state of mind that matters: **mild interruption.** They were doing something
else ten seconds ago and want to be doing it again ten seconds from now. They look
at the deck because something stopped, or they leave it open on a second monitor
while the work happens elsewhere.

## Product Purpose

A terminal shows an agent session as a scroll. It is actually a tree, and the
questions people have — *what is running right now, which subagent is stuck, what
is this costing, who is waiting on me* — are the ones a scroll answers worst.

ccdeck draws the tree instead, live, from Claude Code's hooks and Codex's rollout
logs.

Its sharpest job is narrower than that: **say which agent is blocked on a human,
and for how long.** Every stopped session tops the sidebar, longest wait first,
and the topbar's count goes straight to the oldest one. The question stops being
*which terminal tab* and becomes *this one*.

Success is that somebody never again loses twenty minutes to an agent that was
holding a permission prompt while the machine sat quiet.

## Positioning

The deck stands where the ground truth is: the hook stream itself, per node, per
tool call, with tokens, timing, cost and human interruption. It reports what
actually executed, not what an agent said it did.

Two properties a first-party vendor dashboard structurally cannot copy:

- **Cross-provider.** Claude Code and Codex on one canvas, told apart by the model
  chip.
- **Local and private.** No account, and nothing about a session leaves the
  machine.

And one nobody else has built: **the wait is the metric.** The scarce resource is
the operator's attention, not tokens.

The deck is an instrument panel and a flight recorder, not an orchestrator. It does
not schedule, assign or supervise agents, and the distinction is deliberate — see
Product Principles.

## Operating Context

- `npx ccdeck` opens `http://127.0.0.1:4317` (4318–4400 if taken), registers the
  Claude Code hook on first run, and keeps running after the terminal closes.
  `ccdeck --stop` is the off switch.
- A desktop app (macOS, Windows, Linux) wraps the same deck with a menu-bar / tray
  count and OS notifications. It needs no Node.js.
- Claude Code is captured through **hooks**; Codex by tailing its **rollout logs**,
  which is the only Codex capture available on Windows.
- Several Claude accounts can be signed in, switched, and shared to another
  machine. Paired machines on a LAN or tailnet repair each other's expired logins.
- Events append to a log in the platform's log directory (`--history` names it)
  and replay on open.
- No config file. The deck is expected to work from a cold `npx` with nothing set
  up.

## Capabilities and Constraints

**Confirmed capabilities:** live agent/subagent DAG with animated in-flight edges;
a blocked-on-you queue with wait times; per-model and per-session cost; Claude and
Codex quota windows; click-to-inspect any node (prompt, tool calls, tokens,
timing); host CPU/memory/thermals; multi-account management; LAN and tailnet
pairing with login repair; workspace scoping (`--scope`, `--workspace`);
self-update with a stale-module warning and self-restart.

**Browser Watch**, which is on unless switched off and is the one feature that is
about the user rather than about an agent. Every five minutes it copies each
Chromium profile's `History` database and looks for `FROM_API` visits — the mark an
agent's browser control leaves — so a run of them while nobody was at the machine
becomes a card. Its reactions are `notify`, `close-tab` (macOS only) and
`quit-browser` (every platform, and the only one that takes the session back). Any
UI copy claiming the deck looks only at agents would be false.

**Binding constraints, all of them load-bearing:**

- **No runtime dependencies.** `package.json` has no `dependencies` key; `npx
  ccdeck` is one tarball with nothing to install and no compiler. Spending this is
  a product decision, not an implementation detail. Separately, the tools the deck
  leans on — claude-swap from PyPI, ccusage from npm, `uv`, and `macmon` on Apple
  Silicon — it installs and updates itself, bounded to a version specifier;
  `AGENTS_DECK_NO_INSTALL=1` turns that off and `AGENTS_DECK_NO_DOWNLOAD=1` is the
  narrower version.
- **The hook is one-way.** It POSTs an event, exits `0`, writes nothing to stdout,
  and therefore *cannot* allow, deny, defer or rewrite a tool call. Pinned by
  `src/web/__tests__/hook-read-only.test.ts` against both the source and the real
  script.
- **Anonymous reports, on by default (#1853).** Nothing about a session is
  reported anywhere. What is: installs, updates, one "active" a day and the
  errors the deck runs into, scrubbed of folders, addresses and keys, under a
  random id tied to nothing on the machine. Nobody is asked; one switch under
  Appearance turns it off and deletes what was sent, and
  `AGENTS_DECK_NO_REPORTS=1` keeps it off from the first start. The owner chose
  on-by-default on 2026-09-30, over a one-time question built for the same issue.
  "No telemetry" is therefore a claim this product can no longer make, and copy
  must not make it: the claim it can make is about sessions.
- **The web server binds loopback.** LAN discovery and pairing are a separate
  surface and are **on unless switched off**: the deck announces itself over UDP
  45317 and pairs with the decks that answer. Outbound traffic is the README's list
  in *What it touches* — a version check, the managed installs and their daily
  checks, `macmon` on a silent Apple Silicon Mac, the desktop app's own update
  check, quota reads to Anthropic and OpenAI signed with the user's own
  credentials, and, to `api.ccdeck.dev`, anonymous reports unless they are
  switched off and feedback when the user presses Send. Privacy copy written
  against "loopback only" would overclaim.
- **Three platforms** from one codebase; macOS, Windows and Linux are peers.
- Licensed `AGPL-3.0-only`, sole copyright holder, contributions under the same
  licence. Not dual-licensed. See `LICENSING.md`.
- The deck **restarts itself** on self-update, so nothing may own state that
  cannot survive a restart.

**Terminology.** The nouns are *the deck*, *the canvas*, *a node*, *a session*, *a
subagent*, *the queue*, *quota*, *a pane*.

The one that matters is the stop, and the UI and the README use different registers
on purpose. **The shipped label is *waiting*** — `1 waiting`, `waiting 6m · Bash`,
`waiting on you:` — while *blocked on you* is the README's phrase for the concept.
Keep it that way: **the state is blocked, the label is waiting.** `waitingSentence`
is the source of truth for the string, and a design pass must not rename one to the
other across the UI.

A card's state words are *live* / *done* / *err*, from `stateLabel()` — `err` rather
than "failed" even in text nobody sees, because it is the word on the card.

*Not attachable* is a rule for a future string rather than a description of one: it
appears nowhere in the README or the UI today, and is written down here so that
whoever ships that state does not call it "unsupported".

## Brand Commitments

- **Name** is lower-case `ccdeck`, always, including at the start of a sentence.
- **Voice:** plain, exact, and unafraid of saying what the product cannot do. The
  README states the limits of every inferred value in the same breath as the value
  — that habit is the brand. No exclamation marks, no feature adjectives, and no
  minimising "simply" or "just" ("just run", "simply click"). The README's own
  "not just reading" is the acceptable sense and is not a violation.
- **The promise that must survive every feature:** *the deck cannot steer your
  agent* — precisely, it never allows, denies, defers or rewrites an agent's tool
  call, because the hook it installs has no channel to. The README's fuller wording
  is the honest one and should be matched rather than shortened: *"It never steers
  an agent or edits your code, but it is not read-only either."* If a change makes
  that sentence need a footnote, the change is wrong or the sentence has to be
  rewritten deliberately, in public.
- **"One canvas. No tabs. No kanban."** is a commitment, not a tagline. Anything
  that wants a tab bar is asking for the canvas.
- **The voice rules apply off-screen too.** The menu-bar or tray count and the OS
  notification are often where *waiting* reaches the user first, precisely because
  they are not looking at the deck. A notification names the session, the wait and
  the tool if one is known, in the same register as the card — never an
  exclamation, never a summary adjective.
- **Honest blindness.** Where the deck cannot know something it says so rather than
  guessing quietly — a Codex session's block, a synthetic session joined
  mid-flight, a permission prompt whose tool was inferred. Every such surface
  hedges its wording on purpose.

## Evidence on Hand

- `README.md` — the canonical product description, with the eight-picture first-run
  tour in `assets/guide/`.
- `assets/canvas.png` and `assets/canvas-demo.mjs` — a real canvas the deck drew
  itself.
- `ccdeck.dev` and the npm package.
- Real usage: the npm monthly-downloads badge in `README.md` carries the live
  figure. A number copied into this file is stale within weeks.

**Absences future work must not fabricate:** no customers, no testimonials, no case
studies, no revenue, no team, no pricing, no benchmark numbers against other tools.

## Product Principles

1. **Say who is blocked, and for how long.** Everything else on the canvas is
   context for that one sentence.
2. **Measure, do not steer.** The deck never allows, denies, defers or rewrites an
   agent's tool call. The things it does do — manage its two tools, refresh the
   Codex token it reads quota with, carry out a Browser Watch reaction the operator
   configured — are each listed in the README, each switchable off, and never
   decided by the deck on its own. Control that is added must be the human present
   in the loop.
3. **Name the blindness.** An inferred value is labelled as inferred; a thing the
   deck cannot see is said out loud. Never a confident guess.
4. **It must work from a cold `npx`.** No configuration, no account, nothing to
   read first. What the deck fetches for itself, it fetches after it is already up
   and never on the first run's critical path.
5. **Density serves the glance.** This is an instrument panel read in three
   seconds, not a screen to be dwelt in.

## Accessibility & Inclusion

Treated as a shipping requirement, not a pass at the end:

- Contrast floors are enforced by tests over the shipped token values in **both**
  themes — `contrast-floors.test.ts`, `control-edges.test.ts`,
  `usage-series-contrast.test.ts`. A colour that fails is a failing build. The
  floors themselves are stated once in `DESIGN.md`: 4.5:1 for text somebody reads,
  3:1 for control edges, strokes, series bands and meter fills, and decorative or
  disabled marks exempt. **The tests measure tokens, not composited opacity**, so a
  dimmed value can pass the build and still fail a reader.
- Light and dark are peers. Every hue is re-tuned per theme rather than inverted.
- `prefers-reduced-motion` is honoured throughout (25 blocks), and
  `forced-colors: active` is handled.
- Deck state changes are announced to screen readers
  (`accessibility-announcements-1016.test.ts`).
- Keyboard operation is first-class: a global `:focus-visible` ring, and scrollbars
  that appear on `:focus-within` as well as hover, because a scroller can be driven
  from the keyboard.
- **No keyboard traps.** Anything that takes the keyboard must have a discoverable
  way out.
