# Development and release workflow

This is the authoritative workflow for developing and releasing ccdeck, for
people and AI agents alike. It is a permanent rule, not a note for one
release. `AGENTS.md` and every other instruction file point here instead of
repeating it; if one of them disagrees, this file wins and the other is
fixed. It applies from ccdeck 3.45.0 on.

Every agent reads `AGENTS.md` and this file before changing anything. A lead
agent that delegates work passes these rules to each worker, in the worker's
instructions or as a link to this file.

## 1. Development with several agents

- Several agents may work at the same time on independent features, fixes,
  tests and documentation.
- Each worker uses its own branch and worktree, or a workspace the lead
  explicitly coordinates. Two workers never edit the same files or the same
  worktree at the same time without coordination.
- A worker delivers focused commits with the tests that cover them, and a
  handoff that names the exact branch and commit SHA, the commands it ran with
  their results, and what it did not test.
- The lead agent integrates: it resolves conflicts, runs the final
  validation and coordinates the release.
- Run focused tests on intermediate commits. The full suites run on the
  integrated release candidate, not on every intermediate commit.
- Preserve authorship, licensing and provenance. Each commit keeps its real
  author; never present someone else's work as your own; say where ported
  code came from.

## 2. Branches

| Branch | What it holds | Created from | Goes into |
|---|---|---|---|
| `main` | Released code only | | |
| `development` | Completed, reviewed, public-safe work for coming releases | a published release on `main` | `release/vX.Y.Z` |
| `feature/<topic>`, `fix/<topic>` | One feature or fix, in its own worktree | `development` | `development` |
| `feature/cli-<scope>` | The long-lived CLI workstream, kept apart (section 6) | a published release on `main` | `development`, only after the owner approves |
| `release/vX.Y.Z` | One release candidate: only complete, approved work | `development` | `main`, by one pull request |
| `hotfix/vX.Y.Z` | One urgent production fix, for a short time (section 5) | the published tag it fixes | `main`, by one pull request |

The three flows:

- **Normal:** `feature/*` and `fix/*` → `development` → `release/vX.Y.Z` → `main`.
- **Hotfix:** `main` → `hotfix/vX.Y.Z` → `main` → `development`.
- **CLI:** `main` → `feature/cli-<scope>`, developed and tested on its own,
  → `development` only when the owner approves.

Rules for every branch:

- `main` changes only by merging a release or hotfix pull request, as a merge
  commit.
- `development` is never reset, rebased, force-pushed or deleted. It never
  holds private code or private data. Work goes into it only after review and
  tests, with the owner's approval of the exact commit.
- `development` is created fresh from a published release commit on `main`.
  It never restores or reuses the earlier development history, which stays
  archived outside this repository. Until it exists, the lead uses a local
  integration branch in its place.
- There is no permanent `hotfix` branch. A `hotfix/vX.Y.Z` branch exists for
  one fix only.
- New branches use the `feature/` and `fix/` prefixes. Older branches keep
  their names.

## 3. The default public release

A coordinated feature release goes through these steps:

1. Feature and fix branches, built by one or more agents in parallel, are
   integrated into `development`. The CLI workstream is not, until the owner
   approves it (section 6).
2. `release/vX.Y.Z` takes only the complete, approved features. When
   `development` also holds work that is not ready, cut the release branch
   from the released `main` and merge only the approved work into it. Never
   merge unfinished `development` work into a release blindly.
3. The exact release tree is frozen and fully validated: that is the release
   candidate.
4. ONE public release branch, `release/vX.Y.Z`.
5. ONE public pull request to `main`.
6. Public CI and the required branch protection checks.
7. One approved merge into `main`, as a merge commit.
8. An approved release tag on that merge commit. The tag's automated workflow
   publishes to npm and creates the GitHub release.
9. After publication, `main` is merged into `development`, so `development`
   is in sync without losing unreleased work. Never reset or force-push
   `development`.

One release pull request does not mean one commit. Keep meaningful, logically
separate commits; never squash the whole release into one.

Do not open a public pull request per worker or per feature just because
different agents built them. A separate pull request is right for an external
contribution, an urgent fix (section 5), a change that is released on its
own, or work that needs its own review boundary. Say why in that pull request.

## 4. Approval boundaries

Publishing takes two separate approvals from the owner:

- **Batch 1:** the exact public release or hotfix branch, its head SHA and the
  pull request. This approves the push and opening the pull request, nothing
  more: no merge, tag or publication.
