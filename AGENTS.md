# ccdeck agent instructions

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
