// The files a Codex `apply_patch` document names.
//
// Codex edits files with one tool and one format: a `*** Begin Patch …
// *** End Patch` document whose file sections each open with a header line —
//
//   *** Add File: <path>
//   *** Update File: <path>      (optionally followed by `*** Move to: <path>`)
//   *** Delete File: <path>
//
// Every other line belongs to a hunk and starts with `@@`, `+`, `-`, a space,
// or the `*** End of File` marker. So a header is a line that STARTS with one
// of the four markers; `+*** Update File: x` is content being added to a file
// and names nothing. Paths are returned as written — relative to the session's
// folder or absolute — and resolved by the caller, which knows that folder.
//
// Pure: no file is read, nothing is resolved, and anything that is not a
// string answers an empty list.

const HEADER = /^\*\*\* (Add File|Update File|Delete File|Move to): ?(.*)$/;
const OPS = { "Add File": "add", "Update File": "update", "Delete File": "delete" };

/**
 * The file sections of one patch document, in order.
 *
 * `{ op: "add" | "update" | "delete", path }` per section, and a rename as the
 * update of its old path followed by `{ op: "move", path: <new>, from: <old> }`
 * — both ends are files the patch touched, and git reports both.
 *
 * @param {unknown} text the patch document
 * @returns {{ op: string, path: string, from?: string }[]}
 */
export function patchPaths(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  let lastUpdate = null;
  for (const raw of text.split("\n")) {
    const m = HEADER.exec(raw.replace(/\r$/, ""));
    // `*** Move to:` is only ever the line straight after its Update header.
    if (!m) { lastUpdate = null; continue; }
    const path = m[2].trim();
    if (!path) continue;
    if (m[1] === "Move to") {
      // A move belongs to the Update File header right above it; one without
      // that header is not a shape Codex writes, and is read as an add.
      if (lastUpdate !== null) out.push({ op: "move", path, from: lastUpdate });
      else out.push({ op: "add", path });
      lastUpdate = null;
      continue;
    }
    const op = OPS[m[1]];
    out.push({ op, path });
    lastUpdate = op === "update" ? path : null;
  }
  return out;
}
