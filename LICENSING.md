# Licensing

ccdeck is licensed under the **GNU Affero General Public License v3.0 only**
(`AGPL-3.0-only`). The full text is in [LICENSE](./LICENSE).

Copyright © 2026 Bargan Constantin.

## The current licence covers the whole codebase

The **complete current ccdeck-owned codebase** is offered under
`AGPL-3.0-only`. Not merely the commits made after the change — the whole
work, as the project distributes it today.

This is worth stating plainly because relicensing is often misread as applying
only to what came after it. It does not. The code implementing the canvas, the
session clusters, the tool-call timeline, the quota and usage panels, the LAN
sync, the installer and the hook was written before the licence changed, and
it is part of the current work. When that code ships in a current release, the
licence the project offers it under is the AGPL.

A licence applies to software — to the code — rather than to a feature as an
idea. So the accurate statement is not "the features are AGPL" but: the
complete current ccdeck-owned codebase, including the code implementing
features that existed before the relicensing, is distributed by the project
under `AGPL-3.0-only`.

The copyright holder is relicensing the complete current work, which is
something a sole copyright holder may do with their own code. That some of
this code also appeared in older MIT releases does **not** mean the project
offers the current repository or the current release under MIT.

## The version boundary

```text
v3.22.0 and later:
    Distributed by the project under AGPL-3.0-only — the complete current
    ccdeck-owned codebase, including the code implementing features that
    existed before the relicensing.

v3.21.4 and earlier:
    Historically distributed under the MIT License. Previously granted MIT
    rights in the material distributed in those releases remain valid.
```

3.22.0 is the first release the project distributes under the AGPL.

## ccdeck is not offered as "MIT OR AGPL"

The project does **not** currently offer ccdeck under a choice of licences.
There is no MIT option and no MIT fallback on what the project distributes
today: obtain the current release from the project, and the licence it is
offered to you under is `AGPL-3.0-only`.

That is a statement about what the project offers now. It is not a statement
about rights somebody was already granted — see
[Historical releases](#historical-releases) for those.

## Historical releases

Before the AGPL relicensing, certain ccdeck releases were distributed under the
MIT License.

Those historical copies retain the rights granted under the license under which
they were originally distributed. Those previously granted rights cannot be
retroactively revoked.

This does not mean that the project dual-licenses ccdeck, or offers part of the
current work under MIT. The current ccdeck-owned codebase and current releases
are offered by the project exclusively under `AGPL-3.0-only`.

Concretely, and without overstating it:

- **Old releases stay usable on their old terms.** Somebody who lawfully
  obtained ccdeck 3.21.4 or earlier under MIT keeps the MIT rights they were
  granted in the material distributed in those releases — including the right
  to use, modify, redistribute and build closed-source work on it. Those
  rights are theirs already, and this change does not touch them.
- **The old artifacts stay up.** Git tags through `v3.21.4`, the GitHub
  releases and the npm versions are not being deleted, unpublished or
  rewritten. The MIT text that shipped inside each of those artifacts is still
  the licence for that artifact. Removing them would not withdraw anything
  anyway.
- **Nothing became AGPL retroactively.** A copy distributed under MIT was
  distributed under MIT and stays that way. Do not read this page as saying
  the old releases are now AGPL, because they are not.

## What the historical MIT grants do and do not cover

Two things are true at once, and both matter:

- **The current ccdeck release, as distributed by the project, is licensed
  under `AGPL-3.0-only`.** That is the licence on offer for what you obtain
  from the project today.
- **Previously granted MIT rights in material distributed in historical MIT
  releases remain valid.** They were granted, they cannot be retroactively
  revoked, and they do not disappear merely because identical or substantially
  identical code also appears in a later AGPL release.

What those historical grants do **not** do is reach forward. They do not cover
new code, or modifications, first distributed under the AGPL. A later release
is not placed under MIT because it contains material that also appeared in an
MIT release: the new and changed code in it is offered by the project under
the AGPL only.

Where the line falls between material already distributed under MIT and code
first distributed under the AGPL is a question about specific code, and this
page does not try to settle it for any particular file. What the project can
state is what it offers, and what it offers for the current release is
`AGPL-3.0-only`.

## Why AGPL

ccdeck is moving toward features that may include hosted or cloud
functionality. The AGPL is chosen so that modifications to the covered software
stay open — including modified versions that users interact with over a
network, which is the case an ordinary GPL does not cover.

The intent is to keep ccdeck open source and ensure that users of modified
network-hosted versions can also access the corresponding source code.
Precisely: the AGPL requires whoever runs a modified version to make the
corresponding source available **to the users interacting with that modified
version over a network**. It does not require anyone to send changes to this
repository, open a pull request, or contribute anything upstream — there is no
obligation to this project, only to those users.

## What this means if you use ccdeck

Running ccdeck as it ships — locally, on your own machine, as a dashboard —
imposes nothing on you. The AGPL's obligations attach to **distributing** the
software or **offering a modified version to users over a network**, not to
using it.

If you modify ccdeck and let other people interact with your modified version
remotely, section 13 of the AGPL requires you to offer **those users** an
opportunity to receive the corresponding source of your modified version, at
no charge, through a network server. That obligation runs to your users, not
to this project: you may keep your changes entirely out of ccdeck's repository
and still comply, so long as the people using your modified version can get
its source.

## Third-party code

ccdeck's published bundle contains code written by other people — React, React
Flow, dagre and their dependencies — under permissive licences (MIT, ISC,
BSD-3-Clause). Those licences are theirs and are unchanged by any of this.
Their copyright and permission notices are preserved in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and must travel with any
copy of ccdeck.

Those MIT and ISC notices describe **dependencies**, not ccdeck. They are not a
second licence on ccdeck's own code, and their presence in the tree does not
put ccdeck's own code under MIT.

ccdeck claims copyright only over its own code, not over that third-party code.

## Contributing

Contributions are accepted under `AGPL-3.0-only`, the licence of the project
they are contributed to. There is no copyright assignment: contributors keep
copyright in what they write.
