// What a tool call looks like on the canvas: the emoji and word on its bubble,
// and the sub-bubble that says what it was ABOUT — the command a shell call ran,
// the file a file tool touched, the method an MCP server was asked for.
//
// Lifted out of components/ToolBursts.tsx unchanged. Nothing here draws or
// places anything: the burst layer asks these for a bubble's face, the card's
// compact face asks for the same word (toolSubject), and the detail panel's MCP
// chip asks for the same identity (mcpChipIdentity), so the three cannot
// describe one call three ways. Which category a call falls in is
// tool-taxonomy.ts's, not this file's.
import {
  codexScriptCommand,
  CODEX_SHELL_TOOLS,
  CODEX_TOOL_EMOJI,
  CODEX_TOOL_LABEL,
  type ToolCategory,
} from "./tool-taxonomy";
import { ownRow } from "./own-row";

// Distinct emojis for every CC built-in I know about + sensible fallback.
const TOOL_EMOJI: Record<string, string> = {
  Read: "📖",
  Write: "💾",
  Edit: "✏️",
  MultiEdit: "🔧",
  Glob: "🗺️",
  Grep: "🔎",
  Bash: "⚡",
  PowerShell: "💻",
  LS: "📂",
  Task: "🤖",
  Agent: "🤖",
  TodoWrite: "📋",
  TaskCreate: "📋",
  TaskUpdate: "📝",
  TaskList: "🗂️",
  TaskGet: "🗂️",
  TaskOutput: "📤",
  TaskStop: "🛑",
  WebFetch: "🌐",
  WebSearch: "🔭",
  ToolSearch: "🧰",
  NotebookEdit: "📓",
  EnterPlanMode: "🧭",
  ExitPlanMode: "🏁",
  AskUserQuestion: "❓",
  ScheduleWakeup: "⏰",
  CronCreate: "⏰",
  CronList: "📅",
  CronDelete: "🗑️",
  Skill: "🎯",
  Workflow: "🎬",
  Monitor: "📡",
  PushNotification: "🔔",
  RemoteTrigger: "📡",
  // …and every Codex tool, from the one spec table they all derive from.
  ...CODEX_TOOL_EMOJI,
};

/** The bubble's emoji. An own row only, for the same reason categoryFor asks
 *  for one (#474) — a tool name is outside data, and `TOOL_EMOJI["toString"]`
 *  is an inherited function that `??` cannot see past, so React would be
 *  handed a function where it expects a node. Every name with a row is
 *  untouched. See own-row.ts. */
function emojiFor(name: string): string {
  if (name.startsWith("mcp__")) return "🔌";
  return ownRow(TOOL_EMOJI, name) ?? "✨";
}

// ─── Shell-command introspection ──────────────────────────────────────────
// When a tool call is Bash/PowerShell we crack open its input and surface the
// underlying command (git/npm/grep/…) instead of just labelling the bubble
// "Bash". The category accent stays amber for `shell` so you still know it
// was a shell call, and the original Bash/PowerShell text + full command go
// into the tooltip.

