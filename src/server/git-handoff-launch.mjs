// The command line that opens a folder in a git client, an editor or a
// terminal, for the git view's hand-off buttons — built here, run by
// git-handoff-routes.mjs through exec.mjs's runDetached.
//
// EVERY LAUNCH IS A FIXED ARGUMENT VECTOR. The folder and the file are whole
// argv entries, never pasted into a command string a shell would read, so a
// folder named `a; rm -rf ~` is a folder with an odd name and nothing more.
// Where a value has to share an entry with a flag (`--working-directory=…`,
// `--cli-open=…`) the entry is still one argument handed to the program as is.
// The two places a second parser is unavoidable are named where they happen:
// Windows Terminal reads `;` in its own arguments as a separator, and a
// JetBrains Toolbox script is a `.cmd` that only cmd.exe can run.
//
// NOTHING HERE TOUCHES THE REPOSITORY. The deck opens an app on a folder and
// lets go; what happens in that app is the person's doing.
import { posix, win32 } from "node:path";
import { shellQuoteArg } from "./exec-spec.mjs";
import { appInfo } from "./git-handoff-apps.mjs";

/** Why a launch cannot be built, from a closed set the route turns into words. */
export const REFUSALS = Object.freeze({
  unquotable: "unquotable",   // a folder or file cmd.exe would expand
  separator: "separator",     // a folder Windows Terminal would split
  noTerminal: "no-terminal",  // lazygit with nothing to run in
});

// lazygit inside Terminal or iTerm, which take a command only over Apple
// Events. The scripts are constants; the folder and lazygit's path arrive as
// `argv`, and `quoted form of` is AppleScript's own shell quoting — the line
// the terminal's shell reads is `cd '<folder>' && '<lazygit>'` whatever the
// folder is called. The first run asks the person to let the deck control the
// terminal, which is macOS's prompt and theirs to answer.
const TERMINAL_SCRIPT = [
  "on run argv",
  'tell application "Terminal"',
  "activate",
  'do script "cd " & quoted form of (item 1 of argv) & " && " & quoted form of (item 2 of argv)',
  "end tell",
  "end run",
];
const ITERM_SCRIPT = [
  "on run argv",
  'tell application "iTerm"',
  "activate",
  "set w to (create window with default profile)",
  'tell current session of w to write text "cd " & quoted form of (item 1 of argv) & " && " & quoted form of (item 2 of argv)',
  "end tell",
  "end run",
];
const osascript = (lines, args) => ({
  file: "/usr/bin/osascript",
  args: [...lines.flatMap((l) => ["-e", l]), ...args],
});

/** `open -a <bundle> <paths…>`: LaunchServices hands the app the paths, as Finder's Open With does. */
const openApp = (app, ...paths) => ({ file: "/usr/bin/open", args: ["-a", app, ...paths] });

/** A terminal on Linux opening a shell, or `cmd` when given, in `folder`. */
function linuxTerminal(id, path, folder, cmd) {
  const run = cmd ? [cmd] : [];
  switch (id) {
    case "gnome-terminal": return { file: path, args: [`--working-directory=${folder}`, ...(cmd ? ["--", cmd] : [])] };
    case "ptyxis": return { file: path, args: cmd ? ["-d", folder, "--", cmd] : ["--new-window", "-d", folder] };
    case "konsole": return { file: path, args: ["--workdir", folder, ...(cmd ? ["-e", cmd] : [])] };
    case "kitty": return { file: path, args: ["--directory", folder, ...run] };
    case "alacritty": return { file: path, args: ["--working-directory", folder, ...(cmd ? ["-e", cmd] : [])] };
    case "wezterm": return { file: path, args: ["start", "--cwd", folder, ...(cmd ? ["--", cmd] : [])] };
    case "ghostty": return { file: path, args: [`--working-directory=${folder}`, ...(cmd ? ["-e", cmd] : [])] };
    // Debian's alternative promises `-e` and nothing about a folder, so the
    // folder is the working directory the launch starts in.
    case "x-terminal-emulator": return { file: path, args: cmd ? ["-e", cmd] : [] };
    default: return null;
  }
}

