---
target: the Usage panel, especially the today/month/all period navigation
total_score: 21
max_score: 36
na_heuristics: 9
p0_count: 1
p1_count: 2
timestamp: 2026-09-07T13-41-14Z
slug: src-web-components-usagepanel-tsx
---
Method: dual-agent (A: design review · B: detector + browser evidence). Target: the Usage panel, and above all the `today / month / all` period navigation. Mode: Operate — a 280px docked instrument panel read at a glance while agents run.

## Design Health Score

Applicable maximum 36 — heuristic 9 is `n/a`, a three-state toggle has no invalid input and no failure mode.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Press `all` and the strip settles instantly while the headline still reads `$509 today` at `--dim-stale`; nothing on the strip says the answer is in flight. |
| 2 | Match system / real world | 3 | Right words, and they expand honestly to `today / this month / all time` under the money; `month` never says calendar vs rolling. |
| 3 | User control and freedom | 3 | Every tab stays pressable during a slow read — deliberate, and right. The choice is thrown away on every remount. |
| 4 | Consistency and standards | 1 | Hover repaints an inactive label to `rgb(216,218,224)` — byte-identical to the selected label. And hovering the SELECTED tab paints it `--bg`: 1.080:1 dark, 1.132:1 light. The word vanishes. |
| 5 | Error prevention | 3 | Nothing destructive. An empty period renders as a legitimate-looking zero until the recovery copy is read. |
| 6 | Recognition rather than recall | 2 | At rest a tab is 10px ui-monospace, weight 400, `rgb(126,130,140)` — the exact computed spec of `.up-k` (`in`, `out`, `cache r`). Typographically a data label until hovered. |
| 7 | Flexibility and efficiency | 1 | Three separate tab stops, no roving tabindex, no accelerator, and the period is the one panel preference not persisted. |
| 8 | Aesthetic and minimalist design | 4 | One 2px mark, one hairline, no container, exact inset. Genuinely quiet. |
| 9 | Error recovery | n/a | No invalid input, no failure mode. |
| 10 | Help and documentation | 2 | `.up-total` carries a `title`; the tabs carry none, and `month` is the one ambiguous label. |
| **Total** | | **21/36** | Below average for a control this carefully drawn — the resting frame is excellent, the interactive frame is inherited. |

## Design Specificity Verdict

**Authored skeleton, category-interchangeable behaviour**, and the split is the finding.

The layout is unmistakably this product's: the strip's box runs 1227 → 1477, `--panel-inset` inside a 278px content box, on the same x as five sibling blocks fed by three different padding mechanisms. Zero drift. Nobody gets that by importing a tab component.

The states are `.uh-range`'s chip states, inherited whole — and they are the layers a hand touches. Hover impersonates selection. `:active` scales a 0.97 press written for a 52px capsule. `transition: background 120ms` is a dead declaration here. `:focus-visible` draws an 87.3 × 34px hard-cornered accent rectangle around a control whose stated premise is "no box, no fill, no capsule".

**Deterministic scan:** `detect.mjs --json src/web/components/UsagePanel.tsx` → `[]`, exit 0; the whole `components/` directory likewise. Calibrated against a deliberate-slop canary that also scored 0 — the rule set matches kebab-case CSS property syntax (`detect-text.mjs:381` needs a literal `font-family\s*:`), so JSX style objects are unreachable and this file's styling lives entirely in `styles.css`. Treat the clean result as *not applicable*, not as a pass. The wide `src/web/` run found 14, none in the period-strip blocks; three of those are false positives (`--edge-transition` matched as a `transition`, with `width` found inside `stroke-width`; a `bounce-easing` hit inside a Vitest assertion string that exists to prove the easing does *not* overshoot). The detector's HTML engine ran DEGRADED all session — four parser packages absent — so every contrast figure below is measured from the browser, not from the tool.

**No visual overlay was presented.** Evidence is headless CDP measurement plus screenshots, not an injected in-page overlay.

## Overall Impression

The resting frame is the best-composed control in the panel and the interactive frame is nobody's. The single biggest opportunity is that the indicator is sized off the *segment* and not off the *word*, which is what makes an otherwise exact control read as generic — and it is one structural change, not a tuning pass.

## What's Working

1. **Inset discipline, exact.** Strip 1227 → 1477; the right edge is 1491 − 14 to the pixel, matching five sibling blocks whose padding comes from three different sources.
2. **Equal hit areas to sub-pixel, and nothing resizes under selection.** Columns 83.3281 / 83.3359 / 83.3359; buttons 83.3 × 30. Measured across all three periods in both themes: **0.0px** movement in x, y, width or height.
3. **The terse-control / explicit-readout split.** The tab says `all`; the noun under the money says `all time`, bound to the *loaded* range rather than the pressed one, so the number and its word are never a lie together.

## Priority Issues

**[P0] Hovering the selected tab erases it.** `.uh-range-btn[aria-pressed="true"]:hover { color: var(--bg) }` is written for the history modal, where the chip sits on an `--accent` fill. Both selectors are (0,3,0) and the shared one is declared later, so on this strip the selected word is drawn in `--bg` on `--panel`: **1.080:1** dark, **1.132:1** light. Measured live. It disappears under the pointer that just chose it. *Fix:* one more class — `.up-period .uh-range-btn[aria-pressed="true"]:hover { color: var(--text) }`. *Command:* `/impeccable polish`.

