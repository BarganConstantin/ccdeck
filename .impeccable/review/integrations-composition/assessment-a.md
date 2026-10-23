Method: independent Assessment A only; parent owns Assessment B and synthesis. No detector or previous critique consumed.

# Integrations composition — Assessment A

Reviewed `work/2026-10-23-changes`, HEAD `7681e6deeab6b4154edee367d478548b92f97e22`; working tree clean before/after inspection. Read AGENTS.md, docs/release-workflow.md and installed Impeccable critique guidance. Session bootstrap deliberately not rerun. Source read-only; this temporary report is the only written artifact.

## Verdict

The visual language fits ccdeck: compact desktop controls, restrained borders, functional typography and explicit connection identity. The regression is the composition of actions, not a missing design system. The overview mixes a provider-level creation row with connection-level management rows. It therefore answers two different questions at once and contradicts the latest brief. Keep the existing shell and detail/form surfaces; make the overview three provider rows with three contextual actions.

## Evidence and exact cause

Inspected real rendered General, Integrations overview, GitHub Connect and GitLab management at `http://127.0.0.1:5186` in newly created isolated native-browser tab 10 (`critique-a-20261023`). No form submitted, Test invoked, or Disconnect armed. Opened an empty Connect form and used Escape: focus returned to Connect. Opening Manage focused its H2. Closed owned tab 10; no helper/server started; other tabs untouched.

Also visually inspected the same-HEAD real fixture images under `.impeccable/review/settings-iteration-5/after/`: overview-dark, multiple-dark, overview-320, github-connect, manage-gitlab-dark, disconnect-confirm. Narrow/multi/armed-state observations below come from these screenshots and source, not newly executed mutations. No other assessment or archived critique read.

`IntegrationsSection.tsx:334–343` renders `.ig-provider-heading` with Add whenever `saved.length > 0`, then separately renders every saved connection. `renderConnection` at lines 263–272 supplies each connection's own Manage button. `integrations.css:376` puts Add beside the provider heading with an 8px bottom margin; lines 381–385 center Manage on a separate connection summary. The two buttons are separate DOM rows, not accidental CSS wrapping.

HEAD's diff adds the saved-provider heading/Add at lines 334–338 and removes the provider heading formerly embedded in a single connection's summary. It also moves Add inside management to its navigation at lines 311–312. The overview consequently retains an Add entry point despite Add already being available inside Manage. This directly explains the newly stacked silhouette.

Live geometry at 1920×965 viewport, 800px Settings dialog: GitHub provider height 57.59px (first row has no top padding); GitLab/Jira each 111.84px. Each connected provider has Add 114.77×30px above Manage 88.91×30px, with button tops 43.42px apart. Right edges align at x=1324; unequal widths create stepped left edges. There are five overview actions across three providers. These are measured facts; the relative heights include different first/subsequent-row padding, so the full difference cannot be attributed solely to Add.

## Five priorities

1. **P1 — Two competing actions per connected provider.** Add appears first both visually and in DOM order; routine management comes second. Remove overview Add entirely. Use one action: GitHub **Connect** when empty; saved GitLab/Jira **Manage**. Add stays inside management. This is an explicit brief violation, not a preference for one button treatment. Suggested follow-up: `/impeccable distill`.
2. **P1 — Current overview scales by connection, not provider.** `saved.map(renderConnection)` exposes another Manage for every saved connection; `multiple-dark.png` confirms expansion and repeated actions. Collapse to one provider summary/count and one Manage. For one saved connection, open its existing details immediately. For multiple, show a clearly labelled connection selector inside Manage, with name + host + account and an explicit current selection; changing selection shows that connection's existing details in the same management view. Never silently bind provider Manage to `saved[0]`. Suggested follow-up: `/impeccable clarify`.
3. **P2 — Connected and empty providers follow different reading paths.** Empty reads provider → status → action; connected reads provider → Add → host → account/history → Manage. A heading floats above the connection rather than sharing its action line. Compose every provider as glyph | text stack | one centered action, with provider first and connection summary beneath. Keep existing dividers, 16px provider spacing, and 12px glyph gap; allow natural height growth for content. Suggested follow-up: `/impeccable layout`.
4. **P2 — GitHub Connect lacks requested primary emphasis.** Overview Connect is `btn ig-manage`, the same neutral treatment as Manage, whereas form Connect is `btn primary`. Apply the existing primary variant to the empty-provider Connect; keep Manage neutral. Primary is mandated by this brief and supported by ccdeck conventions. A claim that every navigation action must always be filled would be subjective and unsupported. Suggested follow-up: `/impeccable polish`.
5. **P2 — Narrow text column magnifies the two-tier structure.** In the 320px fixture, the host breaks before its final character and account/date text occupies four lines while two buttons sit at different levels. That is visible wrapping, not demonstrated clipping or overlap. A single action beside the provider text removes the extra action tier; keep the summary concise, use connection count for multiple, and retain detailed host/account/history inside Manage. Keep wrapping and `minmax(0,1fr)`; do not fix this with smaller type, hidden identity or a fixed row height. Suggested follow-up: `/impeccable adapt`.

## Incumbent button conventions

