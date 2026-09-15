// A tool call, the way a person reads one (#816).
//
// The dialog that shows one call in full printed its input and response with
// JSON.stringify(v, null, 2). An Edit's old_string and new_string became single
// lines full of literal \n and \", and an Edit's response carried the whole
// file it edited: one call measured 4,492 characters of input and 94,877 of
// response, in a dialog with no way to copy either. This turns the calls the
// deck sees most into what they are — a change as a diff, a command and its
// output, a file and its text — and everything else into its values with real
// newlines. The raw payload is still one press away, behind the copy buttons.

export type Tone = "del" | "add" | "ctx";

export interface Line { text: string; tone?: Tone }

export interface Block {
  /** One word for what this is: "file", "command", "output". */
  label?: string;
  /** The text as a person reads it: real newlines, no quoting, no escapes. */
  text: string;
  /** A diff's lines, each with its side. Absent for plain text. */
  lines?: Line[];
  /** A single value (a path, a range) drawn on one line rather than as a block. */
  inline?: boolean;
  /** Text that reports a failure: a command's stderr. */
  err?: boolean;
}

export interface ToolView { input: Block[]; response: Block[] }

/** A block longer than this opens behind "show all". Lines and characters
 *  both, because a 95,000-character response can be one line. */
export const CLIP_LINES = 60;
export const CLIP_CHARS = 6_000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Any value, readable. A string is itself. An object is `key: value` lines, a
 * multi-line string opens under its key with its own newlines, and nesting is
 * indent. Everything JSON.stringify escapes, this prints.
 */
export function readable(v: unknown, indent = ""): string {
  if (v === undefined || v === null) return "(none)";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return String(v);
  const list = Array.isArray(v);
  const entries: Array<[string, unknown]> = list ? v.map((x, i) => [String(i), x]) : Object.entries(v as Rec);
  if (entries.length === 0) return list ? "[]" : "{}";
  const out: string[] = [];
  for (const [k, x] of entries) {
    const key = list ? `${indent}-` : `${indent}${k}:`;
    if (typeof x === "string" && x.includes("\n")) {
      out.push(key);
      for (const line of x.split("\n")) out.push(`${indent}  ${line}`);
    } else if (x !== null && typeof x === "object") {
      const inner = readable(x, `${indent}  `);
      if (inner === "[]" || inner === "{}") out.push(`${key} ${inner}`);
      else out.push(key, inner);
    } else {
      out.push(`${key} ${x === undefined ? "(none)" : String(x)}`);
    }
  }
  return out.join("\n");
}

/** A block's lines, whether it came as a diff or as text. */
export function linesOf(block: Block): Line[] {
  return block.lines ?? block.text.split("\n").map(text => ({ text }));
}

/** The lines a block shows before "show all", and whether any were held back.
 *  A line that alone runs past the character budget is cut with an ellipsis. */
export function clip(lines: Line[], open: boolean): { shown: Line[]; cut: boolean } {
  if (open) return { shown: lines, cut: false };
  const shown: Line[] = [];
  let chars = 0;
  for (const line of lines) {
    if (shown.length === CLIP_LINES) return { shown, cut: true };
    const room = CLIP_CHARS - chars;
    if (line.text.length > room) {
      shown.push({ ...line, text: `${line.text.slice(0, Math.max(room, 0))}…` });
      return { shown, cut: true };
    }
    shown.push(line);
    chars += line.text.length + 1;
  }
  return { shown, cut: false };
}

const text = (label: string | undefined, t: string, err = false): Block =>
  ({ ...(label ? { label } : {}), text: t, ...(err ? { err: true } : {}) });
const inline = (label: string, t: string): Block => ({ label, text: t, inline: true });
const diff = (label: string, lines: Line[]): Block => ({ label, text: lines.map(l => l.text).join("\n"), lines });

/** Before and after, each line marked with its side in a character as well as
 *  a colour, so the change reads without the colour. */
function changeLines(before: string, after: string): Line[] {
  return [
    ...before.split("\n").map(t => ({ text: `- ${t}`, tone: "del" as const })),
    ...after.split("\n").map(t => ({ text: `+ ${t}`, tone: "add" as const })),
  ];
}

/** Claude Code's `structuredPatch`: the hunks that were applied. */
function patchLines(patch: unknown): Line[] | null {
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const out: Line[] = [];
  for (const h of patch) {
    if (!isRec(h) || !Array.isArray(h.lines)) return null;
    out.push({ text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, tone: "ctx" });
    for (const raw of h.lines) {
      const t = String(raw);
      out.push(t.startsWith("+") ? { text: t, tone: "add" } : t.startsWith("-") ? { text: t, tone: "del" } : { text: t });
    }
  }
  return out;
}

/** What an Edit, MultiEdit or Write said back: the hunks that landed, and
 *  never the whole file it edited — `originalFile` was the 94,877 characters. */