/** A terminal on macOS doing the same. */
function macTerminal(id, app, folder, cmd) {
  switch (id) {
    case "terminal": return cmd ? osascript(TERMINAL_SCRIPT, [folder, cmd]) : openApp(app, folder);
    case "iterm": return cmd ? osascript(ITERM_SCRIPT, [folder, cmd]) : openApp(app, folder);
    case "ghostty": return cmd
      ? { file: "/usr/bin/open", args: ["-na", app, "--args", `--working-directory=${folder}`, "-e", cmd] }
      : openApp(app, folder);
    case "wezterm": return { file: posix.join(app, "Contents", "MacOS", "wezterm"), args: ["start", "--cwd", folder, ...(cmd ? ["--", cmd] : [])] };
    default: return null;
  }
}

/**
 * A console program in a console window of its own on Windows: `cmd /c start`.
 *
 * Node cannot ask for a new console. Its `detached` is DETACHED_PROCESS, which
 * leaves a console program with none at all, and without it the program shares
 * the deck's — lazygit drawing over the terminal `ccdeck --foreground` runs in.
 * `start` is how Windows opens one. The line is the program's own path and
 * constant flags, each quoted by shellQuoteArg; the folder is never on it —
 * it is the working directory the launch starts in, which `start` passes on.
 * A path with `%` or `!` in it is refused, the one thing cmd.exe expands inside
 * quotes.
 */