- **Batch 2:** after public CI passes, the release tree is verified, the
  package is audited and the release is reviewed. Only then merge, tag and
  publish, through the automated workflow.

Approving a roadmap, a plan or local work is never permission to push
anything public. Creating `development`, `release/`, `hotfix/` or
`feature/cli-` branches in the public repository, and changing branch
protections, each need the owner's approval.

Without the owner's explicit approval, never force-push, rewrite history,
dispatch a workflow, transfer code to a runner, delete a branch or tag, or
change a secret.

## 5. Hotfixes

A hotfix is for an urgent defect in the published release: a security
problem, data loss, a broken install, start or upgrade, or a regression that
blocks normal use. Everything else waits for the next release.

1. Check that `main` equals the published tag being fixed, `vX.Y.Z`. If
   `main` holds anything else, stop and ask the owner.
2. Create `hotfix/vX.Y.(Z+1)` from that tag, in its own worktree.
3. Make the smallest change that fixes the defect, with a regression test
   that fails before the fix and passes after it. Bump the patch version and
   add its release note. Nothing else: no refactoring, no features, no
   unrelated fixes.
4. Validate the exact hotfix tree like any release candidate (section 7),
   including the security and privacy gates over its commits and its tree, a
   fresh install, and an upgrade from the release it fixes.
5. Batch 1, then Batch 2 (section 4): one public `hotfix/` branch, one pull
   request to `main`, a merge commit, the tree check, the tag on that merge
   commit, and the automated publication.
6. After publication, merge `main` into `development` with a merge commit.
   Resolve conflicts so that `development` keeps its own work and gains the
   fix, then run the regression test and the tests around the fix on the
   result. If a `release/` branch is open, merge `main` into it as well and
   revalidate it. The CLI workstream takes the fix at its next sync.

Never merge `development` into a hotfix, tag a hotfix branch before its merge,
skip a gate or an approval because the fix is urgent, or reuse a hotfix
branch for a second fix. The branch stays until the owner approves deleting
it.

## 6. The CLI workstream

New command-line work happens apart from everything else until it is
finished. The CLI commands already released are on `main` and are not part
of this rule.

- When the CLI implementation starts, the lead creates one long-lived branch,
  `feature/cli-<scope>`, from the latest published release, in its own
  worktree.
- The CLI agent may develop on its own, commit as it goes, run tests and
  builds, and use helpers. Each helper works on its own
  `feature/cli-<scope>-<topic>` branch and worktree, and its work goes into
  `feature/cli-<scope>` through the CLI agent.
- The CLI agent never merges unfinished CLI work into `development`, never
  adds it to a release or hotfix branch, never pushes to `main`, never
  changes another feature's worktree, and never publishes unfinished
  functionality.
- From time to time the CLI branch takes the latest published release:
  merge `main` into it with a merge commit, then run the CLI tests. Never
  rebase or reset it, never drop its commits, and never merge `development`
  into it, which would bring in unreleased work.

Before the CLI work goes into `development`, all of these are required:

- it is complete against the agreed requirements;
- tests cover it, including regression tests for the defects found on the
  way;
- a security and privacy review, and the gates in section 7;
- verification on Linux, macOS and Windows;
- documentation for users;
- the owner's explicit approval of the exact commit.

It is then merged into `development` with a merge commit and released
through the normal flow.

## 7. Release candidate integrity

- Validate the exact combined source tree that will be released.
- Run the security and privacy gates over every commit in the release and
  over the final tree. Nothing private may reach a public artifact: no
  private implementation, credential, token, personal value, sensitive
  fixture or unapproved dependency.
- Run focused regression tests during development and the full validation on
  the final release candidate:
  - the test suites on every supported Node version;
  - the supported platforms;
  - the package contents;
  - a fresh install and an upgrade from the previous release;
  - the UI in a real browser, at desktop and phone widths, when the UI
    changed.
- If the code changes after the final validation, record what changed and
  rerun every check it affects.
- After the merge, verify that the tree on `main` equals the approved release
  or hotfix candidate's tree before tagging. The tag goes on the merge commit
  on `main`, never on a release or hotfix branch.

## 8. Boundaries

- Public text holds no private repository paths, credentials, personal data,
  internal tracking IDs or private implementation details. That includes
  commits, pull requests, documentation and release notes.
- Integrating a release never changes licensing or feature availability as a
  side effect.
- Never weaken a safety gate to make a release pass.