**[P1] The indicator is sized off the column, not the word.** `width: 60%` of 83.3px = 50px on every tab. Label ink: `today` 30.11, `month` 30.11, `all` **18.06**. Ratios **1.66× / 1.66× / 2.77×**; overhang 9.94px per side, **15.97px** under `all`. The relationship between mark and marked thing changes by 60% between tabs, so the eye reads it as underlining a region. *Fix:* a single `max-content` grid column holds the label and the `::after` shares it — the browser measures, nothing hard-codes. *Command:* `/impeccable distill`.

**[P1] Hover impersonates selection.** Hovered inactive = `rgb(216,218,224)` = the active colour exactly. Immediately after a click the pointer is *resting on the strip*, so the commonest rendered frame shows two tabs at full `--text` with a 2px rule 30px away as the only difference. *Fix:* mix halfway — hover 1.66:1 up from rest and 1.66:1 down from selected in dark, 1.57 / 1.53 in light. It cannot be mistaken for either end. *Command:* `/impeccable polish`.

**[P2] The focus ring reintroduces the box the design refuses — and swallows the indicator.** `outline: 2px solid var(--accent); outline-offset: 1px` on a segment whose `border-radius: 0` had shadowed the global ring's 4px: the one hard-cornered ring in the deck, 87.3 × 34px. Its bottom stroke occupies **412.27 → 414.27** — the indicator's exact pixels in the indicator's exact colour, so the selected tab, focused, shows no indicator at all. It is also clipped 3.2px by `.usage-panel`'s own scroll box at a 620px viewport. *Fix:* `outline-offset: -4px; border-radius: 4px`. *Command:* `/impeccable polish`.

**[P2] Proximity is inverted relative to what the strip does.** Ink gaps measured 36.75px above / 28.00px below — 1.31:1, too shallow to group anything, and the void under the hairline was the largest in the panel. A control that heads the money should sit nearer the money. *Fix:* margins 14/10 → **42.75 / 22.00**, 1.94:1. *Command:* `/impeccable layout`.

**[P2] Cyan is already spoken for.** Seven cyan marks in a 280px column: `.qb-pct` ×3 and `.qb-fill` ×3 mean "quota level", the indicator means "selected period". The CSS comment's claim that cyan appears once is true within the control and false within the panel, which is the only scope a reader has. *Not acted on* — the brief pins the cyan selected state. *Command:* `/impeccable colorize`, if ever.

## Persona Red Flags

**The glancer** (deck on a second monitor, read in under a second). Fails on the *rest state*: 10px ui-monospace, weight 400, `rgb(126,130,140)` — the byte-identical computed spec of `.up-k` (`in` / `out` / `cache r`). Nothing in the resting frame says "control"; at a glance the strip joins the readout it governs.

**The keyboard-first developer.** Fails on the tab-stop model and the ring: three separate `tabIndex 0` stops with no arrow keys — one decision costs three of the panel's five stops — and the ring that arrives is the 87.3 × 34px hard rectangle.

**The low-vision reader, light theme.** Active-vs-inactive is a **2.410:1** step, effectively the 2.403:1 this sheet's own #583 record declares insufficient on its own for `.cat-filter`. The third channel is a 2px 5.93:1 rule, and the baseline at ~1.11:1 is *fainter* than `--line-soft`'s 1.312:1 — the one container all but disappears exactly where the type step is weakest.

## Minor Observations

- The comment block had **forked into three**, two of them dead: one describing a 36px centred intrinsic pill with a 3px inset that no longer exists, and two near-identical copies disagreeing with each other (`85px third` vs `80px third`; measured 83.3281). The `control-edges.test.ts` exemption comment also described a rest-state transparent rule that did not exist.
- The period is the only panel preference not persisted — `useState<PeriodKey>("today")`, no `localStorage`, while the deck persists `usagePanelOpen` and `theme`.
- The word band sits 3.0px left of the box centre because `all` is 12.05px narrower than its siblings.
- Hit area 83.3 × 30 passes SC 2.5.8 (24px), fails SC 2.5.5 (44px) on height. Consistent with the rest of the deck.
- Assessment A reported `:active` as uncovered by any reduced-motion block. It is covered — `.uh-range-btn:active` is in the list at `styles.css:7420`.

## Questions to Consider

1. The panel owns a "this heads the block below" idiom — 11px uppercase, weight 600, left-flush. The period strip does that job in a completely different dialect. Why is the panel's one *governing* header the only one that does not look like one?
2. Every other row is left-flush at 1227 with values right-flush at 1477. The strip is the only centred content in the panel. Was centring ever tested against left / centre / right thirds, or is it the last surviving instinct from the chip?
3. If the selected period deserves a 2px accent mark, does it deserve to be remembered?
4. Three comment blocks described this control and disagreed with each other and with the render. If the comments are the design record — which one was the record?
