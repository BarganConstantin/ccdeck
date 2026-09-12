# Licensing

ccdeck is licensed under the **GNU Affero General Public License v3.0 only**
(`AGPL-3.0-only`). The full text is in [LICENSE](./LICENSE).

Copyright © 2026 Bargan Constantin.

## What changed, and when

Everything up to and including **3.21.4** was published under the MIT licence,
under all three npm names (`ccdeck`, `agents-deck`, `agent-dag`). The AGPL
applies from the **first release after 3.21.4** onward.

## The old releases are still MIT

This is the part worth being exact about, because relicensing is often
described sloppily.

- **Versions already published under MIT stay MIT.** 3.21.4 and everything
  before it were distributed under the MIT licence, and they remain available
  on those terms. Changing the licence in this repository does not reach
  backwards into copies that are already out in the world.
- **Rights already granted are not revoked.** If you received ccdeck under
  MIT, you keep the MIT permissions you were given for that copy — including
  the right to use, modify, redistribute and sublicense it, and to build
  closed-source work on it. Nothing here takes that away.
- **Old tags and releases stay up.** Git tags up to `v3.21.4`, the GitHub
  releases and the npm versions are not being deleted or rewritten. The MIT
  licence text that shipped inside each of those artifacts is still the licence
  for that artifact.
- **The new licence is not retroactive.** Do not read this change as "ccdeck
  is now AGPL, therefore the old copies are too." It is not, and they are not.

What the change does affect is the code in this repository going forward, and
any release built from it after the relicensing commit.

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

ccdeck claims copyright only over its own code, not over that third-party code.

## Contributing

Contributions are accepted under `AGPL-3.0-only`, the licence of the project
they are contributed to. There is no copyright assignment: contributors keep
copyright in what they write.
