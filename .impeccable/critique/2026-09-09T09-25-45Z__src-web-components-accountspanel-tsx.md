---
target: the accounts panel including the LAN share section
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
timestamp: 2026-09-09T09-25-45Z
slug: src-web-components-accountspanel-tsx
---
Method: dual-agent (A: design review · B: detector + browser evidence). Note on isolation: assessment B returned before A, so B's deterministic findings were in the synthesis context while A was still running. A itself never saw B's output, so A's judgment is unanchored; only the parent's reading order was affected.

Scope: the whole Accounts surface — `AccountsPanel.tsx` (1252 lines), `LanSyncSection.tsx` (392), `ShareAccountsDialog.tsx` (299), `AddAccountDialog.tsx` (567), and the `.ap-*` / `.ap-lan-*` / `.sa-*` / `.aa-*` rules in `styles.css`. Mode: Operate.

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Panel is exemplary (`collected 9m ago · next in 4m`, `numbers paused`, `never collected`). The LAN section is mute: `aria-busy` is set on ~10 controls and has no rule anywhere in the 8706-line sheet, and `check now` never changes its word. |
| 2 | Match system / real world | 4 | The best dimension here. "took 1 account", "could not reach it — handshake refused", "this is the password". No system nouns leak. |
| 3 | User control and freedom | 2 | `remove` arms and expires after 4s; the one action irreversible by physics — ticking an account into the group — is a single unguarded click, two lines under the sentence saying it cannot be taken back. |
| 4 | Consistency and standards | 2 | The panel's doctrine (explicit commit, per-control busy word, failure box, arm-before-destroy) is applied everywhere in `AccountsPanel.tsx` and abandoned wholesale in `LanSyncSection.tsx`. |
| 5 | Error prevention | 2 | Panel strong (#516 commit pairing, `· swap` option labels, armed remove). LAN: empty passphrase, blur-commit, unguarded tick, and a real write race. |
| 6 | Recognition rather than recall | 2 | 30 `title` attributes in a 288px column; the manage block has no visible labels at all. |
| 7 | Flexibility and efficiency | 3 | `a` toggle, Enter-to-save, a real arrow-key tablist in `AddAccountDialog`, per-row and bulk share. No keyboard route to "switch to account 3". |
| 8 | Aesthetic and minimalist design | 3 | Dense and disciplined; the lane fold is a genuinely elegant reduction. Loses on the peer list and on a monotone secondary tier in dark. |
| 9 | Error recovery | 2 | `errorText()`, `.ap-failure`, `.ap-fix` are excellent. `LanSyncSection` has no error surface of any kind. |
| 10 | Help and documentation | 3 | Extraordinary explanation-in-place, but nearly all of it is hover-only. |
| **Total** | | **26/40** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment.** The accounts panel is authored for this product and nothing in it survives being lifted elsewhere: an account row is `[slot][alias][email][state chip]` over bars that fill with the problem, over a freshness line that treats "when was this measured, and when next" as a first-class value with its own right-edge column. `held out`, `numbers paused`, `never collected`, the slot picker's per-option `· swap` / `· free` — that vocabulary only means something here.

The LAN section is assembled, not authored. Strip two sentences and it is a stock device-pairing panel: name field, passphrase field, a column of checkboxes, a peer list, a manual address, a "check now". Every structural decision is the default one. Reusing `.ap-auto`'s frame is the right instinct; borrowing a frame is not authoring a section. The section's own header comment describes a design it did not build — it says the passphrase field "comes filled with something strong", and `setDraft("")` at `LanSyncSection.tsx:252` opens it empty.

**Deterministic scan.** `detect.mjs --json` over all four components: **0 findings, exit 0.** Entrypoint resolved and `.tsx` is in `SCANNABLE_EXTENSIONS`, so the files were parsed rather than skipped. Nothing to label a false positive.

**Browser evidence** (fresh build on `127.0.0.1:4391`, `visibilityState` forced visible, viewport 2048×981):

- Contrast, dark, panel-wide: 59 text nodes under 18px, minimum **4.70:1**, zero below 4.5:1. Light: minimum **5.24:1**, zero below.
- **`--muted: #7e828c` and `--text-dim: #7e828c` are the same colour in dark** (`styles.css:49,57`); in light they are distinct (`#4a5260` / `#5f6673`). So in dark the entire secondary layer of the panel is one ink separated only by 11 / 10 / 9px.
- LAN section with a passphrase set: 20 text nodes, **13 of them sit at exactly 4.70:1** — the section title, the irreversibility sentence, every label, the empty state, `dead here`, and the address note. Only the account emails and the two `.ap-lan-code` addresses rise above (12.95:1).
- Target sizes under 24px in the LAN section: `.ap-lan-pick` 256×**21.9**, `check now` 71×**22.5**, `change` 55×**22.5**, the master switch 39×**21**. Pick rows stack at a **23.9px pitch** (21.9 + 2px gap), 0.1px under what the SC 2.5.8 spacing exception needs.
- Panel geometry: LAN section fully open is **450.6px** tall and starts **554.7px** down the panel. Content 991px against a 929px box, `scrollHeight 1005 > clientHeight 929` — the panel only starts scrolling once this section is fully open.
- Font sizes: 9/10/11/13/16 panel-wide, 9/10/11 in the LAN section. All on the ladder, 0 off-ladder.
- Accessible names: 19 controls, 0 missing, 0 title-only. Console: 0 errors, 0 warnings.
- Both themes verified by screenshot, not only by computation.

## Overall Impression

Two surfaces are stacked in one panel and only one of them was designed. The accounts panel is among the most carefully reasoned UI in this repo — the freshness column, the lane fold, and the commit-pairing are all decisions somebody argued through and wrote down. The LAN section inherits its frame and none of its discipline, and it does so precisely where the stakes are highest: this is the only place in ccdeck where a click puts a live OAuth token on a network and cannot take it back.

The single biggest opportunity is not visual. It is to apply the panel's own doctrine — explicit commit, a visible failure box, arm-before-destroy — to the 392 lines that currently ignore it.

## What's Working

1. **Freshness as a first-class value.** `collected 9m ago · next in 4m` / `never collected` / `numbers paused`, right-aligned under the percentages. This is what stops the panel lying when a rate-limited account still shows its last good numbers. Most dashboards bury it in a tooltip; this one gives it a column.
2. **The lane fold that refuses to hide the thing that matters.** `laneSplit` folds the per-model lanes, then renames the disclosure from `1 more` to `Fable 50%` when a folded lane is fuller than everything on show. Progressive disclosure usually trades honesty for height; this keeps both.
3. **Commit buttons that name the consequence.** `slotCommit()` reads the same `SlotChoice` the options were labelled from, so the button says `swap` exactly when the option said `· swap`, with a title naming which other account moves. Any generic build ships an `Apply`.

## Priority Issues

### [P0] `LanSyncSection` has no failure surface at all
**Why it matters.** `save()` (`LanSyncSection.tsx:157-173`) checks `if (out?.ok)` with no `else`; `syncNow()` (`:175-189`) does the same with no `catch` around its `fetch`, and is called as `void syncNow()`, so a network error becomes an unhandled rejection. Every write in the section — enabling sync, saving the passphrase, ticking an account, adding an address, `check now` — fails silently. The `load()` catch comment ("the deck is down; the connection banner already says so") is a fair excuse for a poll and is covering the write path. Two people configuring this get a screen state for "your passphrase did not save" that is pixel-identical to "it saved", and will spend twenty minutes on a firewall that is fine. In the tick case it is worse: believing an account is shared when it is not means no healing; believing an untick took effect when it did not means a live login still on the network.
**Fix.** Hoist the panel's `.ap-failure` box (`AccountsPanel.tsx:1193-1199`) into a shared component and give the section a `failure` state, set in the `else` of both `ok` checks and in a `catch` around `syncNow`. ~25 lines.
**Suggested command:** `/impeccable harden`

### [P0] The highest-stakes action is the only unguarded one, and it races
**Why it matters.** `LanSyncSection.tsx:280-296`. The share checkbox POSTs on `change` with no `selfPressAccepted` guard, no arming, no confirmation — while every other write in this codebase went through #516/#518/#620. And it races: `shared` is a `Set` built at render from `status.shared` (`:192`), and `status` only refreshes after `save()` → `load()` returns. Tick two accounts quickly and the second POST is built from the pre-first-tick set, so the first account is silently dropped from `shared` while both boxes stay ticked until the next 5s poll quietly unticks one. The panel guards `remove` — reversible by signing in again — with two clicks and a countdown, and guards handing a live token to the network with a 13px checkbox. The ceremony is exactly inverted at the point where it matters most.
**Fix.** Guard the handler with `selfPressAccepted(busyRef.current)` and derive `next` from a ref the optimistic update writes, not from render-time `status`. Then make the first tick of a session cost a deliberate act — arm it the way `remove` arms, or gate the picks block behind one acknowledgement of the warning sentence. The second tick can stay free.
**Suggested command:** `/impeccable harden`

### [P1] The trust boundary is an empty text box, and the fix is already written
**Why it matters.** `setDraft("")` (`:252`) opens an empty field whose placeholder — "the same words on every deck" — actively nudges toward something short two people can both remember. `suggestPassphrase()` at `src/server/lan-sync.mjs:218` generates six words from a 100-word list, is documented as existing so most groups never have a weak one, is fully tested, and is called by nothing but its own test. No route serves it. The whole feature's security reduces to this string; `groupKey()` scrypts it and everything hangs off that. The `set` / `change` button is also the only control in the section with no `title`.
**Fix.** Serve `suggestPassphrase()` from the prefs route, open the draft pre-filled and visible with a `copy` beside it. The "never show dots" rule protects a *stored* value from being re-displayed; it says nothing about the moment of generation.
**Suggested command:** `/impeccable harden`

### [P1] The peer list cannot be read: no error tone, no chunking
**Why it matters.** `.ap-lan-peer-last` is `color: var(--text-dim); font-size: 10px` with no error variant (`styles.css:6676`), and `roundLabel()` returns an untagged string — so `could not reach it — handshake refused` renders at exactly the weight and ink of `nothing to do · checked now`. Measured: both 4.70:1, both `#7e828c`. This list is the entire readout of whether the feature works, and in Operate mode the one thing a user scans for is which row is red. There is no red. Separately, `.ap-lan-peers` uses `gap: 4px` between peers while each peer's `-last` line wraps to `flex: 1 0 100%` inside it, so inter-peer and intra-peer distance are equal and three decks read as six undifferentiated lines.
**Fix.** Give `roundLabel` a `tone` the way `shareExpiry` already returns one, and paint the error tone `--warn`. Raise `.ap-lan-peers` gap to 10px so one peer reads as one object.
**Suggested command:** `/impeccable clarify`

### [P2] Blur-commit with silent discard, in a section whose sibling banned exactly this
**Why it matters.** `appear as` saves on `onBlur` (`:235-239`); `by address` parses on `onBlur` and, on a parse failure, empties the field and returns with no message (`:356-362`). `picker-commit.ts` opens with three paragraphs on why no control in this panel may act on an implicit event and ends "each one proposes; a control beside it commits". The address case is the worse half: a typo produces an empty field and total silence, the user believes they added a peer, none appears, and the two things the empty-peers copy tells them to check are both the wrong things.
**Fix.** Give both fields the `[field][commit]` shape the alias row and the slot row already use. On a bad address, keep the text and say why — `parseAddress` already knows the port is what failed.
**Suggested command:** `/impeccable harden`

## Cognitive Load — 5 of 8 fail

| Item | Verdict |
|---|---|
| Single focus | FAIL — three unrelated jobs in one scroll; at the bottom you are configuring a network group inside a panel titled "Accounts". |
| Chunking ≤4 | FAIL — see the decision points below. |
| Grouping | PARTIAL FAIL — rows and sections group well; the peer list has no grouping at all. |
| Visual hierarchy | FAIL in dark — `--muted` and `--text-dim` are one colour, so the whole secondary layer is separated by size alone. |
| One thing at a time | PASS — one manage block open; LAN double-gated on `on` then `hasPassphrase`. |
| Minimal choices ≤4 | FAIL — see below. |
| Working memory | FAIL — the passphrase must be carried to another machine with no display, no copy and no generator; the address is read aloud across a desk; which peer failed is held nowhere but that peer's own dim sentence. |
| Progressive disclosure | PASS, and the strongest thing about the composition. |

Decision points over four visible options, counted: account row worst case (errored + rotating) **6** before `⋯` is opened; the `⋯` block **6 controls / 7 targets** in a 259px column with zero visible labels; LAN on with a passphrase, 3 accounts and 3 peers **9**; whole panel **24 tab stops** measured with the LAN section fully open and no manage block, more with one open. The auto-switch line, at 4, is the only decision point at or under the limit — and the one already redesigned twice.

## Emotional Journey

**An account hits its limit mid-run.** The panel's best hour and it earns it. Press `a` and within one saccade: which account is live (a filled accent chip, not a wash), how full each is (bars that fill with the problem, so calm accounts are visibly empty), and how old the numbers are. The valley is short — `login expired` in warn with `sign in again` one click away. Peak-end is good.

**Two colleagues making LAN sync work for the first time.** No reassurance where it matters. The switch sits alone on its line with ~190px of dead space to its left, because `.ap-auto-head` is `flex-direction: column` and the LAN head has only one child for the second row — the most consequential control on the surface is also the least anchored. Then the right sentence in the right place: "A login you share is a live one, and it cannot be taken back." And then the panel does not act as if it believes it: an empty passphrase box, then checkboxes with no arming, no count, no error path. Then the wait, which is the valley — `check now` paints nothing, a failed round is styled as a footnote, and a failed *write* shows nothing at all. The end of this journey is silence, and silence in a credential-sharing feature reads as success.

## Persona Red Flags

**Alex (impatient power user)**
- 24 tab stops to cross the panel and no keyboard path to its primary verb. There is no "switch to account 3".
- `⋯` is not a menu and it steals the keyboard: `autoFocus` (`AccountsPanel.tsx:895`) drops him into the alias field, so his next keystrokes are text. Only `App.tsx` may read `"Escape"`, so Escape closes the whole panel rather than the block he opened.
- `check now` is a dead button. `selfPressProps` sets `aria-busy`, and `aria-busy` has no rule in the entire stylesheet. He presses it three times.
- `share` does not share: the row button produces a blob that then needs a second press on `copy`.
- The armed `remove` expires in 4s and sits at the same right-edge x as `save` and `move`, so the right edge of the block reads `save` → `move` → `remove`.

**Sam (screen reader + keyboard)**
- The roster has no structure: **0 lists, 0 `role="list"`** in `AccountsPanel.tsx`. Heading navigation goes `h2 Accounts` → `h3 Auto-switch` → `h3 Local network`, straight past every account. `ShareAccountsDialog.tsx:256-269` uses `<ul>/<li>` correctly — the pattern exists in the codebase and the panel does not use it.
- 30 `title` attributes, several carrying the only statement of risk: the row `share`'s "treat it as the password", the `⋯`'s only preview of what it opens, and the base64/unsigned-expiry explanation behind `this is the password`. Hover-only safety copy.
- The only live region is `.ap-failure` / `.ap-empty` (`role="alert"`). The whole confirmation vocabulary — `save`→`saved`, `copy`→`copied`, `move`→`moved` — is a label swap that announces nothing.
- `aria-busy` is told six times at once: `selfPressProps(busy)` in `LanSyncSection` reads one section-wide boolean, so pressing `check now` marks the master switch, `change`, `save`, `cancel` and every peer `remove` busy too.
- `.ap-lan-pick` is a 256×21.9 label row with `cursor: pointer`; focus lands on the 13×13 native checkbox and there is no `:focus-within` rule, so the ring marks a square at the far left of a target that is the whole sentence.
- Under 24px, measured: `.ap-lanes-more` 29×13, `.ap-fix` 79×18.5, `.ap-auto-state` 41×21 (both switches), `.ap-lan-pick` 256×21.9, `.ap-manage-btn` 51×22.5, `.ap-field select` 22.5. Only `.ap-more` / `.ap-add` / `.ap-share-set` (24×24) and the text inputs reach it.

## Minor Observations

- `moreLabel` prints **used** and `lanesTitle` prints **headroom** for the same lane in the same control: the button will read `Fable 79%` while its tooltip reads "21% left on Fable". They coincide only at 50.
- The LAN master switch is orphaned by `.ap-auto-head { flex-direction: column }` (`styles.css:6536`). `flex-direction: row; align-items: center` on `.ap-lan .ap-auto-head` puts it beside its title, the way `AUTO-SWITCH` reads.
- The same kind of thing is set in two typefaces 200px apart: a manual peer's address in `.ap-lan-peer-name` (body font), this deck's own addresses in `.ap-lan-code` (monospace).
- `appear as` defaults to the machine hostname, and `beaconPayload` broadcasts it in the clear to anyone on the wifi, passphrase or not. The panel never says the name is public.
- `.ap-lan-sub` ("SHARE THESE ACCOUNTS", "IN THIS GROUP") is a `div`, not a heading — two more sections invisible to heading navigation, in the part of the panel that most needs landmarks.
- Two poll cadences run in one column: 15s for the roster, 5s for LAN. Numbers in the same visual field age at different rates.
- The LAN section adds 265px when its passphrase is set and is the reason the panel begins to scroll at all — and nothing above it says a "Local network" section exists 555px down.
- `AddAccountDialog` is the strongest single file in the surface — real tablist with arrow keys, per-row `update anyway` on import, a success state that only celebrates when something arrived. It sets the bar the LAN section is measured against.

## Questions to Consider

1. If every action here were sorted by "how bad is it if this happens by accident", would the ceremony be in the same order? Right now it is close to exactly inverted.
2. What if the passphrase were not a field at all — flip the switch and the deck shows six words and a `copy`, and nobody ever types a weak one?
3. Everything at 9-10px in this panel is one colour in dark. If only one thing in that tier could be painted differently, it is almost certainly `could not reach it — handshake refused`, and it costs one `tone` field and one CSS rule.
4. The panel's most-praised property is that nothing is shown that was not measured. The peer list never says "this is what I know, and when I learned it" about the group as a whole. Why does the group get less honesty than a single account row?

## Persuade-mode instincts, named and not counted as defects

Avatars or a connection animation in the peer list; a warmer "you're connected" moment. Both are Persuade instincts on an Operate surface — two colleagues configure this once and never look again. What the section needs is contrast against failure, not celebration. Not flagged: the 288px width, the fill-with-the-problem bars, the no-dots passphrase, the 24h clocks, and LAN defaulting off. All five are right.