function startInConsole(exe, extra, comspec) {
  if (/[%!]/.test(exe)) return { refused: REFUSALS.unquotable };
  const line = ["start", '""', ...[exe, ...extra].map((a) => shellQuoteArg(a, "win32"))].join(" ");
  return { file: comspec, args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/**
 * What to run to open `app` on `folder`: `{ file, args, cwd, verbatim }`, or
 * `{ refused }` with one of REFUSALS.
 *
 * `app` is one of detectApps's answers. `file` is an absolute path inside
 * `folder` for an editor, else null. `terminal` is the terminal slot's app, for
 * lazygit. `cwd` is always the folder, so a program that ignores its flags
 * still starts in the right place. `verbatim` marks a cmd.exe line quoted here.
 */
export function launchSpec(app, {
  folder, file = null, terminal = null, platform = process.platform,
  comspec = process.env.ComSpec || process.env.comspec || "cmd.exe",
} = {}) {
  const path = app?.target?.path;
  if (!path || typeof folder !== "string" || !folder) return null;
  const withFile = app.slot === "editor" && file ? [folder, file] : [folder];
  const done = (spec) => {
    if (!spec) return null;
    if (spec.refused) return spec;
    return { cwd: folder, verbatim: false, ...spec };
  };

  if (platform === "darwin") {
    if (app.id === "lazygit") {
      if (!terminal) return { refused: REFUSALS.noTerminal };
      return done(macTerminal(terminal.id, terminal.target.path, folder, path));
    }
    if (app.slot === "terminal") return done(macTerminal(app.id, path, folder, null));
    // A bundle opens through LaunchServices; a Toolbox script, or a tool from
    // inside a bundle, is run as is.
    if (app.target.kind !== "app") return done({ file: path, args: withFile });
    // JetBrains documents a new instance handed the paths as arguments, which
    // passes them to a running IDE and exits (jetbrains.com/help/idea/
    // working-with-the-ide-features-from-command-line.html).
    if (appInfo(app.id)?.jetbrains) return done({ file: "/usr/bin/open", args: ["-na", path, "--args", ...withFile] });
    if (app.id === "gitkraken") return done({ file: "/usr/bin/open", args: ["-na", path, "--args", "-p", folder] });
    if (app.id === "github-desktop") return done({ file: "/usr/bin/open", args: ["-n", path, "--args", `--cli-open=${folder}`] });
    return done(openApp(path, ...withFile));
  }

  if (platform === "win32") {
    // A JetBrains Toolbox script is a .cmd, which exec.mjs runs through
    // cmd.exe with every argument quoted — except that cmd.exe expands %VAR%
    // even inside quotes and has no escape for it (exec-spec.mjs,
    // shellQuoteArg), so a folder carrying one is never handed to it.
    if (/\.(cmd|bat)$/i.test(path) && withFile.some((v) => /[%!]/.test(v))) return { refused: REFUSALS.unquotable };
    switch (app.id) {
      case "lazygit": return done(startInConsole(path, [], comspec));
      case "pwsh":
      case "powershell": return done(startInConsole(path, ["-NoLogo"], comspec));
      case "windows-terminal":
        // wt reads `;` as "next command" in its own arguments, quoted or not.
        if (folder.includes(";")) return { refused: REFUSALS.separator };
        return done({ file: path, args: ["-d", folder] });
      case "tower": return done({ file: path, args: /^gittower(\.exe)?$/i.test(win32.basename(path)) ? [folder] : ["-o", folder] });
      case "gitkraken": return done({ file: path, args: ["-p", folder] });
      case "github-desktop": return done({ file: path, args: [`--cli-open=${folder}`] });
      default: return done({ file: path, args: withFile });
    }
  }

  // Linux and the other POSIX systems.
  if (app.id === "lazygit") {
    if (!terminal) return { refused: REFUSALS.noTerminal };
    return done(linuxTerminal(terminal.id, terminal.target.path, folder, path));
  }
  if (app.slot === "terminal") return done(linuxTerminal(app.id, path, folder, null));
  if (app.id === "gitkraken") return done({ file: path, args: ["-p", folder] });
  return done({ file: path, args: withFile });
}

// What a launched app must not inherit from the deck. ELECTRON_RUN_AS_NODE is
// set when the desktop app runs the deck, and an Electron editor started with
// it runs as a bare Node and exits; the AGENTS_DECK_ markers are the deck's
// own bookkeeping, and a terminal that kept DETACHED would make the next
// `ccdeck` typed into it believe it was the background copy; CLAUDECODE would
// make a `claude` typed there think it is nested inside another session.
const INHERITED_NOT = new Set([
  "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE",
  "AGENTS_DECK_DETACHED", "AGENTS_DECK_RESPAWN", "AGENTS_DECK_SUPERVISOR_PID", "AGENTS_DECK_BOOT_VERSION",
  "AGENTS_DECK_BOOT_HOOKS", "AGENTS_DECK_INVOKED_AS", "AGENTS_DECK_RESTARTS", "AGENTS_DECK_INTERNAL",
  "AGENTS_DECK_BOOT_DEADLINE_MS", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
]);

/** The deck's environment minus what a launched app must not inherit. */
export function launchEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v === "string" && !INHERITED_NOT.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

// ── who is asking ───────────────────────────────────────────────────────────

const LOOPBACK_ADDR = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

// Headers a reverse proxy adds when it passes a request on. The deck binds
// loopback, so a request from another machine can only reach it through
// something on this one; most of those say so.
const FORWARDED = [
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "via",
  "cf-connecting-ip", "true-client-ip", "x-client-ip", "fly-client-ip", "tailscale-user-login",
];

/**
 * The operating system the browser says it runs on — `darwin`, `win32`,
 * `linux`, `other` (a phone, a tablet, ChromeOS), or null when the request does
 * not say (a script, curl, the hook).
 *
 * Chromium's `Sec-CH-UA-Platform` first, which it sends to a loopback origin
 * as to any secure one, then the User-Agent every browser sends.
 */
export function browserPlatform(headers = {}) {
  const hint = String(headers["sec-ch-ua-platform"] ?? "").replace(/"/g, "").trim().toLowerCase();
  if (hint === "macos") return "darwin";
  if (hint === "windows") return "win32";
  if (hint === "linux") return "linux";
  if (hint) return "other";
  const ua = String(headers["user-agent"] ?? "");
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(ua)) return "other";
  if (/Windows/i.test(ua)) return "win32";
  if (/Macintosh|Mac OS X/i.test(ua)) return "darwin";
  if (/X11|Linux/i.test(ua)) return "linux";
  return null;
}

/**
 * Is this request from a browser on the deck's own machine?
 *
 * `{ local, reason }`. Four things must hold, each a reason to say no on its
 * own: the connection comes from a loopback address; it was addressed to a name
 * that can only be this machine (the rebinding question request-gates.mjs asks);
 * no proxy says it forwarded it; and a browser that names its operating system
 * names this one.
 *
 * What it cannot see, said plainly: a browser on another machine of the SAME
 * operating system, reaching the deck through an SSH tunnel, arrives as a
 * loopback connection with a loopback Host and nothing forwarded — exactly a
 * local tab. The README says so beside the buttons.
 */
export function viewerIsLocal(req, { platform = process.platform, isLoopbackHost } = {}) {
  const headers = req?.headers ?? {};
  const addr = String(req?.socket?.remoteAddress ?? "");
  if (!LOOPBACK_ADDR.test(addr)) return { local: false, reason: "address" };
  if (typeof isLoopbackHost === "function" && !isLoopbackHost(headers.host)) return { local: false, reason: "host" };
  if (FORWARDED.some((h) => headers[h] !== undefined)) return { local: false, reason: "proxy" };
  const seen = browserPlatform(headers);
  if (seen && seen !== platform) return { local: false, reason: "other-os" };
  return { local: true, reason: "loopback" };
}
