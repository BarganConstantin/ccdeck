# Licensing

ccdeck is licensed under the **GNU Affero General Public License v3.0 only**
(`AGPL-3.0-only`). The full text is in [LICENSE](./LICENSE).

Copyright © 2026 Bargan Constantin.

## The current licence covers the whole product

The **complete current ccdeck codebase** is licensed under `AGPL-3.0-only`.
Not the recent commits — the whole work, every file in this repository, and
every feature in a current release.

This is worth stating plainly because relicensing is often misread as applying
only to what came after it. It does not. The canvas, the session clusters, the
tool-call timeline, the quota and usage panels, the LAN sync, the installer,
the hook — features that existed long before the licence changed — are part of
the current work, and the current work is distributed under the AGPL. A
feature's age does not give it a different licence from the release it ships
in.

The copyright holder is relicensing the complete current work, which is
something a sole copyright holder may do with their own code. That some of
this code also appeared in older MIT releases does **not** make the current
repository or the current releases partly MIT.

## The version boundary

```text
Current ccdeck / v3.22.0 and later:
    AGPL-3.0-only — the entire codebase, all features.

Historical releases / v3.21.4 and earlier:
    Were distributed under the MIT License, and retain only the rights
    already granted for those historical copies.
```

3.22.0 is the first release cut under the AGPL. Everything from it onward is
AGPL-only.

## ccdeck is not dual-licensed

ccdeck is **not** offered as "MIT OR AGPL". There is no current MIT option, no
MIT fallback, and no part of a current release that can be taken under MIT
terms.

If you are reading the current repository or a current release, exactly one
licence applies to ccdeck's own code: `AGPL-3.0-only`.

## Historical releases

Before the AGPL relicensing, certain ccdeck releases were distributed under the
MIT License.

Those historical copies retain the rights granted under the license under which
they were originally distributed. Those previously granted rights cannot be
retroactively revoked.

This does not mean that the current ccdeck codebase is dual-licensed or
partially MIT. The current ccdeck codebase and current releases are licensed
exclusively under `AGPL-3.0-only`.

Concretely, and without overstating it:

- **Old copies stay usable on their old terms.** Somebody who lawfully obtained
  ccdeck 3.21.4 or earlier under MIT may go on using, modifying, redistributing
  and building closed-source work on **that version**, under MIT. That is a
  right they already have and this change does not touch it.
- **The old artifacts stay up.** Git tags through `v3.21.4`, the GitHub
  releases and the npm versions are not being deleted, unpublished or
  rewritten. The MIT text that shipped inside each of those artifacts is still
  the licence for that artifact. Removing them would not withdraw anything
  anyway.
- **Nothing became AGPL retroactively.** A copy distributed under MIT was
  distributed under MIT and stays that way. Do not read this page as saying
  the old releases are now AGPL, because they are not.

## What similarity does not buy you

The distinction that actually matters in practice:

MIT rights attach to **the historical material in the copy someone actually
received**, not to the current release and not to later AGPL-only work.

So if a file in ccdeck 3.22.0 resembles one from 3.21.4, that resemblance does
not place the 3.22.0 file under MIT, and it does not let anyone take the
current release — or any later change to that file — under MIT terms. The MIT
grant a recipient holds runs to the version they received. Later versions are
distributed under the AGPL, and that is the licence on offer for them.

Put the other way around: the way to rely on MIT rights is to rely on the
actual MIT-licensed release you received, with the code as it stood in it — not
to treat the current AGPL release as though it were still MIT.

## Why AGPL

ccdeck is moving toward features that may include hosted or cloud
functionality. The AGPL is chosen so that modifications to the covered software
stay open — including modified versions that users interact with over a
network, which is the case an ordinary GPL does not cover.

The intent is to keep ccdeck open source while making it harder for a modified
version to be run as a closed-source competing hosted service. Precisely: the
AGPL requires whoever runs a modified version to make the corresponding source
available **to the users interacting with that modified version over a
network**. It does not require anyone to send changes to this repository, open
a pull request, or contribute anything upstream — there is no obligation to
this project, only to those users.

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
make any part of the current product MIT-licensed.

ccdeck claims copyright only over its own code, not over that third-party code.

## Contributing

Contributions are accepted under `AGPL-3.0-only`, the licence of the project
they are contributed to. There is no copyright assignment: contributors keep
copyright in what they write.