const COMMAND_EMOJI: Record<string, string> = {
  // VCS / forges
  git: "🐙", gh: "🐙", glab: "🐙",
  // Package managers
  npm: "📦", pnpm: "📦", yarn: "📦", bun: "📦", brew: "🍺",
  // Languages / runtimes
  node: "🟢", deno: "🟢",
  python: "🐍", python3: "🐍", py: "🐍", pip: "🐍", pip3: "🐍", uv: "🐍",
  ruby: "💎", bundle: "💎", gem: "💎",
  cargo: "🦀", rustc: "🦀", rustup: "🦀",
  go: "🐹",
  // Containers / orchestration
  docker: "🐳", "docker-compose": "🐳", podman: "🐳",
  kubectl: "☸️", helm: "☸️", k9s: "☸️",
  // Search / files
  grep: "🔎", rg: "🔎", ag: "🔎", ack: "🔎",
  find: "🔍", fd: "🔍", locate: "🔍", which: "🔍",
  ls: "📂", dir: "📂", tree: "📂",
  cat: "📄", head: "📄", tail: "📄", less: "📄", more: "📄", bat: "📄",
  cp: "📋", mv: "✂️", rm: "🗑️", rmdir: "🗑️", mkdir: "📁", touch: "📁",
  sed: "✏️", awk: "✏️", tr: "✏️",
  // Network
  curl: "🌐", wget: "🌐", http: "🌐", httpie: "🌐",
  ssh: "🔐", scp: "🔐", rsync: "🔐", ping: "📡",
  // Build / make
  make: "🔨", cmake: "🔨", ninja: "🔨", bazel: "🔨", just: "🔨",
  // Infra / config
  terraform: "🏗️", ansible: "📕", pulumi: "🏗️",
  // Process / system
  ps: "📊", top: "📊", htop: "📊", btm: "📊",
  kill: "💀", pkill: "💀",
  systemctl: "⚙️", service: "⚙️",
  // Archives
  tar: "🗜️", zip: "🗜️", unzip: "🗜️", gzip: "🗜️", "7z": "🗜️",
  // Editors / data
  vim: "📝", nvim: "📝", nano: "📝", emacs: "📝", code: "📝",
  jq: "🪺", yq: "🪺",
  // Echo-likes
  echo: "💬", printf: "💬",
  // Media
  ffmpeg: "🎞️", ffprobe: "🎞️", imagemagick: "🖼️", convert: "🖼️",
  // PowerShell cmdlets — picked the ones I see most often in actual hook
  // payloads. Same emoji as their POSIX cousins so the eye is trained once.
  "Get-ChildItem": "📂", "Get-Content": "📄", "Set-Content": "💾",
  "Out-File": "💾", "Add-Content": "💾",
  "Set-Location": "📍", "Get-Location": "📍",
  "Get-Process": "📊", "Start-Process": "▶️", "Stop-Process": "💀",
  "Invoke-WebRequest": "🌐", "Invoke-RestMethod": "🌐",
  "New-Item": "📁", "Remove-Item": "🗑️", "Copy-Item": "📋", "Move-Item": "✂️",
  "Test-Path": "🔍", "Where-Object": "🔎", "ForEach-Object": "🔁",
  "Select-Object": "🎯", "Measure-Object": "📊",
  "Get-Service": "⚙️", "Restart-Service": "⚙️",
  "ConvertTo-Json": "🪺", "ConvertFrom-Json": "🪺",
};

/** Pull the primary executable name out of a shell command string. Tries
 *  hard enough to be useful — strips `env VAR=val`, `sudo`, and unwraps a
 *  `bash -c "..."` shell — but doesn't pretend to be a real parser. */
