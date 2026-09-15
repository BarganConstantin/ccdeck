---
target: topbar (src/web/App.tsx header)
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-15T10-02-30Z
slug: src-web-app-tsx-topbar
---
Method: dual-agent (A: design-review subagent · B: detector + browser subagent), against origin/main `c1df788` and the live deck on :4317. Prompted by two screenshots of the topbar at 1600px+ (light and dark) after #1103 gave the buttons words.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | The waiting alarm is clipped at 600px and gone at 400px. Sound's on/off shows only as a 13px icon change. |
| 2 | Match system / real world | 2 | An open panel looks like a raised keycap, not a tab. "Dark" reads as the current state. "History…" sounds like browser history. |
| 3 | User control and freedom | 4 | Every control is a reversible toggle or a closable dialog. |
| 4 | Consistency and standards | 2 | One accent outline means hover, focus, open panel, open popover and "watching". The "…" rule skips Sound, which also opens a dialog. |
| 5 | Error prevention | 4 | Nothing destructive is left in the bar. |
| 6 | Recognition rather than recall | 2 | Below 1600px (every 13-14" laptop) the bar is eight bare icons, and `$` and the bar chart are ambiguous. |
| 7 | Flexibility and efficiency | 3 | Every button has a single-key shortcut, but the bar never shows them. |
| 8 | Aesthetic and minimalist design | 2 | The loudest things at rest are three panels already on screen plus an amber bubble. |
| 9 | Error recovery | 3 | The live/dead pill and the drift chip are good, but they sit in the readout area that gets clipped. |
| 10 | Help and documentation | 2 | Tooltips are the bar's only help. |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment:** the meaning is authored for ccdeck, and the look is generic.

What is specific to this product:
- the drawn 13px icon set, including the eye that shows watching by pupil or slash;
- the live pill that disappears when all is well;
- the waiting chip as the bar's one alarm, with the bar's only live region;
- the 8/14/18/24 spacing scale.

None of that reaches the row's visual form. It is eight equal outlined 6px chips plus a phone-style notification bubble, which any SaaS dashboard could ship unchanged.

**Deterministic scan:**
- The CLI on `src/web/App.tsx` exited 0 with no findings.
- The browser overlay flagged 111 elements page-wide: dark-glow 48, ai-color-palette 35, gpt-thin-border-wide-shadow 18, undersized-ui-text 17, clipped-overflow-container 3, tiny-text 1, overused-font 1. None of them are inside `header.topbar`.
- `overused-font: roboto` is a false positive, because Roboto is only a fallback in the system stack.
- The detector skipped the 9px badge, because it ignores single-character and `aria-hidden` text.
- Every topbar problem below is semantic (a meaning collision, or a state drawn in the wrong vocabulary). A pattern scanner cannot see those, and the review caught all of them.

**Visual overlays:** nothing in the topbar was flagged. The overlay tab was closed, because every extra deck tab rewrites the shared saved layout.

## Overall Impression

The bar draws its least urgent things loudest:
- the three open panels look like raised keys;
- Watch… is amber and wears the bar's only filled mark.

The one urgent thing, a session blocked on you, is the smallest amber mark, and it is the first thing a narrow window cuts.

The biggest opportunity is to quiet everything except the alarm.

## What's Working

1. **State lives in ARIA, and the words match the names.** The CSS keys off `aria-expanded` and `aria-haspopup`, so the pixels and the accessibility tree cannot drift. Every visible word is inside its button's accessible name (2.5.3).
2. **One icon spec.** Every icon is 13px on a 14 viewBox with a 1.4 stroke. The glyph and word midlines agree at y=25.50, which is the button's centre.
3. **Restraint in the system.** There is a deliberate spacing scale, the controls never shrink, and a single live region is reserved for the alarm.

## Priority Issues

**[P1] An open panel reads as a raised keycap**
- *What:* `styles.css:2248` draws a full accent frame plus `inset 0 -2px 0 var(--accent)`. That gives a 3px bottom edge against 1px sides. Usage, Accounts and Machine stay open, so this is how the bar looks all day. The Sound popover opener gets the same frame while its menu is open.
- *Why it matters:* in light theme the frame is 1.67 and 1.52:1 off the resting edge, so the foot does all the work. A foot inside a box reads as a bevel, not as a tab.
- *Fix:* drop the accent frame and draw a detached 2px accent line under the label, inside the box. The line alone stands 5.2-11.3:1 off the bar.
- *Command:* /impeccable polish

**[P1] Watch… out-shouts the alarm, and amber means two things**
- *What:* `styles.css:9028` tints the glyph and word in `--warn`, and `styles.css:9007` adds a filled `--warn` bubble. The blocked-session chip uses the same amber, as an 11px outline.
- *Why it matters:* unread browser-history episodes do not need you now. Amber that is on all day teaches the user to ignore amber, and amber is the channel the blocked-session alarm relies on.
- *Fix:* remove the tint, because the pupil already carries the state. Make the badge neutral. Reserve amber for the waiting chip and the stale version chip.
- *Command:* /impeccable quieter

**[P1] A narrow window cuts the alarm first**
- *What:* `.readout` has `min-width: 0; overflow: hidden`, and the waiting chip is its last child. At 600px the chip is clipped. At 400px it is gone, while all 8 controls remain and the wordmark reads "ccdec".
- *Fix:* at 640px and below, hide the wordmark, the up-to-date version chip and the word "waiting". The chip's accessible name keeps the full sentence, and "logo + ● 2" fits.
- *Command:* /impeccable adapt

**[P2] Hover, focus and open share one accent outline**
- *What:* the focus ring is 2px at a 1px offset. On a closed button it reads as "open", and on an open button it merges into one blue block.
- *Fix:* take the frame out of the open state (the first issue above), and move the topbar's focus ring out to a 3px offset.
- *Command:* /impeccable polish

**[P2] The words**
- *What:*
  - The words appear only at 1600px and above, so most laptops never see them.
  - "Dark" names an action where every other word names a thing, so it reads as the current state.
  - The ellipsis in "History…" and "Watch…" looks like clipped text, and the rule behind it skips Sound.
  - "Watch" drops "Browser".
  - History (a usage view) sits apart from Usage.
- *Fix:*
  - Make the theme button icon-only.
  - Drop the ellipses.
  - Rename "Watch…" to "Browser watch", the dialog's own title.
  - Move History beside Usage.
  - Lower the breakpoint to the width the row actually fits, measured.
- *Command:* /impeccable clarify

## Persona Red Flags

**Alex (power user)**
- Three blue keycaps sit permanently at the edge of the eye.
- The amber badge nags all day, which wears the alarm down.
- The shortcuts are never shown in the bar.

**Sam (keyboard / screen reader)**
- A focus ring on a closed button looks open.
- Mute state is not in the name "Sound settings", so Sam has to open the menu to learn the chimes are off.

**Jordan (first-timer)**
- On a laptop, Jordan sees eight unlabelled icons: `$` reads as billing, and the eye reads as preview.
- "History…" sounds like browser history.
- The amber "13" looks like the first thing to deal with.

## Minor Observations

- The badge overhangs the button's corner by 3px, and its text is 9px bold (4.79:1 in light).
- Some comments are stale:
  - `App.tsx:4446` still calls Sound "the one genuine aria-pressed".
  - `App.tsx:4251` lists "sound, theme" as the persisted settings.
  - `styles.css:9001` says "five beside it".
- `.bw-btn.watching` paints the word in accent, which gives accent yet another meaning.
- At 2048px the middle of the bar is about 1000px of empty gradient.

## Questions to Consider

- The panels are already on screen. Should an open panel's button get quieter, so that a closed one stands out?
- What if the blocked count were the only amber, and the only filled object, that the bar ever shows?
- Should the theme toggle move into the Sound menu, so the bar's last slot is freed?
