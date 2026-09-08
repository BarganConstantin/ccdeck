---
target: the version/restart banner
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-09-08T13-56-58Z
slug: src-web-app-tsx-ver-banner
---
# Critique — the version/restart banner (ver-banner)

Method: dual-agent (A: design review · B: detector + browser evidence), isolated, parallel.

## Design Health Score — 23/40

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | the idle clock lives in `idleSinceRef` (App.tsx:1469) and renders nowhere — a reader cannot tell whether the deck is 2s or 29s from killing its own process |
| 2 | Match system / real world | 3 | headline is exemplary; "idle" means `no agent active` (App.tsx:1471), so a user composing a prompt is "idle" and does not think so |
| 3 | User control and freedom | 2 | no confirm, arm, cancel or undo on the one irreversible act on the page |
| 4 | Consistency and standards | 2 | fourth spelling of a switch in this app; light-theme contrast measured under AA on both amber controls |
| 5 | Error prevention | 1 | the "only when nothing is running" rule is applied to the timer and not to the button |
| 6 | Recognition rather than recall | 2 | three of four explanations are hover-only `title`, the defect this same file condemns at App.tsx:3755 |
| 7 | Flexibility and efficiency | 3 | dismissal keyed per version, chip is the way back, preference persists |
| 8 | Aesthetic and minimalist | 3 | 12px, one line, colour confined — but the dot pulses forever for a fact that does not change |
| 9 | Error recovery | 3 | the failure path is the best-engineered part; a restart that never returns has no surface of its own |
| 10 | Help and documentation | 2 | the one real explanation renders only on the branch where the user cannot restart |
| **Total** | | **23/40** | |

## Design specificity

Product-specific writing on a generic chassis. The headline states two facts and carries the mechanism; strip the strings and the form is every Electron app's update bar. The specific charge: ccdeck is the only update bar that knows whether the user is busy right now (`busy`, App.tsx:1471, same render as the banner) and it spends that knowledge on a timer nobody asked for while withholding it from the button they press.

Deterministic scan: `detect.mjs --json src/web/App.tsx` → exit 0, `[]`. Weak signal, not cleanliness: a bare .tsx falls to the regex/source engine, which has no CSS and no layout and structurally cannot compute contrast, hit-target size or type-scale conformance.

Visual overlays: none. The banner only renders on a version mismatch; fetch interception failed (automation tab reports visibilityState "hidden"), and the banner was forced through the React fiber tree instead. Measurements below are from that real render; there is no overlay to inspect.

## Priority issues

### [P0] The manual press is the unguarded path
restart.ts:4 states the hazard (hook events fired during the gap "are gone for good"). The rule is enforced in `autoRestartStep` and nowhere else: `askRestart` has no busy check, and the server (index.mjs:4105) has none either. A user who reads the banner, decides deliberately and clicks mid-turn gets exactly the loss the rule exists to prevent, with a tooltip promising the canvas replays.
Fix: no dialog. Swap the button's own copy from the state already in memory — `Restart anyway` plus a visible `--warn` clause ("2 agents running — events fired during the restart are lost") when busy, `Restart now` plus "nothing running" when not.

### [P0] Auto-restart is on by default, silent, and states nothing
App.tsx:1403 defaults true when the key is absent; threshold 30s (restart.ts:14); the clock never renders. 30s is the worst possible threshold: `busy` falls to zero the instant an agent finishes, i.e. while the user is reading output and composing the next prompt. The rule aimed at a dead stretch and landed on the gap between turns.
Fix: render the countdown (`auto in 0:18`) — the countdown is the cancel affordance; raise the threshold to 3-5 minutes; give the auto-restart its own confirmation copy.

### [P1] Light-theme contrast under AA, measured on the real render
`Restart now` label on its own fill: 7.41:1 dark, 3.39:1 light. `auto when idle` (on): 11.34:1 dark, 4.20:1 light. Positional: the gradient reaches 0% only at the bar's right edge, so the figures get worse on a wider viewport. The switch's state is colour-only, where `.sm-toggle` moves a knob and `.ap-auto-state` writes the words.

### [P1] A hidden tab can restart the deck under the tab in use
App.tsx:1761 is a plain setInterval with no visibility gate. Chrome throttles background timers rather than stopping them, so a forgotten tab still evaluates the gate and calls askRestart. Same argument as #804, one layer out.

### [P2] The explanations are hover-only, in the file that condemned hover-only
Consequence, rule and mechanism all live in `title` (App.tsx:3797, 3802, 3811). The one real explanation renders only when `canRestart` is false — the users who can act never receive it.

## Persona red flags

All-day operator: default-on auto-restart with an invisible clock reads as an SSE bug; 30s matches their inter-turn rhythm exactly; the pulsing amber dot trains them to ignore the same signal the outage banner uses. Multiple tabs make the hidden-tab restart their bug.

First-timer: "Restart now" reads as maintenance; "auto when idle" is drawn as a caption, not a permission; an unbidden restart most likely reads as "it crashed and recovered", a permanent wrong belief formed in the first hour.

Keyboard / screen reader: every consequence and the whole risk model is in `title`.

## Minor observations

- The dot pulses 2.4s forever for an inert fact; the one moment motion would carry information (a 30s fuse burning) is the moment it carries none.
- `.ver-act` and `.ver-auto` measure 23.95px tall — 0.05px under SC 2.5.8, reached by coincidence of padding plus line-height rather than by decision. `.ver-close` has an explicit 24px.
- Every font size in the banner is on the closed ladder; all four controls have `:active` and reduced-motion neutralisation. Clean.
- The stylesheet comment claiming "3.74:1 in the light theme" computes to 4.02:1 from the current tokens.
- `strong` and `.ver-sub` are nowrap with no wrap rule: a narrow window with a sidebar open clips rather than reflows.

Persuade-mode instincts raised and declined: a "What's new" link, an animated countdown ring, anything celebratory on the done banner, and a confirmation modal over a live canvas.

## Questions

1. The deck knows whether it is safe to restart. Why is that knowledge spent on a timer the user did not ask for, and withheld from the button they did?
2. Why is a restart something the user should have to decide about at all, rather than a quiet status line plus an optional "sooner" button?
3. What is the pulsing amber dot for, on day three?
