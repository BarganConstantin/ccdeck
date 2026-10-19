# The GitHub and GitLab panels

Issue [#2179](https://github.com/BarganConstantin/ccdeck/issues/2179). Built
on the integrations core of
[#2178](https://github.com/BarganConstantin/ccdeck/issues/2178): its
connections, Settings → Integrations, the rail control, the large modal, the
list/detail split, the per-connection prefs and the asset route.

The deck can be connected to GitHub or GitLab, so the branch, the merge
request, the pipeline and the issue behind an agent's work sit next to it. It
reads, and only reads: every REST call is a GET and every GraphQL document is a
query.

## What a person sees

- **Settings → Integrations → Add integration** lists GitHub ("github.com,
  read-only, with a personal access token") and GitLab ("GitLab.com or your
  own instance, read-only").
  - *Connect GitHub* asks for the token and an optional name.
  - *Connect GitLab* asks which GitLab (GitLab.com or Self-managed), the
    instance's address when self-managed, the token and an optional name.
  - The token help sits under the fields (below). Connecting checks the token
    with the forge before anything is saved.
- **One control per connected kind on the left stripe**, as Jira's, under More
  on a phone. GitHub and GitLab have no keyboard shortcut of their own.
- **The panel**, inside the host's 90vw × 90dvh modal, under its header (the
  forge's mark and name, which connection, Close):
  - **The toolbar:** the project (GitLab) or repository (GitHub) picker, when
    the list was last read, and Refresh.
  - **Four tabs**, the screens a GitLab user works through:

    | Tab | GitHub | GitLab | Without a project |
    |---|---|---|---|
    | Branches | Branches | Branches | needs one |
    | Changes | Pull requests | Merge requests | All repositories / All projects |
    | Pipelines | Actions | Pipelines | the 10 most recently pushed / active |
    | Issues | the repository's issues | assigned to you | GitLab only |

    A tab that needs a project picks the most recently active one until the
    user picks another (`tabAllowsAllProjects` in `forge-panel.ts`).
  - **Search** over the rows already loaded: by branch name on Branches, by
    title or number elsewhere. A pasted merge request, pull request or issue
    link, or a full key (`group/project!12`, `acme/web#12`), adds an *Open*
    button that resolves it and opens the item.
  - **The item page**, beside the list from 900px and its own screen with Back
    under that. A branch row opens its change when it has one, the branch
    otherwise.
- **The lists:**
  - *Branches*, as GitLab's Branches page: Active branches open, Stale (no
    commits in 90 days) folded. A row has the name to copy, default and
    protected tags, the last commit, behind | ahead against the default branch
    (`999+` past a thousand), the pipeline, and the change's badge or *Create
    merge request ↗* (*Create pull request ↗*).
  - *Merge requests / Pull requests*, as GitLab's dashboard: Open / Merged /
    Closed with the forge's counts, All / Mine / Review requests, sorted by
    created or last updated. Review requests split into *Waiting for my
    review* and *Approved by me* (folded). A row has the title (a draft
    marked), labels, `!12 · created 3h ago by Author`, the pipeline, Approved,
    the reviewers with how each stands, the comment count and when it moved.
  - *Pipelines / Actions*: the state and how long it ran, the title (on
    GitHub the run's title, with the workflow under it), the ref, short sha,
    what started it, who, and when.
  - *Issues*: Open / Closed. The title with labels, `#12 · opened 3d ago by
    Author`, the milestone, child items done of how many, assignees, comments.
- **The item pages:**
  - *A merge request / pull request:* the title and state, "Author requested
    to merge source into target", the pipeline line (a jump to it) and the
    approvals; the side facts (assignees, reviewers with their state, labels,
    milestone, participants); and four sections with counts:
    - Overview (Conversation on GitHub): the description, then unresolved
      threads open, resolved threads and general comments folded. A thread
      says `path:line`, never a code snippet.
    - Commits; Pipelines (Actions); Changes (Files changed): a file list with
      its status and +/−, never a diff.
  - *A branch:* name, default / protected / stale, the latest commit, behind
    and ahead of the default branch, the latest pipeline, the change (or
    *Create merge request*), and the commits not in the default branch (ten,
    then *Show all*).
  - *A pipeline:* the state, who or what started it, when and how long; the
    ref and sha it ran on; the change, when it ran for one; then the jobs by
    stage. A failed job shows its reason, its annotations (GitHub) and, on
    *Show log*, the end of its log: 80 lines, then 200, then 500, then
    *Full log ↗* on the forge.
  - *An issue:* title and state (with GitHub's reason), the side facts
    (assignees, labels, milestone, parent), the description, child items
    (GitLab's tasks, GitHub's sub-issues), and the comments behind *Show N
    comments*, read only when pressed.
  - Every page has the reference to copy and *Open in GitHub / GitLab ↗*.
- **Freshness.** A read older than two minutes is asked again when it is drawn.
  Nothing polls, a running pipeline included; Refresh asks every read on
  screen again. A failed refresh keeps the last answer on screen and says
  "Not updated · last answer 5m ago" over it.
- **Remembered per connection, in this browser:** the project, the tab, the
  change filter, state and sort, the issue state, and which groups are
  unfolded. The detail's width is remembered per forge.

## GitHub and GitLab: what is supported

| | GitHub | GitLab |
|---|---|---|
| Where | github.com only. The client takes an Enterprise Server address (`/api/v3`, `/api/graphql`); the provider does not offer one yet. | GitLab.com, or a self-managed instance at its address, under its path if it has one |
| Token | personal access token, classic or fine-grained | personal access token with `read_api` |
| Auth | `Authorization: Bearer`, `X-GitHub-Api-Version: 2022-11-28` | `Authorization: Bearer` |
| The token goes to | `https://api.github.com` only | the instance's origin only |
| Reads | GraphQL first, one query per screen; REST for the token's scopes, a pull request's files, Actions runs and job logs | REST for the lists (the dashboard's filters, order and `x-total`), completed by one GraphQL query per page through `projects(fullPaths:)` |
| Checking the token | `GET /user`. A classic token without `repo` or `read:org` is saved with a warning; a fine-grained token sends no scopes and gets none. | `/user`, `/version`, `/personal_access_tokens/self`. Warns without `read_api` or `api`, and under GitLab 16. |
| Older servers | newer issue fields (sub-issues, types, state reasons) asked again without them | the schema is read (cached) and only fields the instance has are asked for; work-item queries are retried without the work-item part |
| Default name | the account's login | the instance's host |

## Architecture

```
src/server/
  forge-http.mjs        the transport (send, json, graphql, tail, asset)
  github-api.mjs        the GitHub client
  gitlab-api.mjs        the GitLab client
  forge-routes.mjs      sub-path → read, parameters checked, one envelope
  integrations/forge.mjs      githubProvider, gitlabProvider
  integrations/providers.mjs  registerProvider(githubProvider), (gitlabProvider)
src/web/
  forge-types.ts        the shapes both clients answer in; forgeWords
  forge-panel.ts        reads, kept answers, words, groups, view, focus
  forge-lists.ts        a list's words and states
  forge-detail.ts       an item page's rules: sections, stages, log steps
  forge-html.ts         the forge's HTML as an allow-listed tree
  use-forge-read.ts     useForgeRead, useForgePages
  components/ForgeHtml.tsx  that tree as React elements
  components/forge/
    ForgeIntegrations   GithubPanel, GitlabPanel, the form's fields, token help
    ForgePanel          toolbar, tabs, search, split
    ForgeContext        what every tab and page shares
    ForgeParts          marks, badges, folds, failures, people, copy, links
    RepoPicker          the project / repository picker
    BranchesTab ChangesTab PipelinesTab IssuesTab
    ChangeDetail BranchDetail PipelineDetail IssueDetail
    DetailParts DetailThreads DetailJobs
    ForgeTokenHelp
  styles/forge-panel.css  forge-lists.css  forge-detail.css
```

The glyphs are `GithubGlyph` and `GitlabGlyph` in
`src/web/components/rail-glyphs.tsx`. Both kinds are entries in `INTEGRATIONS`
(`src/web/integrations/registry.ts`).

### The transport

`createForgeTransport({token, authHeaders, allowedOrigins, fetchImpl, now,
timeoutMs, maxBytes})` in `forge-http.mjs` is the one road both clients take:

- **`send`** follows redirects by hand (at most 3) and decides the token again
  at every hop: it is attached only when the URL's origin is one of
  `allowedOrigins`. A hop elsewhere (GitHub sends a job's log to a signed
  blob-storage URL) goes out without it. An `allow` function, when given, is
  asked about the address and every hop after it; a refusal is a
  `permission` error (403). A caller's `signal` and the timeout (20 s by
  default) both end the request.
- **`json`** reads a 2xx as JSON, up to 16 MB. A 2xx that is not JSON (a login
  page, a proxy's splash) is `incompatible`.
- **`graphql`** POSTs a query. Errors beside data are handed back for the
  caller to weigh; errors without data throw.
- **`tail`** reads the end of a job's log: a suffix `Range` of 256 KB first; a
  server that ignores Range is streamed with only the last lines kept, up to
  64 MB. The first line of a partial answer is dropped. Lines lose ANSI codes,
  GitLab's section markers and carriage-return progress bars. 60 s timeout.
- **`asset`** fetches an image for the asset route: `allow` is the client's
  image-host list, checked on every hop. Only `image/png`, `image/jpeg`,
  `image/gif` and `image/webp` are taken (never SVG), at most
  `ASSET_MAX_BYTES` (8 MB), counted while streaming. 15 s timeout.

### The clients

`createGithubClient` and `createGitlabClient` have the same interface:
`allowedOrigins`, `validate`, `listRepos`, `listBranches`, `getBranch`,
`listChanges`, `countChanges`, `getChange`, `listChangeCommits`,
`listChangePipelines`, `listChangeFiles`, `listPipelines`, `getPipeline`,
`jobLogTail`, `listIssues`, `getIssue`, `listIssueComments`, `resolveRef`,
`fetchAsset`.

- **Where the token goes:** `allowedOrigins` is `[https://api.github.com]` for
  GitHub (not even github.com's web pages) and `[instance origin]` for GitLab.
- **Where images come from** (`fetchAsset`):
  - GitHub: `IMAGE_HOSTS` (`avatars.githubusercontent.com`,
    `private-user-images.githubusercontent.com`,
    `user-images.githubusercontent.com`, `camo.githubusercontent.com`) and
    github.com, https only. None of them is the API, so none gets the token.
  - GitLab: the instance's own origin, with the token, and `GRAVATAR`
    (`secure.gravatar.com`, `www.gravatar.com`, `gravatar.com`) over https,
    without it.
- **Pasted references** (`resolveRef`): GitHub reads its own URLs without
  asking, and asks GraphQL which a key (`owner/repo#12`) is, because issues
  and pull requests share numbers. GitLab reads URLs of its own instance (and
  path) and keys (`group/project!12`, `group/project#12`) without asking.
- **Short caches** live in the client, which the core keeps per connection
  and makes again when the connection or token changes. GitHub keeps a
  repository's sorted branch scan for 5 minutes (for later pages only).
  GitLab keeps project info for 5 minutes, the schema for 10, and an
  ahead/behind count by its pair of SHAs.

### The providers

`githubProvider` and `gitlabProvider` in `src/server/integrations/forge.mjs`:

- **`parseInput`:** GitHub's `baseUrl` is always `https://github.com`. GitLab's
  is `https://gitlab.com` unless the form says `where: "self"`, when the typed
  address goes through the core's `normaliseBaseUrl` (https, or http on this
  machine only; no credentials; kept under its path).
- **`tokenFrom`:** the typed token, or the saved one when an edit leaves the
  field blank; a new connection without one is `invalid` on the token field.
- **`withPhase`:** wraps the client's `validate`. A token refused while the
  form is checked is `auth` (a wrong token); refused on Test (`phase: "use"`),
  after it was saved, it becomes `expired`.
- **`defaultName`:** the account's login on GitHub, the instance's host on
  GitLab.
- **`routes`:** every read goes to `forgeRead` (below).

They are registered in `src/server/integrations/providers.mjs` beside Jira.
Feature use is `github` and `gitlab`, matching `jira`:

- `ROUTE_PREFIX_FEATURES` in `src/server/feature-use.mjs`
  (`GET /api/integrations/github/`, `GET /api/integrations/gitlab/`);
- `FEATURES` in `src/server/usage-day.mjs`;
- `src/web/feature-use.ts`.

The name is the provider's, never the connection or the item.

### Routes

The connection routes, the guarded-read gate and the asset route are the
core's (`docs/features/jira-integration-2178.md`). The panel's reads are
`GET /api/integrations/<kind>/<id>/<read>`, from `READS` in
`forge-routes.mjs` (`FORGE_READS` lists them):

| Read | Parameters | Answers |
|---|---|---|
| `repos` | `search?`, `cursor?` | projects / repositories, most recent activity first |
| `branches` | `repo`, `cursor?` | a page of 20 branches with ahead/behind, pipeline, change |
| `branch` | `repo`, `name` | the branch, its latest pipeline with jobs, its commits ahead |
| `changes` | `repo?`, `filter`, `state`, `sort`, `cursor?` | a page of merge requests / pull requests |
| `change-counts` | `repo?`, `filter` | the Open / Merged / Closed counts |
| `change` | `repo`, `number` | the Overview: description, threads, tab counts |
| `change/commits` | `repo`, `number`, `cursor?` | its commits |
| `change/pipelines` | `repo`, `number` | its pipelines with jobs |
| `change/files` | `repo`, `number`, `cursor?` | its changed files, no diff |
| `pipelines` | `repo?`, `cursor?` | pipelines / Actions runs, newest first |
| `pipeline` | `repo`, `id` | one pipeline with its jobs |
| `job-log` | `repo`, `id`, `lines?` | the end of a job's log, and the job's page |
| `issues` | `repo?`, `state`, `cursor?` | a page of issues |
| `issue` | `repo`, `number` | the issue with description and child items |
| `issue/comments` | `repo`, `number`, `cursor?` | its comments |
| `resolve` | `q` | `{type, repo, number}` for a pasted link or key, or null |

Every parameter is checked before the forge hears of it, and a wrong one is
`invalid` (400):

- `repo`: a path of 2 to 21 segments of `[A-Za-z0-9_.-]`, at most 255
  characters, no `.` or `..` segment. Optional (`repo?`) means "across
  projects" when left out.
- `number`: a positive integer of up to 15 digits.
- `pipeline`'s `id`: the same, or one of GitHub's two other kinds that a
  pull request's Pipelines section lists beside the Actions runs: another
  app's check suite, `suite:<digits>`, or a commit's statuses,
  `status:<hex sha>`.
- `job-log`'s `id`: `[A-Za-z0-9_-]`, 1 to 64 characters. `lines`: clamped to
  10–500, 80 by default.
- `filter`: `all` (default), `mine` or `review`. `state`: `open` (default),
  `merged` or `closed`; for issues `open` or `closed`. `sort`: `created`
  (default) or `updated`.
- `cursor`: `[A-Za-z0-9_=+/.:-]`, at most 512 characters. `search`: at most
  100 characters; `name`: 255, no whitespace or NUL; `q`: 500.

An unknown read is `not-found` (404) and any method but GET is 405. A success
is `{ok: true, data}`.

### Errors

Every failure is `{ok:false, error:{kind, message, status?, retryAfter?}}`,
the envelope Jira's reads use. The HTTP status comes from `STATUS_OF_KIND`:

| kind | HTTP | From |
|---|---|---|
| `auth` | 401 | a 401 from the forge |
| `expired` | 401 | a 401 whose message says expired (GitLab), or a refused token on Test |
| `permission` | 403 | a 403 that is not a rate limit; GraphQL `INSUFFICIENT_SCOPES` / `FORBIDDEN`; a host off the allow-list |
| `not-found` | 404 | a 404; GraphQL `NOT_FOUND`; an unknown read |
| `rate-limit` | 429 | a 429; GitHub's 403 with `x-ratelimit-remaining: 0`, "rate limit" or `Retry-After`; GraphQL `RATE_LIMITED` |
| `invalid` | 400 | a parameter that is not the shape it must be |
| `unreachable` | 502 | no answer, a timeout, or a 502/503/504 |
| `tls` | 502 | a certificate Node does not trust |
| `incompatible` | 502 | a 2xx that is not JSON, or an image that is not one |
| `upstream` | 502 | any other answer; anything that is not a ForgeError |

`retryAfter` is read from `Retry-After`, GitHub's `x-ratelimit-reset` or
GitLab's `RateLimit-Reset`. A message carries the forge's own words, capped at
300 characters, never a header or the request. An error that is not a
ForgeError says only "unexpected error reading the forge".

The panel picks its sentence from `kind` (`forgeErrorWords` in
`forge-panel.ts`), naming the forge:

| kind | Title | Then | Offers |
|---|---|---|---|
| `auth` | GitLab refused the token | It may have been revoked. Update it in Settings › Integrations. | Open connection settings |
| `expired` | The GitLab token has expired | Create a new one and paste it in Settings › Integrations. | Open connection settings |
| `permission` | The token cannot read this | the forge's message, then: check the token's scopes | Open connection settings |
| `incompatible` | This is not a GitLab API | the message, then: check the address | Open connection settings |
| `unreachable` | GitLab did not answer | Check the network or VPN, and whether the instance is up. | Try again |
| `tls` | GitLab's certificate is not trusted | Add its CA to the system, or set `NODE_EXTRA_CA_CERTS`. | Try again |
| `rate-limit` | GitLab asked to slow down | Try again in 40s (or after 14:05), or in a minute when the forge gave no time | Try again |
| `not-found` | Not found | It was deleted, moved, or this token cannot see it. | Try again |
| `upstream` | GitLab answered with an error | the forge's message | Try again |
| `invalid` | The deck could not ask for that | the message | Try again |

*Open connection settings* is the host's Reconnect: Settings at that
connection's edit form. An item page that is gone says "This merge request no
longer exists, or this token cannot see it." With an answer still on screen a
failure is one compact line, "Showing the last answer.", above it.

### Images

Avatars and the images in descriptions are fetched by the deck through the
core's asset route, `GET /api/integrations/<kind>/<id>/asset?url=`, which
calls the client's `fetchAsset`. The route's rules are #2178's:

- The host is checked on the address and every redirect hop, against the
  client's list above; the token rides only to `allowedOrigins`.
- PNG, JPEG, GIF and WebP only, checked again against the magic bytes; never
  SVG. At most 8 MB.
- `nosniff`, `default-src 'none'; sandbox`, `private, max-age=300` and
  `same-origin` on the answer.
- Any failure is an empty 404, or an empty 403 for a host it will not read,
  and never touches the connection. A failed image is not asked for again for
  a minute.

On the page an avatar that fails is drawn as its initial and remembered for
the page's life (`failedAvatars` in `ForgeParts.tsx`). An image in a
description that fails becomes the link it stood for.

### A description's HTML

The panels draw the forge's own rendering (GitHub's `bodyHTML`, GitLab's
`descriptionHtml` and `titleHtml`), because it has tables, task lists,
references, mentions and emoji that no renderer of ours would match. It is
someone else's string, so:

- `DOMParser` builds an inert document, and `forge-html.ts` walks it into a
  tree of allow-listed elements with allow-listed attributes. `ForgeHtml.tsx`
  turns the tree into React elements. Nothing is serialised back to HTML, and
  there is no `innerHTML`.
- Script, style, frames, objects, SVG, math, forms and the like go with their
  content. An element off the list is unwrapped: its words stay.
- Classes, ids, styles and event attributes go.
- A link keeps only `http`, `https` or `mailto`, is made absolute against the
  instance (GitLab writes paths), and opens in a new tab with no referrer.
  In-page anchors are dropped.
- An image (GitLab's lazy `data-src` included) loads through the asset route,
  or is drawn as its link. Video and audio become links.
- Task-list checkboxes are drawn disabled. A title keeps only inline marks.
- Depth (48) and node count (5,000) are bounded; past them the rest is cut.

## Security

- **The token stays on the machine.** The page only ever gets `tokenSaved`. The
  token lives in the core's store (`<deck home>/integrations/`, 0700, files
  0600). An error carries the forge's words and the status, never a header or
  the request.
- **Read-only.** REST calls are GETs and GraphQL documents are queries; the
  only POST is the GraphQL endpoint's. `forgeRead` answers GET only. There is
  no write route: no merge, no review, no re-run.
- **https,** except for an instance on this machine (`localhost`,
  `127.0.0.1`, `::1`). The core refuses to send a token anywhere else.
- **The token goes only to the API origin(s):** api.github.com for GitHub,
  the instance for GitLab. Redirects are followed by hand and drop it off
  those origins.
- **Images come from allow-listed hosts only,** through the deck, raster only,
  at most 8 MB.
- **The forge's HTML** reaches the page as an allow-listed tree, never as
  markup.
- **Scrubbing:** reports (`reports.mjs`, `report-errors.ts`) and process
  command lines (`process-command.mjs`) scrub GitHub (`ghp_…`,
  `github_pat_…`) and GitLab (`glpat-…`, `gldt-…` and kin) token shapes.
- **No TLS bypass.** An untrusted certificate is `tls`; the way out is the
  system's CA store or `NODE_EXTRA_CA_CERTS`.

## Token help

`ForgeTokenHelp.tsx` sits under the token field and asks for read access only:

- **GitHub, classic:** the `repo` and `read:org` scopes. *Make one* opens
  `https://github.com/settings/tokens/new?scopes=repo,read:org&description=ccdeck`.
- **GitHub, fine-grained:** the repositories to see, with read-only Actions,
  Checks, Commit statuses, Contents, Issues, Metadata and Pull requests.
  Contents is for branches and commits; the panel never opens files. *Make
  one* opens `https://github.com/settings/personal-access-tokens/new`.
- An organization may have to approve a fine-grained token, or a classic one
  be authorized for its single sign-on, before its repositories show.
- **GitLab:** `read_api`, and nothing more. *Make one* opens
  `<instance>/-/user_settings/personal_access_tokens?name=ccdeck&scopes=read_api`
  on the instance typed so far (under its path), or gitlab.com. The link is
  left out while what was typed is not an address. GitLab tokens expire; the
  panel then says so and brings the user back to the form.

## The web side

### The panel

`GithubPanel` and `GitlabPanel` (`ForgeIntegrations.tsx`) are `ForgePanel` told
its kind and handed the host's `IntegrationSplit`. `ForgePanelProps`:

```ts
{ kind, connection, api, assetUrl, prefs, narrow, onReconnect, Split }
```

`api` prefixes `/api/integrations/<kind>/<connId>/`; `assetUrl` makes an asset
route URL; `prefs` is the host's per-connection store. `ForgeContext` hands the
tabs and pages what they share: the kind and connection, `scope`
(`kind:connId`), `api`, `asset`, the Refresh counter, the selection and
`select`, the unfolded groups, `reportFreshness`, `onReconnect` and `narrow`.

A selection is a change, a branch, a pipeline or an issue (`ForgeSelection`).
Words come from `forgeWords`: Pull request / Merge request, Actions /
Pipelines, Repository / Project, `#` / `!`.

### List and detail

- **The split** is the host's: from 900px the page is a column beside the list
  (440px by default, 320–1600px by dragging, the list keeps 420px), its width
  remembered per forge in this browser.
- **Under 900px** the page is its own screen with *Back to merge requests* (or
  *Back to Actions*, *Back to branches*…). The list stays mounted, hidden, so
  its scroll and folds are where the reader left them. Escape on that screen
  is Back, before it closes the modal.
- **Close** is in the page's bar on a wide window only; a narrow one has Back.
- **Focus** (`focusAfterSelect` in `forge-panel.ts`):
  - Back and Close return focus to the row the page was opened from.
  - Opening a page from a row on a wide window leaves focus on the row, so the
    list stays walkable beside the page.
  - Opening it on a narrow window, or from a control that is no longer on
    screen (a link on the page being replaced), moves focus to the page
    (`.fd`, `tabIndex -1`).
- **Keys:** the tab strip and a change's sections are tablists with one tab
  stop and the arrows between tabs. The picker is a combobox and listbox:
  arrows, Home, End, Enter; Escape closes it and never the modal.

### The remembered view

`loadForgeView(prefs)` and `saveForgeView(prefs, view)` keep a `ForgeView`
under `view` in the host's per-connection store:

```ts
{ repo, tab, filter, state, sort, issueState, open }
```

`repo` null is "All projects" where the tab allows it; `open` lists the groups
whose fold differs from their default (at most 20). `normaliseView` reads each
field back on its own, so anything unreadable falls back field by field. The
default is the Branches tab, open changes, All, created.

### Kept reads and freshness

- **Kept for the page's life.** `fetchForge` asks one read; the answer is kept
  in memory keyed by `scope` and the read's path (at most 200 kept). Opening
  the panel again draws what was kept at once.
- **`FRESH_MS` is 120 s.** `readDue` asks again when the kept answer is older,
  or on Refresh; nothing polls.
- **`isStale`:** a kept answer whose latest refresh failed is still drawn,
  with the failure in one line above it, and the toolbar says "Not updated".
- **Pages:** `useForgePages` appends *Load more* pages to the first and keeps
  them with it. A refresh asks for the first page again and starts over.
- **Asked when needed:** a change's Commits and Changes are read when their
  section is first shown; a job's log on *Show log*; an issue's comments on
  *Show N comments*.

## Known behaviour and limits

- **GitHub's Branches tab scans every branch.** GitHub cannot order branches
  by last commit, so the whole list (names and dates, 100 a call, up to 2,000)
  is read and sorted by the deck, and only the page shown is asked for its
  ahead/behind, checks and pull request. The first page scans again; later
  pages reuse the scan for 5 minutes. Measured cold at about 5 s on a
  repository with ~450 branches.
- **GitLab's ahead/behind** has no bulk API. It is counted from the commits API
  for the active, non-default branches of the page shown, exactly up to 1,000
  (`999+`), and cached by the pair of SHAs. Stale branches get none.
- **Avatars on a self-managed GitLab** may be served only to a signed-in
  browser. The deck cannot fetch those, so they show initials, and a failed
  avatar is not asked for again in the session.
- **Counts can be missing.** GitLab leaves out `x-total` above 10,000 results,
  so that count is unknown: the state segment shows no number and *Load more*
  no total.
- **GitHub's Issues tab needs a repository**, and lists all of its issues.
  GitLab's is the issues assigned to you, across projects or in one. The
  GitHub client can also list the issues the viewer is part of across
  repositories; the panel does not offer it.
- **GitHub has no per-pull-request approval count.** Required approvals are a
  branch rule, so a row says Approved by GitHub's decision, or, without a
  review rule, by the reviews.
- **Across projects** the Pipelines tab reads the 10 most recently pushed
  repositories (GitHub) or active projects (GitLab), merged by time. A GitHub
  repository whose runs cannot be read is skipped.
- **Logs are tails.** At most 500 lines in the deck; the rest is *Full log ↗*.
  GitHub's runner housekeeping after the failed step ("Post job cleanup.") is
  cut.
- **Not supported yet:** writing anything (reviews, merges, re-runs), GitHub
  Enterprise Server in the form, a private CA or proxy, and a keyboard
  shortcut for these panels.

## Adding another forge

1. Server:
   - A client with the interface above, built on `createForgeTransport`,
     answering in `forge-types.ts`'s shapes and failing with `ForgeError`.
     `allowedOrigins` holds only the token's origins; `fetchAsset` passes an
     `allow` for the forge's image hosts.
   - A provider beside `githubProvider` in `integrations/forge.mjs`: `kind`,
     `label`, `createClient` wrapped in `withPhase`, `routes: forgeRead`,
     `parseInput`, `defaultName`. Register it in `providers.mjs`.
2. Web:
   - Add the kind to `ForgeKind` and its words to `forgeWords`.
   - A monochrome Simple Icons glyph in `rail-glyphs.tsx`, with its notice in
     `THIRD_PARTY_NOTICES.md`.
   - Its Panel, fields and token help in `ForgeIntegrations.tsx` and
     `ForgeTokenHelp.tsx`, and an entry in `INTEGRATIONS`.
   - Look at every `kind === "github"` / `"gitlab"` branch: in
     `tabAllowsAllProjects`, `changeSections`, `newChangeUrl`, `OpenOnForge`
     and `IssuesTab`.
3. Feature use: add the name to `ROUTE_PREFIX_FEATURES`
   (`src/server/feature-use.mjs`), `FEATURES` (`src/server/usage-day.mjs`) and
   `src/web/feature-use.ts`.
4. Scrubbing: add its token shape to `reports.mjs`, `report-errors.ts` and
   `process-command.mjs`.

## Testing

There is no mock forge. The client suites run against fixtures trimmed from
real answers, with every name invented.

- The suites in `src/web/__tests__/`:
  - `forge-http-2179`: the token only to allowed origins and dropped on a hop
    off them; every failure's kind and retry time; non-JSON 2xx; GraphQL
    errors with and without data; a log tail without colour codes, section
    markers or a half line; images.
  - `github-api-2179`: every method's request and mapping; the token not sent
    to a job log's blob host; ahead/behind direction; the branch sort and its
    paging; check, run and rollup states; reviewers and approval; cursors;
    a log without timestamps, group markers or housekeeping; older
    Enterprise fields; pasted references; image hosts.
  - `gitlab-api-2179`: each endpoint the panel copies and its mapping, REST
    rows completed by one GraphQL query; ahead/behind exact to 1,000 and for
    active branches only; reviewer states; `x-total` and its absence past
    10,000; an instance under a path; pasted URLs read without asking;
    images from the instance and Gravatar only.
  - `forge-routes-2179`: each read reaches its method with checked arguments;
    a malformed parameter is a 400 before the forge is asked; GET only; an
    unknown read 404; a forge failure's status and kind.
  - `forge-providers-2179`: both registered beside Jira; github.com always,
    gitlab.com unless self-managed, the address held to the core's rules; a
    blank token on edit keeps the saved one; `auth` while checking, `expired`
    on Test; default names.
  - `forge-panel-2179`: read paths and the failure envelope; kept, due and
    stale answers; every state's mark and word; `999+`; the branch and review
    splits; search and pasted references; the view read back field by field;
    focus when a page opens or closes.
  - `forge-lists-2179`: the words each row is made of, Create merge request,
    each list's states and empty sentences, and the four tabs and the picker
    drawn from kept answers: order, folds, no control inside a row's button,
    forge links opening outside the deck.
  - `forge-detail-2179`: references, the change's head and discussions, file
    and label words, jobs by stage and which start open, how a log tail
    grows, and the four pages drawn from kept answers (Close only on a wide
    window, comments behind a button, a gone item's sentence).
  - `forge-html-2179`: what survives the allow-list, links, images through
    the proxy or as links, task lists, titles, and the size bound.
  - `forge-token-help-2179`: read-only scopes, the token pages (on the typed
    GitLab instance, under its path), and links opening outside the deck.
- Sweep tests that list forge surfaces:
  - `canvas-keyboard`: `forge/RepoPicker.tsx` and `forge/DetailParts.tsx` in
    the `tabIndex={-1}` allow-list.
  - `control-edges`: `.fg-search input` at rest and under the pointer.
  - `canvas-motion`: the press on `.fg-row`, `.fg-fold`, `.fgl-repo-option`,
    `.fd-jump` (0.97) and `.fg-copy` (0.94); `.fgl-hit` exempt.
  - `control-appearance`: `.fgl-hit` exempt as a hit area.
  - `text-tiers`: the panel's sentences and its words on row fills.
  - `reports-1853` and `process-detail-807`: GitHub and GitLab token shapes
    scrubbed and redacted.
  - `integrations-routes-2178`: the read gate covers a GitLab read path.
- Browser QA runs in an isolated deck (`AGENTS_DECK_NO_LAN=1`, a scratch
  `HOME` and `CCDECK_HOME`, `--no-claude --no-codex`), never the owner's own.

## Verified 2026-10-19

- Linux, headless Chromium, an isolated deck, against a real GitHub account and
  a self-managed GitLab.
- Widths 1440, 390 and 320px, in Rider Black and light.
