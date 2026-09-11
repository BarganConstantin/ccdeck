---
target: Local Network deck rows — hover and focus
total_score: 10
max_score: 20
na_heuristics: 2,3,6,9,10
p0_count: 0
p1_count: 2
timestamp: 2026-09-11T12-15-05Z
slug: src-web-components-lansyncsection-tsx
---
Method: dual-agent (A: design review · B: detector + browser evidence)

Scope: hover, press and keyboard focus of the deck rows in Local network — nothing else on the surface.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Feedback is immediate; leftover states (fades, focus-within) muddy it |
| 2 | Match System / Real World | n/a | A hover state has no wording |
| 3 | User Control and Freedom | n/a | No undo surface in a hover |
| 4 | Consistency and Standards | 2 | Two radii in one row (5px tone, 999px verb pill); hover lifts grey text, focus does not |
| 5 | Error Prevention | 1 | A double-click on the row's right end arms and confirms `unpair` |
| 6 | Recognition Rather Than Recall | n/a | Nothing to recall |
| 7 | Flexibility and Efficiency | 2 | Ten Tab stops for five rows, no arrow keys |
| 8 | Aesthetic and Minimalist Design | 2 | Card-sized tone, off-centre name, focus is the heaviest state |
| 9 | Error Recovery | n/a | No error messages in a hover |
| 10 | Help and Documentation | n/a | Not applicable to a hover |
| **Total** | | **10/20** | **Acceptable (50%)** |

## Design Specificity Verdict

LLM assessment: the interaction borrowed the account list's hover bed (6% wash, 5px corners) and the product's press-scale convention, and neither was fitted to a dense list of machines. The tone itself is faint (1.13:1 against the panel); what makes it read as a card is its box — 267×33.4px round a 14px name — because the hidden 24px `unpair` spans an empty second grid track under every healthy row, so the box is 27.4px and the name sits at its top.

Deterministic scan: `detect.mjs` on LanSyncSection.tsx and LanPeerModal.tsx — 0 findings. In-page overlay: 6 `undersized-ui-text` in the section — 5 are the 10px `unpair` label (the panel's own 10px label tier; kept), 1 is "checked just now" (outside the row interaction). Nothing on the name, the overlay or the dot.

## What's Working

- Nothing shifts on hover: `unpair` fades by opacity and keeps its width.
- The status dot never changes with hover or focus.
- Keyboard focus has a clear 2px ring (10.85:1).

## Priority Issues

- [P1] Card-sized hover tone: 33.4px tall, 3px past the row's top and bottom, 5px corners, 6%; neighbouring tones overlap by 1px. Fix: one grid track for a healthy row (a 24px box, everything on one centre line); the tone is exactly the row box plus 4px each side, 4px corners, 4%; on and off at once. Command: /impeccable distill.
- [P1] A double-click unpairs: the first press arms, the second confirms within ~300ms. Fix: a confirming press sooner than 400ms after arming is ignored, on the row and in the dialog. Command: /impeccable harden.
- [P2] Grey text on the tone fails AA: the revealed `unpair` is 4.15:1, and the state line keeps `--muted` under keyboard focus. Fix: `--text-secondary` on a lit or focused row (6.3:1). Command: /impeccable polish.
- [P2] The press scales the row: 0.98 moves the name 2.3px and eases back under the dialog. Fix: the tone deepens to 7%; nothing moves. Command: /impeccable quieter.
- [P2] States linger: `:focus-within` keeps `unpair` up after a mouse closes the dialog; 120ms fades leave a trail behind a sweeping pointer; focus paints tone, ring and verb at once. Fix: reveal on `:has(:focus-visible)`, no fades, focus draws the ring only. Command: /impeccable polish.

## Persona Red Flags

- Alex (power user): sweeping the pointer down the right edge flashes a pink pill on each row; a double-click habit can unpair a deck; every open made the row jiggle.
- Sam (keyboard / screen reader): a focused row is announced as "X, details" — its status sentence sits outside the button and is never read on focus; focus reveals a 4.15:1 label.

## Minor Observations

- Ten Tab stops for five rows and no arrow-key movement (not changed: outside hover/focus scope).
- The status dots ping continuously on every row, which competes with any hover (semantic, left alone).
- `unpair` stays 10px — the panel's label tier — and a step under the 12px name.

## Questions to Consider

- Does a healthy paired row need `unpair` on hover at all, when the deck's own dialog carries it?
- Should the list be one Tab stop with arrow keys between rows?
