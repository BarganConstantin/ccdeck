# Manage — correction to match the supplied reference

Baseline: `273705bf`. The previous polish still differed materially from the
owner's reference: metadata used label/value rows, Add connection occupied a
separate section, the controls were rectangular and Disconnect was red at rest.
The owner explicitly requested the reference composition. This correction follows
it while retaining CCDeck themes and the existing Settings shell.

- Two equal metadata columns on desktop: Host / Account, Last verified /
  Credentials. Labels above values, larger readable values, proportional type
  for the instance. Provider server information remains when present.
- Host display removes only http(s) scheme and a terminal slash; instance paths
  remain. The original configured URL remains in the tooltip and Edit form.
- Neutral rounded Test/Edit buttons, together. Neutral outlined Disconnect,
  with the existing destructive confirmation style when armed. No safety change.
- Removed the separate Add section and its divider/explanatory sentence.
  Add connection remains available in the identity header; it wraps on narrow
  screens. The final Remove area directly follows management actions/feedback.
- One metadata column at narrow widths; long aliases, hosts and accounts wrap.

Applied installed Impeccable polish guidance: fix the local composition defect,
group related content, preserve approved behavior, and judge actual rendering
against the supplied reference. The targeted CLI detector returned `[]`.

## Actual rendered comparison

[Before](../after-manage-gitlab-1440-rider-black.png) ·
[After dark](after-manage-gitlab-1440-rider-black.png) ·
[After light](after-manage-gitlab-1440-light.png) ·
[390px](after-manage-gitlab-390-light.png) ·
[320px](after-manage-gitlab-320-rider-black.png) ·
[Long hostname](after-long-manage-1440-rider-black.png) ·
[Long hostname narrow](after-long-manage-390-light.png) ·
[Confirmation](after-disconnect-confirm-1440-rider-black.png).

Actual application screenshots, with intercepted safe fixtures. Desktop dark,
light and narrow Manage screenshots were manually opened and inspected.

## Checks

663 tests / 43 files passed; typecheck and production build passed on Node 22.
The final build completed in 9.82s with the existing >500kB chunk warning.
The existing browser script passed all five cases (1440 dark/light, 900 dark,
390 light, 320 dark), including multiple connections, Add, Edit, preserved empty
token, failed Test/recovery, guarded deletion, focus restoration, Escape, search
and dirty drafts. Axe passed tested states plus overview/Manage in all 12 themes;
no horizontal overflow or page errors. [Results](browser-results.json).

No live authentication, manual assistive technology, browser zoom or Electron OS
matrix was validated. No backend, API, storage, token handling, Settings shell or
overview changes. Local branch `work/2026-10-23-changes`; no push or merge.
