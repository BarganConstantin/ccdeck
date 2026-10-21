# Radio country flags

Unmodified 4:3 SVG flags from [flag-icons](https://github.com/lipis/flag-icons),
version 7.5.0 (npm package `flag-icons@7.5.0`), under the included MIT licence.
Only two-letter country/territory filenames are included. Radio uses a local
asset lookup and falls back to its radio icon for unknown country codes.

Vite emits these as separate files so the player and visible station rows load
only the flags they need, without downloading a remote image or an emoji font.

To update, extract `package/flags/4x3/[a-z][a-z].svg` and `package/LICENSE` from
the pinned npm tarball and record the new version here and in the notices.