function parseShellCommand(input: string): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;

  // bash -c "git status"  /  sh -c '...'  /  powershell -Command "..."  →
  // recurse into the inner command so we get the real verb.
  const wrap = s.match(/^(?:bash|sh|zsh|fish|powershell|pwsh)(?:\.exe)?\s+(?:-c|-Command|-NoProfile|-NonInteractive|\s)+["']([^"']+)["']/i);
  if (wrap) return parseShellCommand(wrap[1]);

  // env VAR=val VAR2=val2 cmd  →  strip leading var assignments.
  while (true) {
    const m = s.match(/^([A-Z_][A-Z0-9_]*=\S*)\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }

  // sudo [-flags] cmd  →  cmd
  s = s.replace(/^sudo(?:\s+-\S+)*\s+/, "");
  // time / nohup / xargs wrappers
  s = s.replace(/^(?:time|nohup|xargs)\s+/, "");

  const first = s.match(/^([^\s|;&<>(]+)/);
  if (!first) return null;
  let cmd = first[1];
  // WHAT SURVIVED THE METACHARACTERS IS NOT AUTOMATICALLY A COMMAND. The grab
  // above stops at whitespace and at most shell punctuation, but not at `)` or
  // a quote — so when the wrappers at the top fail to unwrap a `$( )`
  // substitution, the leftovers came through as a command name and the canvas
  // drew a bubble labelled `+$s)"`. A real command is an identifier, possibly
  // with dots or dashes; anything else is this parser failing, and saying so is
  // free — `skinForShellCall` already degrades to a bare `⚡ Bash`, which is
  // true, where this was drawing something that was not.
  if (!/^[A-Za-z0-9_][\w.+-]*$/.test(cmd.replace(/^.*[/\\]/, ""))) return null;

  // Strip a leading path: /usr/bin/git → git, ./foo.sh → foo.sh
  cmd = cmd.replace(/^.*[/\\]/, "");
  // Strip a trailing .exe / .cmd on Windows
  cmd = cmd.replace(/\.(exe|cmd|bat|ps1)$/i, "");

  return cmd || null;
}

interface CommandSkin {
  emoji: string;
  label: string;
  /** Sub-bubble accent — picks the colored stripe + glow. */
  category: ToolCategory;
  /** Optional richer text for the tooltip — full path / full command. */
  detail?: string;
}

/** Extract a usable command string from CC's tool_input.
 *  - Bash:        { command: "git status", description?: string, ... }
 *  - PowerShell:  { command: "..." } or sometimes { script: "..." }
 *  - Codex shell: { command: ["powershell.exe","-NoProfile","-Command","<cmd>"] }
 *  - Codex exec_command: { cmd: "ls", workdir: "..." }
 *  - Codex shell_command: { command: "cd X && git status" }
 *  - Codex exec:  { script: "const r = await tools.exec_command({cmd:\"…\"})" }
 *  - Fallback:    if input is a bare string, use it directly. */
function commandStringOf(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  // The Codex `exec` tool first, because what it carries is a PROGRAM and not a
  // command: taking its first token the way parseShellCommand would draws
  // "⚙️ const" on every Codex call in the deck (#417). codexScriptCommand digs
  // out the `cmd` the script hands to tools.exec_command, so the sub-bubble
  // reads the same "🐙 git" a Claude Bash call does. It returns null for
  // anything that is not a Codex script, which leaves every other shape below
  // reached exactly as before — including PowerShell's own `script` key.
  if (typeof obj.script === "string") {
    const fromScript = codexScriptCommand(obj.script);
    if (fromScript) return fromScript;
  }
  if (typeof obj.cmd === "string") return obj.cmd;
  if (typeof obj.command === "string") return obj.command;
  // Codex `shell` tool: command is a string array like
  // ["powershell.exe", "-NoProfile", "-Command", "<real cmd>"]
  // When it looks like a shell wrapper, surface the real inner command.
  if (Array.isArray(obj.command) && obj.command.every(x => typeof x === "string")) {
    const arr = obj.command as string[];
    // If first element is a known shell interpreter, look for -Command/-c flag
    // and return the argument that follows it as the real command.
    if (/powershell|cmd|bash|sh(\.exe)?$/i.test(arr[0] ?? "")) {
      const flagIdx = arr.findIndex(a => /^(-Command|-c)$/i.test(a));
      if (flagIdx >= 0 && flagIdx + 1 < arr.length) {
        return arr[flagIdx + 1];
      }
    }
    // Fallback: join the whole array.
    return arr.join(" ");
  }
  if (typeof obj.script === "string") return obj.script;
  return null;
}

// Claude's two shell tools, plus every Codex tool the spec table marks as
// carrying a command. Deriving the Codex half is what stops a renamed Codex
// shell tool from silently losing its sub-bubble — the one consequence of #417
// the user actually noticed, because the sub-bubble is what shows WHAT RAN.
const SHELL_TOOLS = new Set(["Bash", "PowerShell", ...CODEX_SHELL_TOOLS]);

function skinForShellCall(toolName: string, input: unknown): CommandSkin | null {
  if (!SHELL_TOOLS.has(toolName)) return null;
  const raw = commandStringOf(input);
  if (!raw) return null;
  const cmd = parseShellCommand(raw);
  if (!cmd) return null;
  // Always render a sub-bubble for parseable shell calls. If the command
  // isn't in our curated emoji map, use a generic gear so the user can
  // still see "agent → Bash → <whatever-the-command-was>".
  // An own row only, because `cmd` is the first word of a command the agent
  // ran and `COMMAND_EMOJI["toString"]` is an inherited function, not a gear
  // (#474).
  const emoji = ownRow(COMMAND_EMOJI, cmd) ?? "⚙️";
  return { emoji, label: cmd, category: "shell", detail: raw };
}

// ─── File-tool introspection ──────────────────────────────────────────────
// Mirror what we did for Bash: for Read/Write/Edit/MultiEdit/NotebookEdit,
// crack open tool_input, take the file basename, pick an emoji by
// extension so the canvas reads "📖 Read → 🐍 main.py" instead of just
// "📖 Read". Tooltip shows the full path.

const FILE_TOOLS = new Set(["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "LS", "Glob", "apply_patch"]);

/** Emoji by file extension — covers code / config / docs / media / etc.
 *  Picked so each ext is visually distinct from neighbours at low zoom. */
const EXT_EMOJI: Record<string, string> = {
  ts: "🟦", tsx: "🟦", d: "🟦",
  js: "🟨", jsx: "🟨", mjs: "🟨", cjs: "🟨",
  py: "🐍", pyi: "🐍", ipynb: "📓",
  rs: "🦀",
  go: "🐹",
  rb: "💎", erb: "💎",
  java: "☕", kt: "☕", scala: "☕", gradle: "☕",
  cs: "🔷", fs: "🔷",
  php: "🐘",
  swift: "🦅",
  c: "🇨", cpp: "🇨", cc: "🇨", h: "🇨", hpp: "🇨",
  md: "📝", mdx: "📝", rst: "📝",
  json: "🪺", json5: "🪺", jsonl: "🪺",
  yaml: "⚙️", yml: "⚙️", toml: "⚙️", ini: "⚙️", conf: "⚙️", cfg: "⚙️",
  xml: "📰", html: "🌐", htm: "🌐", vue: "🌐", svelte: "🌐",
  css: "🎨", scss: "🎨", sass: "🎨", less: "🎨",
  sh: "⚡", bash: "⚡", zsh: "⚡", fish: "⚡", ps1: "⚡",
  txt: "📄", log: "📄", out: "📄",
  csv: "📊", tsv: "📊", xlsx: "📊", xls: "📊",
  pdf: "📕",
  png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️", ico: "🖼️",
  mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬", webm: "🎬",
  mp3: "🎵", wav: "🎵", ogg: "🎵", flac: "🎵",
  zip: "🗜️", tar: "🗜️", gz: "🗜️", bz2: "🗜️", "7z": "🗜️", xz: "🗜️", rar: "🗜️",
  env: "🔐", lock: "🔐", pem: "🔐", key: "🔐", crt: "🔐",
  sql: "🗄️", db: "🗄️", sqlite: "🗄️", parquet: "🗄️",
};

/** Special filename overrides — when the whole filename is iconic. */
const SPECIAL_FILES: Record<string, string> = {
  "dockerfile": "🐳",
  "makefile": "🔨",
  "rakefile": "💎",
  "package.json": "📦",
  "pnpm-lock.yaml": "📦",
  "yarn.lock": "📦",
  "cargo.toml": "🦀",
  "cargo.lock": "🦀",
  "go.mod": "🐹",
  "go.sum": "🐹",
  "pyproject.toml": "🐍",
  "requirements.txt": "🐍",
  "readme.md": "📖",
  "readme": "📖",
  "license": "📜",
  ".gitignore": "🐙",
  ".gitattributes": "🐙",
  ".env": "🔐",
  ".dockerignore": "🐳",
};

function basenameOf(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const trimmed = norm.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/** Both lookups ask for an own row rather than a truthy value (#474): a
 *  filename and an extension are outside data too, and an inherited member is
 *  truthy — a file called `constructor`, or one ending `.__proto__`, would
 *  otherwise take the early return and hand a function (or `Object.prototype`)
 *  back as its emoji. */
function emojiForFilename(name: string): string {
  const lc = name.toLowerCase();
  const special = ownRow(SPECIAL_FILES, lc);
  if (special !== undefined) return special;
  if (lc.startsWith("dockerfile.")) return "🐳";
  // Test files
  if (/\.(test|spec)\.[a-z]+$/.test(lc)) return "🧪";
  // Extension lookup
  const dot = lc.lastIndexOf(".");
  if (dot > 0 && dot < lc.length - 1) {
    const byExt = ownRow(EXT_EMOJI, lc.slice(dot + 1));
    if (byExt !== undefined) return byExt;
  }
  return "📄";
}

function extractFilePath(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  // Codex apply_patch: extract the first file path from the patch header.
  // Matches "*** Update File: ", "*** Add File: ", or "*** Delete File: ".
  if (toolName === "apply_patch" && typeof obj.patch === "string") {
    const m = obj.patch.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/m);
    if (m) return m[1].trim();
    return null;
  }
  // CC's most-common key shapes across file tools.
  if (typeof obj.file_path === "string") return obj.file_path;
  if (typeof obj.notebook_path === "string") return obj.notebook_path;
  if (typeof obj.path === "string") return obj.path;
  // Glob uses pattern as the "thing" — render that instead.
  if (toolName === "Glob" && typeof obj.pattern === "string") return obj.pattern;
  return null;
}

function skinForFileCall(toolName: string, input: unknown): CommandSkin | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  const path = extractFilePath(toolName, input);
  if (!path) return null;
  const name = basenameOf(path);
  if (!name) return null;
  // For directories (LS) treat as "file" category with folder emoji.
  const isDir = toolName === "LS";
  const emoji = isDir ? "📂" : emojiForFilename(name);
  return { emoji, label: name, category: "file", detail: path };
}

// ─── MCP server introspection ─────────────────────────────────────────────
// CC names MCP tools as `mcp__<server>__<method>`. When we recognise the
// server we use a branded emoji + name on the primary bubble; the
// sub-bubble carries the actual method. Unknown servers still get
// distinct treatment via a hash-based hue (so 5 unknown MCP servers each
// look different from each other).

/** Built-in server identity — emoji + display name. Keep names short. */
const MCP_SERVERS: Record<string, { emoji: string; name: string }> = {
  github:    { emoji: "🐙", name: "GitHub" },
  git:       { emoji: "🐙", name: "Git" },
  gitlab:    { emoji: "🦊", name: "GitLab" },
  slack:     { emoji: "💬", name: "Slack" },
  discord:   { emoji: "💬", name: "Discord" },
  linear:    { emoji: "📐", name: "Linear" },
  jira:      { emoji: "🅹",  name: "Jira" },
  atlassian: { emoji: "🅰️", name: "Atlassian" },
  notion:    { emoji: "📓", name: "Notion" },
  asana:     { emoji: "📋", name: "Asana" },
  intercom:  { emoji: "💬", name: "Intercom" },
  figma:     { emoji: "🎨", name: "Figma" },
  gmail:     { emoji: "📧", name: "Gmail" },
  calendar:  { emoji: "📅", name: "Calendar" },
  drive:     { emoji: "☁️", name: "Drive" },
  zoom:      { emoji: "📹", name: "Zoom" },
  spotify:   { emoji: "🎵", name: "Spotify" },
  youtube:   { emoji: "📺", name: "YouTube" },
  ccd_session:     { emoji: "📡", name: "Session" },
  ccd_directory:   { emoji: "📂", name: "Directory" },
  ccd_session_mgmt:{ emoji: "📡", name: "Sessions" },
  mcp_registry:    { emoji: "🧰", name: "Registry" },
  "computer-use":  { emoji: "🖱️", name: "Computer" },
  "claude-in-chrome":  { emoji: "🌐", name: "Chrome" },
  "claude-preview":    { emoji: "👀", name: "Preview" },
  "scheduled-tasks":   { emoji: "⏰", name: "Scheduler" },
  visualize:           { emoji: "🎨", name: "Visualize" },
  "plugin-design-asana":    { emoji: "📋", name: "Asana" },
  "plugin-design-atlassian":{ emoji: "🅰️", name: "Atlassian" },
  "plugin-design-figma":    { emoji: "🎨", name: "Figma" },
  "plugin-design-intercom": { emoji: "💬", name: "Intercom" },
  "plugin-design-linear":   { emoji: "📐", name: "Linear" },
  "plugin-design-notion":   { emoji: "📓", name: "Notion" },
  "plugin-design-slack":    { emoji: "💬", name: "Slack" },
};

/** Pull `<server>` out of `mcp__<server>__<method>`. The server segment is
 *  often a long uuid for ad-hoc MCPs — we still return it so unknown
 *  servers get colour-tinted by hash. */
interface McpParse { server: string; method: string }
function parseMcpName(toolName: string): McpParse | null {
  if (!toolName.startsWith("mcp__")) return null;
  // After the mcp__ prefix the rest is `<server>__<method>`. Server names
  // can contain hyphens but `__` is the separator.
  const rest = toolName.slice(5);
  const idx = rest.indexOf("__");
  if (idx <= 0) return { server: rest, method: "" };
  return { server: rest.slice(0, idx), method: rest.slice(idx + 2) };
}

/** Stable hash → 0..359 hue for unknown MCP servers.
 *
 *  Module-private, and back that way deliberately. #501 exported it for one
 *  reader: the topbar's MCP legend, which had spelled the djb2 out a second time
 *  under a comment saying "same hash ToolBursts uses" — the shape #374 spent a
 *  whole issue removing, since a copy is only correct until one side is edited.
 *  That legend is gone, and an export whose only caller is in its own file is
 *  the dead surface #383 swept. `primaryDisplayFor` is the one caller now, and
 *  both surfaces that show a server's hue — the bubble and the MCP category
 *  chip — reach it through that, so they still cannot disagree.
 *
 *  What kept the export honest is not gone with it: cat-chip-tint.test.ts still
 *  pins this against a restatement of the retired copy, through the public
 *  functions rather than through the symbol. */
function hashHue(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return Math.abs(h) % 360;
}

/** The branded identity for a server segment, or undefined when the deck has no
 *  row for it — the two callers below both branch on "do we know this one".
 *  An own row only, because the segment comes out of the tool name (#474):
 *  every server in `mcp__<server>__<method>` is named by whoever wrote the MCP
 *  config, so `mcp__constructor__query` would otherwise be "known", with a
 *  function for its emoji and `undefined` for its name. */
function knownMcpServer(server: string): { emoji: string; name: string } | undefined {
  return ownRow(MCP_SERVERS, server.toLowerCase());
}

function skinForMcpCall(toolName: string, _input: unknown): CommandSkin | null {
  const parsed = parseMcpName(toolName);
  if (!parsed) return null;
  const { server, method } = parsed;
  if (!method) return null; // not enough to chain
  // Try a few key shapes: full server, no-prefix-hash server, etc.
  const known = knownMcpServer(server);
  return {
    emoji: known?.emoji ?? "🔌",
    label: method,
    category: "mcp",
    detail: known ? `${known.name} · ${method}` : `${server} · ${method}`,
  };
}

/** Single entry point that picks whichever skin applies (shell first, then
 *  file, then MCP). Keeps collectBursts callers from caring about tool
 *  families. */
export function skinFor(toolName: string, input: unknown): CommandSkin | null {
  return skinForShellCall(toolName, input)
      ?? skinForFileCall(toolName, input)
      ?? skinForMcpCall(toolName, input);
}

/** What a call is ABOUT, in the sub-bubble's own word — `styles.css`, `npx`,
 *  `create_pr` — or null when the call has no such word. For the card's compact
 *  face, which names the open call once the bubbles are no longer drawn: the
 *  same word, so the face and the bubble cannot describe one call two ways. */
export function toolSubject(toolName: string, input: unknown): string | null {
  return skinFor(toolName, input)?.label ?? null;
}

/** Used by the primary bubble — for MCP calls we replace the generic
 *  "mcp__foo__bar" with the server name so the primary reads e.g.
 *  "🐙 GitHub" and the sub bubble reads "create_pr". Non-MCP tools fall
 *  back to the existing emojiFor / tool name. */
interface PrimaryDisplay { emoji: string; label: string; hue?: number }

// Codex exposes raw internal tool names ("exec", "exec_command",
// "apply_patch"…). Show clean, Claude-style labels on the bubble instead;
// the original name still goes into the tooltip (b.toolName) so nothing is
// hidden. Display-only — does not affect categorisation or Claude tools.
const CODEX_PRIMARY_LABEL: Record<string, string> = CODEX_TOOL_LABEL;

/** The longest a bubble's word may be.
 *
 *  A known server is a short word somebody chose. An UNKNOWN one is whatever
 *  the segment happened to be, and that is routinely a uuid — 36 characters,
 *  which `primaryBubbleWidth` turns into a 304px pill because it scales the
 *  reserved width off the same string. Nothing clipped it: `.tool-burst` is
 *  `white-space: nowrap` with no max-width, so the pill simply ran, pushing its
 *  own sub-bubble out of the 420px lane the layout budgets for the whole trail.
 *
 *  The label cap applies to every tool family and chained sub-bubble. CSS
 *  also bounds each pill, so a wide glyph cannot push the trail into the next
 *  session's lane. The full tool name and input remain in the tooltip. */
const LABEL_MAX = 18;

/** Cut on code points, so a surrogate pair is never split in half — the same
 *  rule the cluster header's own truncation follows. Exported so a test
 *  asserting a drawn label derives the cut from here rather than hand-computing
 *  it, and cannot drift from LABEL_MAX the way a literal would. */
export function cutLabel(label: string): string {
  const cp = [...label];
  return cp.length <= LABEL_MAX ? label : cp.slice(0, LABEL_MAX - 1).join("") + "…";
}

/** The longest a SUB-bubble's word may be, ellipsis included.
 *
 *  A sub-bubble is smaller type in a smaller pill: `.tool-burst.sub` is 140px
 *  at 10px monospace, about 6.1px a character, and once the edge, padding,
 *  glyph, gaps and status mark are paid for the name has roughly 80px — room
 *  for thirteen characters, not LABEL_MAX's eighteen. Cut at eighteen, the
 *  sheet cut it a second time around thirteen, with its own ellipsis and at the
 *  end, so `package-lock.json` drew as `package-lock.…` — the extension, the
 *  one part that says what kind of file it is, was the part that went. The cut
 *  happens here now, at what the pill can show, and the sheet's max-width stays
 *  only as the backstop for a glyph wider than the arithmetic assumed. The 140
 *  cannot grow instead: 60 + 190 + 28 + 140 is already 418 of the 420px lane
 *  (#978). */
const SUB_LABEL_MAX = 13;

/** A file name keeps an extension up to this long, dot included — `.json`,
 *  `.tsx`, `.scss`. Past it the "extension" is more likely a word
 *  (`Dockerfile.production`) and the name is cut at the end like any other. */
const EXT_KEEP_MAX = 6;

/** A sub-bubble's word, cut to what the pill shows. A file name is cut in the
 *  middle so its extension survives (`package….json`); anything else — a
 *  command, an MCP method, a glob — at the end, the way cutLabel cuts. On code
 *  points, for the same reason cutLabel gives. */
export function cutSubLabel(label: string, category: ToolCategory): string {
  const cp = [...label];
  if (cp.length <= SUB_LABEL_MAX) return label;
  const dot = cp.lastIndexOf(".");
  const ext = dot > 0 ? cp.slice(dot) : [];
  if (category === "file" && ext.length > 1 && ext.length <= EXT_KEEP_MAX) {
    return cp.slice(0, SUB_LABEL_MAX - 1 - ext.length).join("") + "…" + ext.join("");
  }
  return cp.slice(0, SUB_LABEL_MAX - 1).join("") + "…";
}

export function primaryDisplayFor(toolName: string): PrimaryDisplay {
  const mcp = parseMcpName(toolName);
  if (mcp) {
    const known = knownMcpServer(mcp.server);
    if (known) return { emoji: known.emoji, label: cutLabel(known.name) };
    // Unknown server — keep the literal segment, tint by hash. The hue is
    // hashed from the WHOLE segment and the label is what is drawn, so two
    // servers that share their first characters still get different colours.
    return { emoji: "🔌", label: cutLabel(mcp.server), hue: hashHue(mcp.server) };
  }
  // An own row only (#474): the raw tool name is outside data, and an inherited
  // member is truthy, so `CODEX_PRIMARY_LABEL["toString"]` would put a function
  // on the bubble where the tool's own name belongs.
  const codexLabel = ownRow(CODEX_PRIMARY_LABEL, toolName) ?? "";
  if (codexLabel) return { emoji: emojiFor(toolName), label: cutLabel(codexLabel) };
  return { emoji: emojiFor(toolName), label: cutLabel(toolName) };
}

/**
 * Who an agent's MCP category chip is counting, when it is counting one server
 * — and null when it is not (#489).
 *
 * THE DEFECT. A bubble on the canvas gives an unrecognised MCP server its own
 * hue, so two servers on screen are two colours; the chip in the detail panel
 * gave every MCP call the same generic teal whichever server it counted. One
 * category, two visual identities, which is the shape #383 fixed for `other` a
 * round earlier — except that this time the surfaces disagree about how much
 * they distinguish rather than whether they tint at all.
 *
 * WHY IT IS NOT A COPY OF THE BUBBLE'S RULE. The chip is a COUNT ACROSS
 * SERVERS. Three servers under one chip have no single hue between them, so
 * there is nothing for a mechanical copy to paint. What the chip CAN do is the
 * case where the count is one server's: then the chip and every bubble it
 * counts are describing the same thing, and the chip may wear what they wear.
 *
 * So this returns `primaryDisplayFor`'s own answer for one of those calls —
 * the same label and the same `hue` the bubbles were given, produced by the
 * function that gave it to them rather than by a second implementation of the
 * mapping. A `hue` of undefined is not a gap: it is what a server MCP_SERVERS
 * has a row for gets, which is exactly when the bubble wears the base
 * --cat-accent instead of a hashed one, so the chip stays teal precisely when
 * its bubbles do. Two servers, or none, and there is no one identity to show —
 * null, and the chip is the plain category chip it has always been.
 *
 * The hue is never the only thing this decides. `label` is drawn on the chip as
 * words, because a per-server colour that a dichromat reader cannot see is a
 * distinction that, for them, is not being made at all (1.4.1).
 */
export function mcpChipIdentity(toolNames: Iterable<string>): PrimaryDisplay | null {
  let server: string | null = null;
  let sample = "";
  for (const name of toolNames) {
    const parsed = parseMcpName(name);
    if (!parsed) continue;
    // `mcp__` with nothing after it names no server. There would be no words to
    // draw, which leaves a hue carrying the distinction on its own — the one
    // arrangement this function exists to avoid.
    if (!parsed.server) return null;
    if (server === null) { server = parsed.server; sample = name; }
    else if (parsed.server !== server) return null;
  }
  return server === null ? null : primaryDisplayFor(sample);
}