function writeResponse(response: unknown): Block[] {
  if (typeof response === "string") return [text(undefined, response)];
  if (!isRec(response)) return [text(undefined, readable(response))];
  const out: Block[] = [];
  const kind = str(response.type);
  if (kind === "create") out.push(inline("result", "created the file"));
  const patch = patchLines(response.structuredPatch);
  if (patch) out.push(diff("applied", patch));
  if (response.userModified === true) out.push(inline("note", "the user changed it before it was applied"));
  return out.length ? out : [inline("result", kind === "update" ? "updated the file" : "done")];
}

function rangeOf(i: Rec): string | null {
  const offset = typeof i.offset === "number" ? i.offset : null;
  const limit = typeof i.limit === "number" ? i.limit : null;
  if (offset == null && limit == null) return null;
  const from = offset ?? 1;
  return limit != null ? `${from}–${from + limit - 1}` : `from ${from}`;
}

function readResponse(response: unknown): Block[] {
  if (typeof response === "string") return [text(undefined, response)];
  const file = isRec(response) && isRec(response.file) ? response.file : null;
  const content = str(file?.content);
  if (file && content != null) {
    const out: Block[] = [];
    const shown = Number(file.numLines), total = Number(file.totalLines), start = Number(file.startLine);
    if (Number.isFinite(shown) && Number.isFinite(total) && total > 0) {
      out.push(inline("lines", shown >= total ? `all ${total}`
        : Number.isFinite(start) ? `${start}–${start + shown - 1} of ${total}` : `${shown} of ${total}`));
    }
    out.push(text("content", content));
    return out;
  }
  // An image, a PDF or a notebook: said as what it was, not dumped.
  const kind = isRec(response) ? str(response.type) : null;
  if (kind && kind !== "text") return [inline("result", `${/^[aeiou]/i.test(kind) ? "an" : "a"} ${kind} file`)];
  return [text(undefined, readable(response))];
}

function bashResponse(response: unknown): Block[] {
  if (typeof response === "string") return [text("output", response)];
  if (!isRec(response)) return [text(undefined, readable(response))];
  const stdout = str(response.stdout), stderr = str(response.stderr);
  if (stdout == null && stderr == null) return [text(undefined, readable(response))];
  const out: Block[] = [];
  if (stdout) out.push(text("output", stdout.replace(/\n$/, "")));
  if (stderr) out.push(text("errors", stderr.replace(/\n$/, ""), true));
  if (response.interrupted === true) out.push(inline("note", "interrupted before it finished"));
  return out.length ? out : [inline("output", "none")];
}

/** One call's input and response, as blocks a person reads. */
export function toolView(name: string, input: unknown, response: unknown): ToolView {
  const i = isRec(input) ? input : null;
  if (i && (name === "Edit" || name === "MultiEdit")) {
    const file = str(i.file_path);
    const edits = (name === "MultiEdit" ? (Array.isArray(i.edits) ? i.edits : []) : [i])
      .filter(isRec)
      .filter(e => str(e.old_string) != null && str(e.new_string) != null);
    if (file && edits.length) {
      const blocks: Block[] = [inline("file", file)];
      edits.forEach((e, n) => {
        const every = e.replace_all === true ? ", every occurrence" : "";
        blocks.push(diff(edits.length > 1 ? `change ${n + 1}${every}` : `change${every}`,
          changeLines(e.old_string as string, e.new_string as string)));
      });
      return { input: blocks, response: writeResponse(response) };
    }
  }
  if (i && name === "Write") {
    const file = str(i.file_path), content = str(i.content);
    if (file && content != null) return { input: [inline("file", file), text("content", content)], response: writeResponse(response) };
  }
  if (i && name === "Read") {
    const file = str(i.file_path);
    if (file) {
      const range = rangeOf(i);
      return { input: range ? [inline("file", file), inline("lines", range)] : [inline("file", file)], response: readResponse(response) };
    }
  }
  if (i && name === "Bash") {
    const command = str(i.command);
    if (command != null) {
      const why = str(i.description);
      return { input: why ? [text("command", command), inline("why", why)] : [text("command", command)], response: bashResponse(response) };
    }
  }
  return { input: [text(undefined, readable(input))], response: [text(undefined, readable(response))] };
}

/**
 * What a copy button puts on the clipboard: the thing itself where a call has
 * one — a command, its output, a file's text — and otherwise the raw payload
 * as pretty-printed JSON, which is what somebody pastes into an issue.
 */
export function copyOf(name: string, side: "input" | "response", v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (isRec(v)) {
    if (name === "Bash" && side === "input" && typeof v.command === "string") return v.command;
    if (name === "Bash" && side === "response" && (typeof v.stdout === "string" || typeof v.stderr === "string")) {
      return [v.stdout, v.stderr].filter((x): x is string => typeof x === "string" && x !== "").join("\n");
    }
    if (name === "Read" && side === "response" && isRec(v.file) && typeof v.file.content === "string") return v.file.content;
  }
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
}
