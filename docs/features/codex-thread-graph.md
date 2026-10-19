# Codex child sessions

Codex threads keep their own session IDs, token totals, tools and lifecycle.
When the rollout header identifies a spawning parent, or a started subagent
activity identifies a child, ccdeck connects the two cards. Their common
canvas group controls layout, framing and dragging. Missing parents leave a
thread standalone until the parent appears. Conflicting ancestry, cycles and
links to Claude sessions are rejected.

Child cards say “child session” and use a recorded nickname or role when one
is available. A completed child remains completed when relationship metadata
is delivered again. An active descendant keeps its finished ancestors on the
board during automatic pruning. Claude session grouping is unchanged.

Validation covers rollout translation through the real watcher and reducer,
independent tool/token ownership, late parent arrival, duplicate metadata,
cycles, canvas groups, edges and pruning. Startup recovery is separate work.
