// What one tool call means for git: the files it edited and the shell commands
// it ran — read off the call's own input, for Claude and Codex alike.
//
// THE EDIT TOOLS. Claude edits through four tools, each naming its file in its
// input: Edit, Write and MultiEdit as `file_path`, NotebookEdit as
// `notebook_path`. Codex edits through `apply_patch`, whose input is a patch
// document (agent-git-patch.mjs reads its headers) — either as its own call, or
// from inside an `exec` script that hands a patch to `tools.apply_patch(…)`.
// Files changed any other way (a shell redirect, `sed -i`, a formatter, a
// generated diff piped into apply_patch) are not seen here, by design: those
// stay unmarked rather than guessed at.
//
// THE SHELL TOOLS. Claude's Bash and PowerShell carry `command`. Codex has had
// several spellings: `exec_command` with `{ cmd, workdir }`, `shell` with an
// argv array, `shell_command` with a string, and since 0.147 `exec`, whose
// input is a small JavaScript program calling `tools.exec_command({ cmd })` —
// the command is dug out of the program, the same way the client's
// codexScriptCommand does it for the canvas.
//
// Pure. Paths are resolved lexically against the folder the event names, with
// the rules of the platform that folder belongs to (a `C:\` folder resolves
// with Windows rules on any host), and never touched on disk.
import { posix, win32 } from "node:path";
import { patchPaths } from "./agent-git-patch.mjs";

const CLAUDE_EDIT_FIELD = { Edit: "file_path", Write: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };
const CLAUDE_SHELL = new Set(["Bash", "PowerShell"]);
const CODEX_STRING_SHELL = new Set(["exec_command", "shell_command"]);

const WINDOWS_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** The path flavour a folder or file path belongs to. */
function flavourOf(...paths) {
  return paths.some(p => typeof p === "string" && WINDOWS_ABS.test(p)) ? win32 : posix;
}

/**
 * `path` made absolute against `cwd`, or null when it cannot be without a
 * guess: a relative path with no absolute folder to resolve it in.
 */
export function resolveIn(cwd, path) {
  if (typeof path !== "string" || !path.trim()) return null;
  const p = flavourOf(path, cwd);
  if (p.isAbsolute(path) && (p === win32 ? WINDOWS_ABS.test(path) : true)) return p.normalize(path);
  if (typeof cwd !== "string" || !p.isAbsolute(cwd)) return null;
  return p.resolve(cwd, path);
}

/** The real command out of a Codex `shell` argv: the script after `-c` / `-lc`
 *  / `-Command` / `/c` for a shell wrapper, or the argv joined. */
function argvCommand(argv) {
  if (!Array.isArray(argv) || !argv.length || !argv.every(a => typeof a === "string")) return null;
  if (/(?:^|[\\/])(?:ba|z|da|k)?sh(?:\.exe)?$|(?:^|[\\/])(?:pwsh|powershell|cmd)(?:\.exe)?$/i.test(argv[0])) {
    const flag = argv.findIndex((a, i) => i > 0 && /^(?:-[a-z]*c|-command|\/c)$/i.test(a));
    if (flag > 0 && flag + 1 < argv.length) return argv[flag + 1];
  }
  return argv.map(a => (/[\s"'\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ");
}

// ─── Codex `exec` scripts ──────────────────────────────────────────────────

const JS_ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };

/** A JavaScript string literal's body with its escapes undone. */
function unescapeJs(body) {
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/g, (_, e) => {
    if (e[0] === "u" && e.length > 1) return String.fromCodePoint(parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === "x" && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === "\n" || e === "\r\n") return "";
    return JS_ESCAPES[e] ?? e;
  });
}

/** Every string literal in a script, unescaped, in order. Comments are skipped
 *  so a quote inside one cannot open a phantom string. */
function stringLiterals(script) {
  const out = [];
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (c === "/" && script[i + 1] === "/") { const nl = script.indexOf("\n", i); i = nl < 0 ? script.length : nl; continue; }
    if (c === "/" && script[i + 1] === "*") { const end = script.indexOf("*/", i + 2); i = end < 0 ? script.length : end + 1; continue; }
    if (c !== '"' && c !== "'" && c !== "`") continue;
    let j = i + 1;
    let body = "";
    for (; j < script.length; j++) {
      const d = script[j];
      if (d === "\\") { body += d + (script[j + 1] ?? ""); j++; continue; }
      if (d === c) break;
      if (c !== "`" && d === "\n") break; // an unterminated ordinary string
      body += d;
    }
    if (script[j] === c) out.push(unescapeJs(body));
    i = j;
  }
  return out;
}

