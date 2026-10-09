# ccdeck agent instructions

## Working context

ccdeck is a local dashboard for Claude Code and Codex sessions. The web UI uses
React, TypeScript and React Flow; the local server uses Node.js ES modules.
This repository is separate from VacationCRM / `vcrm-core`, even when the agent
starts its session there. Locate the ccdeck checkout before making changes.

For continuation of the owner's UI and telemetry work, read
[`docs/agent-context.md`](docs/agent-context.md). It records the current worktree,
branch workflow, decisions and verification pitfalls. Recheck its dated runtime
details before using them; update it when those details change.

## Owner preferences and delivery

- Communicate in concise Romanian unless the owner switches language. Explain
  results plainly and keep progress updates useful.
- Work autonomously within the requested scope. Finish implementation, local
  execution and verification; a proposal alone does not complete a change.
- Make regular, focused commits and push completed changes to `development` when
  authorized. Inspect branch, worktree and remote state first, and preserve
  unrelated work. Merge `main` into `development` when requested; this is not
  permission to publish development changes to `main`.
- The unfinished Git View and separate CLI work are protected from unrelated UI
  edits until the owner explicitly requests work on those features.
- Aim for the clarity and comfort of Rider / VS Code: compact icon rails with
  discoverable labels, readable contrast, consistent panel widths and spacing,
  clear statuses, and useful information rather than technical clutter.
- Rider Black is the default for a fresh installation. Preserve a user's valid
  stored theme choice. New palettes belong in the JSON theme catalog; consult
  [`src/web/themes/README.md`](src/web/themes/README.md) when editing themes.

## Verification and local running

Use `package.json` for build, typecheck and test commands, and `README.md` for
startup flags. In this environment Node 22 is the verified test runtime; a Node
26 streaming-test failure has previously reproduced on an unchanged baseline.
Investigate failures before attributing them to your change.

- Reproduce a reported bug before fixing it; add a regression test when the
  behavior warrants one. Run relevant tests, typecheck and build after editing.
- For visual or interaction changes, also run the app and inspect it in a real
  browser. Brave and Chrome DevTools MCP are authorized for this project. Test
  the affected interactions at desktop and narrow widths, including 390 and
  320px when layout changes, and check relevant light/dark themes.
- Test moving elements over time and after resizing, not just their initial
  position. Check control interactions and keyboard behavior as well as geometry.
- The locally served release UI comes from `dist/web`; rebuild and refresh the
  browser to test it. A frontend-only build does not require restarting the
  server. Confirm the serving process belongs to the intended worktree before
  stopping or replacing it. Use isolated browser contexts for QA and preserve
  the owner's personal tabs and preferences.
- Report exactly what was verified, any remaining limitation, the commit/push
  result and the local URL when relevant. Passing tests alone do not establish
  that an external telemetry stream is being captured.

## Code navigation

- Canvas composition and controls: `src/web/components/BoardFlow.tsx`,
  `CanvasControls.tsx`, `src/web/styles/canvas.css`.
- Character / Claude FM: `ClaudeFm.tsx`, `FmSprite.tsx`,
  `src/web/use-fm-scene.ts`, `src/web/claude-fm.ts`.
- Side panels: `EdgeRails.tsx`, `AccountsPanel.tsx`, `SessionList.tsx`.
- Telemetry Radar: `TrafficRadar.tsx`, `TelemetryCapture.tsx`, `TelemetryFile.tsx`
  under `src/web/components/`; hooks and inspection logic under `src/web/`;
  `traffic-radar*.mjs` under `src/server/`.
- Themes: `src/web/themes/`, `src/web/theme.ts`, `scripts/theme-compiler.mjs`.
- Web and many server regression tests: `src/web/__tests__/`.

Paths without a directory above refer to `src/web/components/`. Inspect existing
code and nearby tests before extending a surface.

## Product release notes

When preparing release notes for ccdeck, write them as concise product communication for the person using the app.

- Start from the actual release diff, merged issues, and user-visible behavior. Ask: **what would a user notice?**
- Select only the meaningful changes. Do not turn the notes into a commit log, issue list, PR dump, or implementation summary.
- Describe the result in user language: what is new, what got easier, what was fixed, or what changed in behavior.
- Keep the tone polished, calm, and direct. Prefer a few strong lines over a long exhaustive changelog.
- Mention implementation details only when a user needs them to understand a behavior change, migration, compatibility issue, or action they must take.
- Invisible refactors, internal cleanup, test changes, and fixes that only preserve expected behavior usually do not deserve a product note.
- Emoji are welcome when they help scanning, but keep them restrained and meaningful.

For larger releases, prefer this shape when the content supports it:

```md
### ccdeck X.Y.Z

**What’s new**

- 🎵 **Claude FM** — choose your station and control the volume directly from Appearance.
- 🌐 **Local Network improvements** — device discovery, pairing, and connection health are more reliable.
- 🤖 **Better agent tracking** — Claude Code and Codex sessions report waiting and blocked states more clearly.

**Improvements**

- ✨ Cleaner account controls, board interactions, and accessibility details.

**Fixes**

Fixed several edge cases around project paths, stale agents, notifications, desktop startup, and session cleanup.

**Under the hood**

Improved reliability and security across the local server and desktop app.
```

Small releases do not need every heading. Two or three clear lines are better than empty sections.

`release-notes.json` is the source of truth for release-note data, version handling, formatting constraints, and the `//nothing-to-say` convention. Follow its embedded authoring rules exactly when editing that file.

## Brand

Every logo and icon in this repo is a file copied unchanged from the ccdeck brand kit. `assets/brand/README.md` says which file serves which slot, how a new kit is copied in (`node assets/brand/kit.mjs <kit-dir>`) and what has to be regenerated afterwards; `assets/brand/kit.json` records the kit version and every copy. The name and the brand files are not under the AGPL: see LICENSING.md, "Name and logo".

- Never recreate the logo: no CSS, canvas, hand-written SVG, emoji or text redraw of it.
- No other gradients: the mark's own gradients live only inside the kit's artwork.
- One kit file per context; never shrink the app icon for the tray, and use the `*-small-optical` masters up to 32px.
- Status is an overlay on an unchanged mark, never a recolouring: the tab wears the kit's own state files.
- The name is `ccdeck`, lowercase, in text and alt text; never copy the kit's own text files.

**Brand (desktop):** the app icon and tray images come only from `desktop/brand/` — read `desktop/brand/README.md` (rules, which file serves which slot, how to take a new kit); never draw the mark in code, never use the app icon for the tray.
