# Integrations, and the Jira panel

Issue [#2178](https://github.com/BarganConstantin/ccdeck/issues/2178). GitHub and
GitLab ([#2179](https://github.com/BarganConstantin/ccdeck/issues/2179)) build on
the same core.

The deck can be connected to an issue tracker, so the work an agent is doing
sits next to the ticket it is for. It reads, and only reads: every request the
deck sends a tracker is a GET.

## What a person sees

- **Settings → Integrations**, between Sounds and Data. *Add integration* lists
  the providers; *Connect Jira* opens the form: which Jira (Server / Data
  Center, or Cloud), its address, the token (and, for Cloud, the account
  email), and an optional name. The form explains the token in place: where
  Jira makes one, what it can read, and that the deck keeps it on this machine
  and never shows it again. Connecting checks the token with Jira before
  anything is saved.
- **One control per connected kind on the left stripe**, under a divider below
  Accounts and Session list. On a phone it is under **More**. The shortcut is
  **I**, because J and K already move between agents. Until a connection
  exists there is no control and no shortcut.
- **The Jira panel**, a large modal (90vw × 90dvh) like Tool activity's.
  - **The header** is the host's: the Jira mark and name, which connection
    (a select once there are two or more), and Close.
  - **The toolbar:** the board, the board's project, when it was last read,
    and Refresh. Under them sit search (key or summary), *Only my issues*,
    *Hide done*, the board's own quick filters, and *Clear filters*.
  - **The backlog**, as Jira's Backlog page draws it:
    - The active sprints are open, and the future sprints and the backlog are
      closed. Closed sprints come on demand.
    - A kanban board gets To Do, In Progress and *Done in the last 14 days*,
      plus its backlog column when the board has one.
    - Each sprint header shows its dates and count, how many of yours are
      done, who is assigned, and its totals by status category: time, or story
      points when the board estimates in points.
  - **Each issue is drawn once.** A sub-task sits under its parent. When your
    sub-task's parent is not in the results, a muted context row ("not
    assigned to you") stands in for the parent.
  - **Rows show** the type and priority, the key (struck through when done),
    the summary, flagged, fix versions, the epic, the estimate and what is
    left, and the assignee.
  - **The issue**, beside the list from 900px and its own screen with a Back
    under that:
    - the path, key, status, flag, title, *Open in Jira*, *Copy key* and
      *Copy link*;
    - the fields;
    - the description, sub-tasks, links, attachments and the latest comments.
- **Freshness.** A board older than five minutes is read again when the panel
  opens or the board changes. Nothing polls. A failed refresh keeps what was
  drawn and says what went wrong over it.
- **Remembered per connection, in this browser:** the board, the open groups,
  *Only my issues*, *Hide done* and the board's quick filters. The detail's
  width is remembered per browser.

## Jira: what is supported

| | Jira Cloud | Jira Server / Data Center |
|---|---|---|
| Versions | current | 8.14 and newer (personal access tokens arrived in 8.14). Older servers are refused as *incompatible* when connecting. |
| Auth | Basic: account email + API token | `Authorization: Bearer <PAT>` |
| Core REST | v3. Search through `/rest/api/3/search/jql` with `nextPageToken`. | v2, with `startAt`/`maxResults` paging |
| Boards and sprints | Agile 1.0. Issue lists come from `/rest/software/1.0` where it is deployed. | Agile 1.0 |
| Descriptions and comments | `renderedFields` HTML | `renderedFields` HTML |

**Scoped Cloud tokens.** A token created *with scopes* is refused on the site
itself and answers only on `https://api.atlassian.com/ex/jira/<cloudId>`.
Validation tries the site first. When the refusal looks like a scoped token,
it finds the cloudId from the site's `/_edge/tenant_info` and tries the api
base. The connection then reads through it and says so in a warning.

**Durations** use the instance's own working day and week from
`/rest/api/*/configuration`, falling back to 8h days and 5-day weeks. A
duration reads "1w 3h 30m", as Jira writes it.

## Architecture

```
src/server/integrations/
  registry.mjs   provider contract, registerProvider, createRouter
  providers.mjs  the registrations (Jira)
  routes.mjs     /api/integrations: connections, provider reads, the asset route
  store.mjs      <deck home>/integrations/ (0700): records and secrets apart, 0600, atomic
  proxy.mjs      pinned transport: origins, manual redirects, signing; fetchImage
  errors.mjs     the typed error envelope
  cache.mjs      small TTL cache with shared in-flight loads
  jira.mjs       the Jira provider
src/web/integrations/
  types.ts registry.ts client.ts prefs.ts layout.ts
src/web/components/
  IntegrationsSection, IntegrationConnectionForm, IntegrationModal,
  IntegrationSplit, IntegrationAvatar,
  JiraPanel, JiraBacklog, JiraIssueDetail, JiraParts, JiraTokenHelp
src/web/jira-api.ts  jira-board.ts  jira-html.tsx  use-jira-board.ts
src/web/styles/integrations.css  src/web/styles/jira.css
```

### Routes

| Method and path | What it does |
|---|---|
| `GET /api/integrations` | providers and connections, never a secret (`tokenSaved` only) |
| `POST /api/integrations/connections` | create `{kind, name?, input}`. Validates with the tracker first; 201. |
| `PATCH /api/integrations/connections/<id>` | edit `{name?, input?}`. Re-validates when the address, the token or the options change; a blank token keeps the saved one. |
| `POST /api/integrations/connections/<id>/test` | ask the tracker again with the saved token |
| `DELETE /api/integrations/connections/<id>` | the connection and its token |
| `GET /api/integrations/<kind>/<id>/<subpath>` | the provider's own reads. GET and HEAD only; anything else is 405. |
| `GET /api/integrations/<kind>/<id>/asset?url=` | an image the tracker serves (below) |

Jira's reads:
- `boards`
- `board/:id`: the overview, its sprints, estimation and quick filters
- `board/:id/closed-sprints`
- `board/:id/issues`: by sprint, backlog or kanban column, paged
- `issue/:key`
- `issue/:key/subtasks`

Every path under `/api/integrations/` is a **guarded read**
(`GUARDED_READ_PREFIXES` in `request-gates.mjs`). It answers only the deck's
own page (same origin, Referer fallback) or the deck token, and mutations sit
behind the usual mutation gate. A provider's new route is covered from the
moment it exists.

### Errors

Every failure is `{ok:false, error:{kind, message, status?, retryAfter?}}`:

| kind | HTTP |
|---|---|
| `auth`, `expired` | 401 |
| `permission` | 403 |
| `not-found` | 404 |
| `rate-limit` | 429, with `retryAfter` |
| `invalid` | 400 |
| `unreachable`, `tls`, `incompatible`, `upstream` | 502 |

`auth` means the token was refused while connecting; `expired` means a saved
token stopped working. The panel turns each kind into a sentence. `expired`
offers **Reconnect**, which opens Settings at that connection's edit form,
focused on the token.

### The asset route

Avatars, type icons and images in descriptions are fetched by the deck, never
by the page, because they need the token. `client.fetchAsset(url)`:

- **Checks hosts on every hop.** Each URL, and each redirect hop (redirects are
  followed by hand), must be one of the connection's token origins, or an
  https image host the provider allows.
- **Refuses private addresses.** Loopback, private, link-local and intranet
  names are refused unless they are the connection's own origin.
- **Signs only the token origins.** The token is sent to the connection's own
  origins and nowhere else:
  - Data Center: the instance.
  - Cloud: the site and api.atlassian.com.
  - Unsigned: Atlassian's public avatar hosts and Gravatar.
- **Serves raster images only.** PNG, JPEG, GIF and WebP, checked against the
  magic bytes. SVG is never served.
- **Caps the size** at 8 MB, counted while streaming.

The route answers with these headers:

- `content-type`
- `x-content-type-options: nosniff`
- `content-security-policy: default-src 'none'; sandbox`
- `cache-control: private, max-age=300`
- `cross-origin-resource-policy: same-origin`

**Any failure is an empty 404, or an empty 403 for a host it will not read.**
An image failure never touches the connection: a 401 on an avatar is not an
expired token. A provider without `fetchAsset` gets a generic read from its
token origins only, unsigned.

Jira serves its priority icons and many type icons as SVG. The panel draws its
own glyphs for those: bug, story, task, sub-task and epic, and the five
priority levels, including Blocker/Critical/Major/Minor/Trivial. Avatars fall
back to initials.

### An issue's HTML

Jira's rendered HTML is rebuilt into React elements from an allowlist
(`jira-html.tsx`). There is no `innerHTML` anywhere in `src/web`.

- Script, style, frames, forms and SVG are dropped with their content.
- Every handler and `style` attribute is dropped.
- A link is kept only when it is http(s) with no credentials, and opens in a
  new tab with no referrer.
- Images load through the asset route only. An image that cannot load is drawn
  as a link, and an emoticon as its text.
- Headings step under the detail's own.
- Jira's panels and code blocks are mapped to the panel's classes.
- Depth and node count are bounded.

## Security

- **The token stays on the machine.** It never reaches a log, the event log,
  reports, feedback, the LAN or prefs. The page only ever gets `tokenSaved`.
- **Storage:** `<deck home>/integrations/` is a 0700 directory. Connection
  records and secrets are separate 0600 files, written atomically. Removing a
  connection deletes its secret.
- **Report scrubbing:** `reports.mjs` scrubs `Bearer`/`Basic` values and
  Atlassian `ATATT…` tokens, as a belt to the braces above.
- **No URL-fetching route:** there is no generic "fetch any URL with the token"
  route. The asset route signs only for the connection's own origins.
- **TLS:** no certificate-ignoring option. A private CA is a follow-up.
- **Paired decks get nothing:** nothing is shared with paired decks, and no LAN
  path is touched.

## Adding a provider

1. Server:
   - Write `{kind, label, createClient(conn, secret), routes(client, method,
     subpath, searchParams, req)}`, with `parseInput` and `defaultName` if the
     defaults do not fit.
   - Register it in `providers.mjs`.
   - The client exposes `allowedOrigins` (token origins only), `validate()`
     and, ideally, `fetchAsset()`.
   - `proxy.mjs` has the pinned transport (`createProxy`) and `fetchImage`.
2. Web:
   - Add an `IntegrationWebDef` to `INTEGRATIONS` in
     `src/web/integrations/registry.ts`: label, `Glyph`, `shortcut`, `fields`,
     `tokenHelp` and `Panel`.
   - The Panel gets `{connection, connections, api, assetUrl, prefs, narrow,
     onReconnect}`.
   - Compose it with `IntegrationSplit` for a list and a detail.
3. Feature use: add the name to these three lists:
   - `ROUTE_PREFIX_FEATURES` in `src/server/feature-use.mjs`
   - `FEATURES` in `src/server/usage-day.mjs`
   - `src/web/feature-use.ts`

## Testing

- `scripts/mock-jira.mjs` is a local Jira of either flavour, with a board,
  sprints, kanban, sub-tasks, rendered HTML, PNG and SVG icons, and failure
  modes (`401 403 429 500 slow`):
  `node scripts/mock-jira.mjs --flavor server|cloud [--port] [--api-port] [--version]`.
  For a Cloud mock, set `CCDECK_JIRA_API_ORIGIN` to the mock's api origin so
  scoped tokens are tried there.
- The suites:
  - `integrations-transport-2178`: proxy, fetchImage, errors, scrub, signing,
    the LAN boundary.
  - `integrations-routes-2178`: a booted deck against three mock Jiras. It
    covers the gates, the store modes, every read, asset refusals, expired vs
    image failures, rate limits, old servers and scoped tokens, and checks
    that no token reaches the logs.
  - `mock-jira-server`: the mock itself.
  - `jira-panel-2178`: grouping, dedup and context rows, filters, totals,
    durations, glyphs, the sanitiser, Settings search, the rail.
- Browser QA runs in an isolated deck (`AGENTS_DECK_NO_LAN=1`, a scratch
  `CCDECK_HOME`, ports 4740–4760) against the mocks.

## Verified 2026-10-19

- Linux, headless Chromium, with an isolated deck on 4745 and the mock Server
  (9.0.0) and Cloud.
- Widths 1280, 900, 390 and 320; Rider Black, light, black-contrast and
  white-contrast; forced colours with reduced motion.
- The flows:
  - connect through the form, and through the API;
  - the rail control appears; I opens the panel;
  - board and kanban switching, search and filters;
  - the detail beside the list, and as its own screen with Back;
  - Escape order: search, then the detail, then the modal; focus returns to
    the rail control or More;
  - the Cloud connection switch;
  - 401, 403, 429 and 500 states, Reconnect into the edit form, and Test
    recovering;
  - no page-level horizontal overflow.
- `jira.sapec.md` (Jira 9.0.0) answered `serverInfo`. The PAT supplied for the
  read-only smoke test was refused by Jira itself: `401`,
  `X-AUSERNAME: anonymous`, the same with plain curl. The deck reported *auth*
  and saved nothing. The token reached no log, answer or file, and the scratch
  home was deleted.

## Limitations and follow-ups

- **Not supported yet:**
  - A private CA or a proxy for self-hosted Jira (no TLS bypass by design).
  - Write actions: transitions, comments, assignment, logging work.
- **SVG icons** are replaced by drawn glyphs, so a custom type keeps a neutral
  tile.
- **A failed read leaves no mark in Settings.** The panel says so, and Test
  confirms it.
- **The board is never pushed:** freshness is "read on open when older than
  five minutes" plus Refresh.
- **Comments:** the latest page is shown; older ones link to Jira.