const STRING_LITERAL = String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\`(?:\\.|[^\`\\])*\`)`;
const EXEC_COMMAND_ARGS = /\btools\.exec_command\s*\(\s*\{([^{}]*)\}/g;
const keyed = key => new RegExp(String.raw`(?:^|[,{\s])["']?${key}["']?\s*:\s*${STRING_LITERAL}`);
const CMD_KEY = keyed("cmd");
const WORKDIR_KEY = keyed("workdir");
const APPLY_PATCH_CALL = /\btools\.apply_patch\s*\(/;

/**
 * The shell commands and the patches inside one Codex `exec` script.
 *
 * `commands`: every `tools.exec_command({ cmd, workdir })` call, in order, with
 * `workdir` null when the call names none. The scan stays inside the call's own
 * object literal, so a `cmd` belonging to a nested object is not this call's.
 *
 * `patches`: the files of every patch document written into the script as a
 * string literal — read only when the script actually calls
 * `tools.apply_patch(…)`, since a patch-shaped string that is never applied is
 * just text. A patch the script computes (a `git diff` output handed to
 * apply_patch) names no file here: a known blind spot.
 *
 * @param {unknown} script
 * @returns {{ commands: { command: string, workdir: string | null }[], patches: { op: string, path: string, from?: string }[][] }}
 */
export function codexScriptCalls(script) {
  const out = { commands: [], patches: [] };
  if (typeof script !== "string" || !/\btools\.[A-Za-z_$][\w$]*\s*\(/.test(script)) return out;
  for (const m of script.matchAll(EXEC_COMMAND_ARGS)) {
    const cmd = CMD_KEY.exec(m[1]);
    if (!cmd) continue;
    const command = unescapeJs(cmd[1].slice(1, -1));
    if (!command.trim()) continue;
    const wd = WORKDIR_KEY.exec(m[1]);
    out.commands.push({ command, workdir: wd ? unescapeJs(wd[1].slice(1, -1)) : null });
  }
  if (APPLY_PATCH_CALL.test(script)) {
    for (const literal of stringLiterals(script)) {
      const files = patchPaths(literal);
      if (files.length) out.patches.push(files);
    }
  }
  return out;
}

// ─── One call ──────────────────────────────────────────────────────────────

/** The absolute paths a patch's sections name — both ends of a move. */
function patchEdits(files, cwd) {
  const out = [];
  for (const f of files) {
    for (const p of f.op === "move" ? [f.from, f.path] : [f.path]) {
      const abs = resolveIn(cwd, p);
      if (abs && !out.includes(abs)) out.push(abs);
    }
  }
  return out;
}

/** A command's folder: the call's own `workdir` (resolved against the session's
 *  folder when relative), else the session's folder. */
function commandCwd(workdir, cwd) {
  return (typeof workdir === "string" && resolveIn(cwd, workdir)) || (typeof cwd === "string" && cwd ? cwd : null);
}

/**
 * What one tool call edited and ran.
 *
 * @param {unknown} toolName the call's tool name
 * @param {unknown} toolInput the call's input, as the event carries it
 * @param {unknown} cwd the folder the event names
 * @returns {{ edits: string[], commands: { command: string, cwd: string | null }[] }}
 *   `edits` are absolute paths; `commands` are the shell commands with the
 *   folder each was started in (before any `cd` inside it).
 */
export function digestToolCall(toolName, toolInput, cwd) {
  const out = { edits: [], commands: [] };
  if (typeof toolName !== "string" || !toolInput || typeof toolInput !== "object") return out;
  const input = toolInput;
  const field = Object.hasOwn(CLAUDE_EDIT_FIELD, toolName) ? CLAUDE_EDIT_FIELD[toolName] : null;
  if (field) {
    const abs = resolveIn(cwd, input[field]);
    if (abs) out.edits.push(abs);
    return out;
  }
  if (toolName === "apply_patch") {
    const doc = typeof input.patch === "string" ? input.patch : typeof input.input === "string" ? input.input : null;
    out.edits.push(...patchEdits(patchPaths(doc), cwd));
    return out;
  }
  if (CLAUDE_SHELL.has(toolName)) {
    if (typeof input.command === "string" && input.command.trim()) out.commands.push({ command: input.command, cwd: commandCwd(null, cwd) });
    return out;
  }
  if (CODEX_STRING_SHELL.has(toolName)) {
    const command = typeof input.cmd === "string" ? input.cmd : typeof input.command === "string" ? input.command : null;
    if (command && command.trim()) out.commands.push({ command, cwd: commandCwd(input.workdir, cwd) });
    return out;
  }
  if (toolName === "shell") {
    const command = typeof input.command === "string" ? input.command : argvCommand(input.command);
    if (command && command.trim()) out.commands.push({ command, cwd: commandCwd(input.workdir, cwd) });
    return out;
  }
  if (toolName === "exec" && typeof input.script === "string") {
    const calls = codexScriptCalls(input.script);
    for (const c of calls.commands) out.commands.push({ command: c.command, cwd: commandCwd(c.workdir, cwd) });
    for (const files of calls.patches) {
      for (const abs of patchEdits(files, cwd)) if (!out.edits.includes(abs)) out.edits.push(abs);
    }
  }
  return out;
}

// ─── One call's output ─────────────────────────────────────────────────────

/** The most of a call's output this reads; git's summary lines are short and
 *  near the end of a commit's output, and a megabyte holds any real one. */
const MAX_OUTPUT_CHARS = 1 << 20;

function collectText(value, out, depth) {
  if (out.length >= 64 || depth > 3 || value == null) return;
  if (typeof value === "string") { out.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectText(v && typeof v === "object" && typeof v.text === "string" ? v.text : v, out, depth + 1); return; }
  if (typeof value !== "object") return;
  // Claude's Bash result is `{ stdout, stderr, interrupted, … }`; the two
  // streams are the text. Anything else: the string fields one level down.
  for (const key of ["stdout", "stderr", "output", "content", "text", "error"]) {
    if (key in value) collectText(value[key], out, depth + 1);
  }
}

/**
 * The text a tool call printed: Claude's `{ stdout, stderr }`, a Codex result's
 * parts, a bare string — plus a failure's `error`. Capped.
 *
 * @param {unknown} payload a PostToolUse / PostToolUseFailure payload
 * @returns {string}
 */
export function toolOutputText(payload) {
  if (!payload || typeof payload !== "object") return "";
  const parts = [];
  collectText(payload.tool_response, parts, 0);
  if (typeof payload.error === "string") parts.push(payload.error);
  const text = parts.join("\n");
  return text.length > MAX_OUTPUT_CHARS ? text.slice(-MAX_OUTPUT_CHARS) : text;
}
