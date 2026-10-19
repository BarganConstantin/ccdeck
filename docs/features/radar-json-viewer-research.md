# Radar JSON viewer research

Checked 2026-10-19. Research snapshot; subsequent implementation is recorded below.

## Current problem

`src/web/components/JsonInspector.tsx` implements a local tree with native
`details` elements. Only the root opens initially. OTLP wraps useful fields in
`resourceLogs → scopeLogs → logRecords`, so the initial screen hides the content
behind several successive disclosures. There is no search or per-node copy.
Raw JSON already uses indentation and syntax colors.

The current implementation deliberately mounts only expanded children, renders
collections in batches of 50, and stops syntax highlighting above 200,000
characters. Its regression tests cover these protections. A replacement needs
equivalent responsiveness, not just a better-looking small example.

## Candidates

| Candidate | Documented capabilities | Fit for ccdeck |
| --- | --- | --- |
| `json-edit-react` | Read-only `JsonViewer`, search by key/value, configurable initial expansion, themes, keyboard controls, copy value/path. No external UI dependency. | Recommended first candidate: covers the requested exploration features in React. |
| `@uiw/react-json-view` | Configurable expansion by depth or callback, CSS variables, clipboard, customizable rendering and update highlighting. | Good display-focused alternative. No documented built-in search API found in the inspected README; search would need separate work. |
| `@textea/json-viewer` | Theming, clipboard, extensible value rendering and metadata previews. Requires Material UI and Emotion peers. | Extra UI framework is a poor fit for the existing custom theme system. |
| `vanilla-jsoneditor` | Tree, text and table modes, search, queries and large-document support; framework-independent API. | Worth considering for a complete JSON workspace. More integration and dependency surface than this inspector needs. |

Feature sources: [json-edit-react](https://github.com/CarlosNZ/json-edit-react#readme),
[uiw](https://github.com/uiwjs/react-json-view/tree/main/core#readme),
[Textea](https://github.com/TexteaInc/json-viewer#readme),
[JSONEditor](https://github.com/josdejong/svelte-jsoneditor#readme).
Fit assessments are project-specific judgments, not vendor claims.

## Published packages

Queried npm's first-party registry directly, including version, publication date,
license, dependencies and peer dependencies. These are registry `latest` tags at
the time of checking, not a promise about future releases.

| Package | Latest | Published | License | Compatibility / cost |
| --- | --- | --- | --- | --- |
| `json-edit-react` | `2.0.4` | 2026-10-03 | MIT | React >=18 peer; no declared runtime dependencies. |
| `@uiw/react-json-view` | `2.0.0-alpha.44` | 2026-10-06 | MIT | React/React DOM >=18 and Babel runtime peers; latest is a prerelease. |
| `@textea/json-viewer` | `4.0.1` | 2024-12-15 | MIT | React 17/18 peers plus MUI 6 and Emotion 11; additional runtime packages. |
| `vanilla-jsoneditor` | `3.13.0` | 2026-07-24 | ISC | Dependencies include Svelte, CodeMirror and query/validation packages. |

Registry sources:
[json-edit-react](https://registry.npmjs.org/json-edit-react),
[uiw](https://registry.npmjs.org/@uiw%2Freact-json-view),
[Textea](https://registry.npmjs.org/@textea%2Fjson-viewer),
[vanilla-jsoneditor](https://registry.npmjs.org/vanilla-jsoneditor).
No measured bundle-size comparison was performed. Main-branch documentation can
differ from published packages; confirm the pinned release API before integrating.

## Recommended experience

Start with `json-edit-react` in read-only mode, using ccdeck theme tokens. Keep
Tree / Raw JSON, with formatted raw text and full-document copy available.

The surrounding UI should provide:

- Search keys and values, retaining ancestor context for matching fields.
- Expand to a chosen depth and collapse back, with bounded rendering for large data.
- Copy an individual value, object or path.
- Readable wrapped multiline strings and distinct key/value colors.
- Initial expansion that follows small OTLP wrapper arrays down to useful record
  fields; leave bulky metadata and large collections collapsed.

Wrapper-aware expansion is ccdeck behavior, not something merely installing a
library guarantees. Do not rewrite or flatten the underlying JSON: the displayed
payload and copied raw document should preserve the captured data.

Before replacing the component, check the released API and prototype against
the existing large-array tests, a deeply nested export, long prompt strings,
keyboard navigation and narrow layouts. Search must also be checked on large
payloads. The library documents lazy mounting for collapsed branches; that does
not establish that an opened 10,000-item array is virtualized or paginated.
See the maintainer's [performance guidance](https://github.com/CarlosNZ/json-edit-react#performance-considerations).

## Implementation

Integrated pinned `json-edit-react@2.0.4` as a build-time dependency, bundled by
Vite. The package licence is included in `THIRD_PARTY_NOTICES.md`.

Radar Overview now puts captured prompt/response, tool, error, model, token,
cost, timing and success fields first when present. An explicit alias list
selects these fields and avoids duplicated aliases; unknown attributes and IDs
remain available in the complete record. False and zero remain visible.
Instrumentation, resource metadata and transport facts are disclosed separately.
Full record JSON mounts only when its disclosure is opened.

The JSON tree uses ccdeck theme variables, supports search by key/value, copying
values or paths, collapse/open-root controls and initial OTLP wrapper expansion.
Large collections use the existing 50-item paging renderer through a custom node;
they are not expanded into thousands of DOM nodes. Search in these collections
keeps original array indexes. Raw JSON stays complete and keeps its existing
200,000-character syntax-highlighting limit. Read-only library controls are made
keyboard reachable because the upstream component uses negative tab indexes.

Verification: 95 relevant tests, TypeScript and production build passed. Browser
QA uses isolated contexts and synthetic intercepted API responses; the owner's
stored preferences and capture history are preserved. Screenshots and interaction
checks are produced by the local temporary QA harness, not a separate reviewer.
Only the frontend was rebuilt; the already-running fixed backend stays on 4317.

## Content and project evidence refinement

The owner asked to see whether the actual prompt and working project are present.
The four retained real Claude test exports were inspected without printing their
content. Prompt aliases contained `[REDACTED]`; the test response was present;
no working-directory/project attribute was found. This is evidence about these
exports, not a claim that every Claude configuration behaves the same way.

Overview now explicitly distinguishes included, redacted and absent prompt and
response fields. Clear prompt aliases take precedence over a redacted duplicate.
Project/working-directory fields are surfaced from resource, record or metric
point attributes. If none is exported, an exact session-ID match may show the
local ccdeck working directory with an explicit local-origin label. A matching
collector address, arbitrary active session or conflicting session directories
never establish a project. Local conversations are not used to reconstruct
missing prompt text. The full request to the model is outside this collector view.

Logs containing prompts, responses, errors and tool/usage data appear before
background settings/plugin events; the latter remain in a lazy Other events
disclosure. Original JSON order and contents are preserved in the JSON view.
No telemetry flags or external collector configuration were changed.

Verification for this refinement: 81 relevant tests, TypeScript and build;
isolated Chromium at 1440/390/320px in Rider Black and White Contrast. Direct
in-thread visual review covered the evidence strip and project context. Browser
fixtures exercised exported directory fields; exact local matching and ambiguous
matches are covered by regression tests. The real retained export is separately
checked for redaction, missing project context and the background-event disclosure.
