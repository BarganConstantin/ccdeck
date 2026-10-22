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

## 2. The default public release

A coordinated feature release goes through these steps:

1. Local feature branches, built by one or more agents in parallel.
2. One local integration branch with the changes selected for the release.
3. One release candidate: that exact integrated tree, fully validated.
4. ONE public release branch.
5. ONE public pull request to `main`.
6. Public CI and the required branch protection checks.
7. One approved merge into `main`, as a merge commit.
8. An approved release tag. The tag's automated workflow publishes to npm
   and creates the GitHub release.

One release pull request does not mean one commit. Keep meaningful, logically
separate commits; never squash the whole release into one.

Do not open a public pull request per worker or per feature just because
different agents built them. A separate pull request is right for an external
contribution, an urgent security fix, a change that is released on its own, or
work that needs its own review boundary. Say why in that pull request.

## 3. Approval boundaries

Publishing takes two separate approvals from the owner:

- **Batch 1:** the exact public release branch, its head SHA and the pull
  request. This approves the push and opening the pull request, nothing more:
  no merge, tag or publication.
- **Batch 2:** after public CI passes, the release tree is verified, the
  package is audited and the release is reviewed. Only then merge, tag and
  publish, through the automated workflow.

Approving a roadmap, a plan or local work is never permission to push
anything public.

Without the owner's explicit approval, never force-push, rewrite history,
dispatch a workflow, transfer code to a runner, delete a branch or tag, or
change a secret.

## 4. Release candidate integrity

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
  candidate's tree before tagging.

## 5. Boundaries

- Public text holds no private repository paths, credentials, personal data,
  internal tracking IDs or private implementation details. That includes
  commits, pull requests, documentation and release notes.
- Integrating a release never changes licensing or feature availability as a
  side effect.
- Never weaken a safety gate to make a release pass.
