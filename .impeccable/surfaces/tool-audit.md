# Tool activity

Established ccdeck report surface, code-led extension of Usage and General Settings.
Issue #2122. Owner decisions: global per-device Claude/Codex statistics, new data
only, concrete operations (git status vs git commit), variable arguments grouped;
30/60/90 day retention with size/clear in Settings; on-demand computation with
Radio-like opening and loading. No synchronization in this version.

Direction: calm, dense instrument report. Preserve theme catalog, modal shell,
SVG icon rail, tabular figures and monospaced operation names. Three filters,
compact coverage summary, searchable ranked table, inline operation detail.
At phone widths filters use two columns plus a full-width ranking control; table
scroll stays inside a labelled keyboard-accessible region. Settings uses an
inline destructive confirmation, with actual storage bytes and retained days.

Quality bar: a user finds frequent/slow operations without opening sessions;
unknown durations never become zeros; compound calls disclose shared timing;
clear/shorter retention cannot execute before confirmation. Loading is real
indeterminate work with Radio's 200ms entry, instant keyboard/reduced-motion.
Empty/error/incomplete data have actionable text. All nine themes and
1280/390/320px are required; focus returns to the Usage entry on Escape.

Limitations: commands are classified from observed inputs, not individual shell
execution telemetry. Wrapper/compound rows count containing calls and share
elapsed intervals/outcomes. No raw command arguments or outputs are retained.

Implemented invariants: header entry and modal actions use SVG icons, inheriting
current text/accent colors; avoid emoji-dependent shapes. Native select/date
controls inherit color scheme and fonts. Existing theme and monospace tokens
provide platform fallbacks. Numeric columns use tabular figures. The modal
fits 94vw, caps at940px, and keeps wide timing columns in an internal horizontal
scroll region. Pointer-coarse action buttons grow to36px. Reduced motion removes
entry/spinner animation; keyboard opening skips entry motion.

Verification: isolated Brave on macOS covered all nine themes at1280/390/320px,
including populated/details, loading, empty, error and storage confirmations.
Live Codex observations were also checked. Windows/Linux native execution is
unverified. Independent finish review remains outstanding: reviewer attempts
failed due service capacity after the requested loading captures were corrected.
No independent ship verdict is recorded. Documentation handoff also encountered
capacity; these implementation facts were recorded from source locally.