| Surface | Source and rendered evidence | Consequence |
|---|---|---|
| Connect form | `IntegrationConnectionForm.tsx:165–169`: `btn primary` Connect/Save then neutral Cancel; live screenshot and computed styles confirm both 30px tall, primary accent wash/edge, neutral transparent background | Reuse this primary variant for GitHub Connect; preserve form's primary-first, left-aligned action group |
| Native connection management | `IntegrationConnectionDetails.tsx:61–79`, `IntegrationsSection.tsx:307–318`: neutral Test/Edit and Add, borderless Back, separated danger Disconnect; live rendering confirms 30px controls and focused heading | Neutral Manage fits navigation/maintenance; preserve removal separation and current controls |
| General settings | `ElsewhereSection.tsx:77–94`, `SettingsParts.tsx:83–90`, `menus.css:201–243`: labelled text/note left and one neutral Open control right; inspected live General and measured its Open controls at 30px | One contextual action per overview row already belongs to the product's settings vocabulary; no new cards or navigation required |

Shared geometry is already coherent: `tokens.css:65–84` defines `--ctl-h:30px`, `--r-ctl:6px`; `topbar-controls.css:447–484` defines neutral/primary buttons. Connect's 80px minimum and Manage's approximately 89px natural width differ because Manage includes a chevron. Equal-width action slots could polish the scan line, but this is optional taste; replacing the button system or forcing all actions filled would not solve the measured regression. Existing right edges already align.

## Nielsen scores

0 = absent/poor, 4 = excellent. Scope: this Operate surface, using rendered layout plus inspected behavior source. Failure paths were not live-executed.

| Heuristic | Score | Reason |
|---|---:|---|
| Visibility of system status | 3 | Saved counts, historical verification wording, busy/status/error handling; no claim that saved means currently healthy |
| Match with real world | 3 | Familiar provider names and hosts; Add preceding Manage disrupts routine-task order |
| User control and freedom | 3 | Back/Cancel, dirty-leave guard; live Escape restored Connect focus |
| Consistency and standards | 2 | Shared controls are consistent, but empty/saved row composition differs and Connect lacks requested emphasis |
| Error prevention | 3 | Busy guards, blank edit secret preservation, explicit disconnect confirmation in source |
| Recognition rather than recall | 3 | Identity visible and buttons labelled; provider selection must remain explicit after consolidation |
| Flexibility and efficiency | 2 | Direct single-connection Manage works; expanded multi overview and competing Add increase scanning |
| Aesthetic and minimalist design | 2 | Restrained visual system, but five actions and two tiers dilute three-provider scan |
| Error recognition/recovery | 3 | Source/fixtures show scoped errors, Retry and retained management context; not live-provoked |
| Help and documentation | 3 | Contextual token guidance and local-storage disclosure |
| **Total** | **27/40** | **Acceptable; focused composition correction needed** |

## Strengths, load and emotional journey

- Consistent type, hairlines and established 30px controls feel like a developer tool. Retain them.
- Detail facts, routine Test/Edit and the separate Remove connection section make consequential actions understandable. Keep this structure.
- Token help is disclosed when needed; saved credentials are represented as stored locally rather than exposed. Back/Cancel and focus restoration provide reassurance.

Cognitive-load checklist: three failures—action hierarchy, one decision at a time, and progressive disclosure of extra connection operations. Provider grouping, concise category list and visible identity work; no necessary memory bridge on the overview. Five visible provider actions are a competing scan set, not proof that five independent tasks must be remembered. Multiple-dark raises that to seven provider actions across three providers. Consolidating to three contextual actions addresses the actual decision load.

Journey: familiar provider recognition → hesitation at Add versus Manage → reassurance in clearly labelled details → safe removal boundary. The avoidable emotional valley is deciding whether an existing connection should be added again or managed.

Persona red flags: Alex must scan repeated actions, and would resent a new chooser step for one connection. Jordan sees Add before the already-saved host and may infer setup is unfinished. Sam encounters Add before the connection-specific Manage in source/keyboard order; retain provider-specific accessible labels and explicit selection announcements. These are walkthrough inferences, not a completed assistive-technology audit.

## Smallest coherent recommendation

Keep the existing Settings shell, overview heading, provider glyphs/dividers, disclosure and count footer. Each provider gets one text stack and one right-side action. Empty: provider + Not connected, **Connect** primary. One saved: provider + concise host/account summary, **Manage** neutral. Multiple: provider + count/concise summary, **Manage** neutral. Add exists only in management. A multi provider's management view contains a labelled connection selector and the selected connection's existing details; a single provider bypasses selection UI entirely.

Consolidation needs provider-level management state in addition to `managedId`, since current `openManage` accepts a concrete connection. Preserve explicit connection IDs for Test/Edit/Disconnect, source-of-entry focus/scroll restoration, dirty-form guards, unavailable/stranded connections and disappearance handling. Selection changes must cancel armed removal and scope notes to the selected ID. Preserve the current untimed confirmation while focus stays in its action group, cancellation on leaving/blur/visibility change, repeat/double-press guard and safe busy handling (`IntegrationsSection.tsx:70–92,152–187`; `IntegrationConnectionDetails.tsx:69–79`). The current 4s unfocused fallback is not a focused confirmation deadline; do not reintroduce one.

No redesign, tabs, cards, backend, dependencies, releases or repository writes are needed for this recommendation. No commits, pushes, installs or builds performed. Live checks cover desktop navigation/composition only; multi/narrow/confirmation evidence is from the supplied same-HEAD fixtures and source. Parent retains runtime and button-audit ownership.

Questions skipped: latest brief resolves composition and action hierarchy; Assessment A returns findings to parent for synthesis.
