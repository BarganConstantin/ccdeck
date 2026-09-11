// Starting the deck when you log in.
//
// Detaching answers "the terminal closed". It does not answer "the machine
// rebooted", and between those two the deck is exactly as absent: the hooks post
// into a refused connection, the LAN beacon goes quiet, and paired colleagues
// watch this machine time out. The first `ccdeck` typed after a reboot brings it
// back, and everything before that is lost.
//
// THREE PLATFORMS, THREE NATIVE SHAPES, and they differ for one reason: where
// the deck's console output can go.
//
//   macOS, launchd. The job runs the deck IN THE FOREGROUND — the plist carries
//   AGENTS_DECK_DETACHED so the launcher does not run away from launchd, which
//   is the whole point of handing a process to a supervisor. StandardOutPath and
//   StandardErrorPath put its voice in deck.log, where `--logs` reads it.
//
//   Linux, systemd --user. The same shape for the same reason, with
//   `StandardOutput=append:` instead of the plist keys. Type=simple, so systemd
//   holds the real process rather than guessing at a forked child.
//
//   Windows, Task Scheduler. There IS no output redirection, and wrapping the
//   command in `cmd /c "… >> log"` puts a quoting problem between the user and
//   their deck starting at all. So this is the one platform where the task runs
//   the LAUNCHER and lets it detach: the launcher already writes deck.log, the
//   task goes to "Ready" the moment it exits, and the deck it left behind keeps
//   running. Task Scheduler does not reap a task's orphans.
//
// NO RESTART POLICY, on any of the three. `KeepAlive`, `Restart=always` and
// "restart on failure" all exist and all are deliberately absent: the ceiling
// that decides when a crashed deck stops coming back lives in ONE place
// (crashPolicy, in supervisor.mjs), it is identical on every platform, and it is
// tested. Two policies over one process is how `ccdeck --stop` becomes a
// suggestion the machine overrules a second later.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the service is called.
 *
 * A bare label rather than reverse-DNS, and that is a choice rather than an
 * oversight: reverse-DNS names a domain, this project does not own one, and
 * inventing `md.ccdeck` or `com.ccdeck` would put a claim in a file on a user's
 * machine that nothing backs. launchd, systemd and schtasks all take a plain
 * name.
 */
export const SERVICE_LABEL = "ccdeck";

/** Where the record of what we did lives, so an install happens at most once and
 *  an uninstall is not undone by the next boot. */
export const SERVICE_RECORD = "service.json";

/** Where this platform keeps a per-user login item. */
export function servicePath(platform = process.platform, home = homedir(), env = process.env) {
  if (platform === "darwin") return join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  if (platform === "win32") return `\\${SERVICE_LABEL}`; // a Task Scheduler path, not a file
  const config = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(config, "systemd", "user", `${SERVICE_LABEL}.service`);
}

/** XML text escaping, for the two formats that are XML. A path can hold an
 *  ampersand, and a plist with a bare `&` in it does not parse — which launchd
 *  reports as a job that simply never runs. */
export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * The launchd job.
 *
 * RunAtLoad and nothing else. No KeepAlive — see the header — and no
 * StartInterval, because a deck that is already running is found by the next
 * launcher rather than started twice.
 *
 * AND NO `ProcessType`. `Background` was the obvious-looking choice and it is
 * measurably wrong: it puts the job in PRIO_DARWIN_BG, where disk I/O is
 * throttled hard enough that a boot which takes 0.8s from a shell had still
 * printed nothing after thirty seconds under launchd. This job is not
 * background work — it is the server behind a browser tab the user is looking
 * at. The default band is the honest one.
 */
export function plistFor({ execPath, script, logPath, label = SERVICE_LABEL, args = [], env = {} } = {}) {
  const argv = [execPath, script, ...args].map(a => `      <string>${xmlEscape(a)}</string>`).join("\n");
  const vars = Object.entries({ AGENTS_DECK_DETACHED: "1", ...env })
    .map(([k, v]) => `      <key>${xmlEscape(k)}</key>\n      <string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argv}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
${vars}
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logPath)}</string>
  </dict>
</plist>
`;
}

/**
 * The systemd --user unit.
 *
 * `append:` needs systemd 240, which is 2018 and older than every distribution
 * still receiving updates. No Restart=, for the reason in the header.
 */
export function unitFor({ execPath, script, logPath, args = [], env = {}, product = "ccdeck" } = {}) {
  const cmd = [execPath, script, ...args].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  const vars = Object.entries({ AGENTS_DECK_DETACHED: "1", ...env })
    .map(([k, v]) => `Environment=${k}=${v}`).join("\n");
  return `[Unit]
Description=${product} — live deck of Claude Code + Codex agents
After=default.target

[Service]
Type=simple
${vars}
ExecStart=${cmd}
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

/**
 * The Task Scheduler job, as XML.
 *
 * XML rather than `schtasks /TR "<command>"`, and this is not fussiness: /TR
 * takes the whole command line as one string, and the two things it has to hold
 * — `C:\\Program Files\\nodejs\\node.exe` and a path under the user's profile —
 * both contain spaces. Every combination of quotes and doubled quotes that
 * survives cmd.exe, schtasks' own parser and the scheduler's stored form is a
 * coin flip; the XML form has a field for the program and a field for its
 * arguments and no parsing between them.
 *
 * UTF-16LE with a BOM on disk, which is what schtasks requires and what a file
 * written as UTF-8 is silently rejected for.
 *
 * No <UserId>: schtasks fills in the account running it, which is the one whose
 * login this task is about. Naming it would be a guess that breaks on a renamed
 * account, a domain user or a machine in another locale.
 */
export function taskXmlFor({ execPath, script, args = [], product = "ccdeck" } = {}) {
  // NO ENVIRONMENT BLOCK, and that is the schema's doing rather than an
  // omission here: there is nowhere in a Task Scheduler task to put a variable.
  // Which is the second reason Windows runs the LAUNCHER and lets it detach
  // rather than carrying AGENTS_DECK_DETACHED like the other two — there is no
  // way to carry it. The launcher writes deck.log either way, so the output
  // this platform also cannot redirect lands in the same file as everywhere
  // else.
  const argLine = [script, ...args].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(product)} — live deck of Claude Code + Codex agents</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(execPath)}</Command>
      <Arguments>${xmlEscape(argLine)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Should this machine be offered a login item without being asked?
 *
 * ONCE PER MACHINE, EVER, and the record is what makes that true. Without it an
 * uninstall would be undone by the next start, which is not an uninstall — it is
 * a tool arguing with its user.
 *
 * `npx` is excluded, and not as a preference: the service would name a path
 * inside ~/.npm/_npx/<hash>/, which npm deletes whenever it feels like it. That
 * is a login item pointing at nothing, forever, on a machine where the user
 * never installed anything.
 *
 * AGENTS_DECK_NO_INSTALL is honoured the same way claude-swap and ccusage honour
 * it. A CI runner that quietly acquires login items is a CI runner nobody can
 * explain.
 */
export function shouldOfferService({ record = null, npx = false, env = process.env } = {}) {
  if (env.AGENTS_DECK_NO_INSTALL === "1") return false;
  if (npx) return false;
  return record === null;
}

/** Read what we did last time, or null when we have never touched this machine. */
export function readServiceRecord(dataDir, { fs = { readFileSync } } = {}) {
  try {
    const d = JSON.parse(fs.readFileSync(join(dataDir, SERVICE_RECORD), "utf8"));
    return d && typeof d === "object" ? d : null;
  } catch { return null; }
}

/** Write it. Never throws: a record we cannot keep means we may offer once more
 *  on this machine, which is a far smaller harm than refusing to start. */
export function writeServiceRecord(dataDir, record, { fs = { mkdirSync, writeFileSync } } = {}) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(dataDir, SERVICE_RECORD), JSON.stringify(record, null, 2) + "\n");
    return true;
  } catch { return false; }
}

/** The command that registers what was just written, per platform. Separate
 *  from the writing so the arguments can be asserted from any machine. */
export function registerCommand(platform, path) {
  if (platform === "darwin") {
    // `bootstrap` is the modern spelling and `load` the one that works on
    // everything back to 10.10. Failure is not fatal either way: the plist is on
    // disk and launchd reads it at the next login regardless.
    return { file: "launchctl", args: ["load", "-w", path] };
  }
  if (platform === "win32") {
    return { file: "schtasks", args: ["/Create", "/TN", SERVICE_LABEL, "/XML", path, "/F"] };
  }
  return { file: "systemctl", args: ["--user", "enable", "--now", `${SERVICE_LABEL}.service`] };
}

/** …and the one that takes it away again. */
export function unregisterCommand(platform, path) {
  if (platform === "darwin") return { file: "launchctl", args: ["unload", "-w", path] };
  if (platform === "win32") return { file: "schtasks", args: ["/Delete", "/TN", SERVICE_LABEL, "/F"] };
  return { file: "systemctl", args: ["--user", "disable", "--now", `${SERVICE_LABEL}.service`] };
}

/**
 * Does a systemd --user session survive logging out?
 *
 * Only with lingering enabled, and this is the one place where the three
 * platforms genuinely differ in what "starts at login" buys you. Without it the
 * user's systemd instance is torn down at logout and the deck goes with it —
 * which is fine on a laptop somebody stays logged into and wrong on a box they
 * ssh out of. Asked rather than assumed, and SAID rather than silently fixed:
 * `loginctl enable-linger` changes how the machine treats an account, and that
 * is not ours to decide on somebody's behalf.
 */
export function lingerState({ platform = process.platform, run = spawnSync, user = process.env.USER } = {}) {
  if (platform !== "linux") return "n/a";
  try {
    const out = run("loginctl", ["show-user", String(user ?? ""), "--property=Linger"], { encoding: "utf8" });
    if (out?.status !== 0) return "unknown";
    return /Linger=yes/i.test(String(out.stdout ?? "")) ? "on" : "off";
  } catch { return "unknown"; }
}

/**
 * Write the login item and register it.
 *
 * Returns a verdict rather than throwing. Nothing here is worth refusing to run
 * a deck over: the worst outcome of a failed install is the behaviour every
 * version before this one had.
 */
export function installService({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  execPath = process.execPath,
  script,
  logPath,
  args = ["--no-open"],
  // Extra variables for the JOB's environment, which is not this process's.
  //
  // A login item runs in the session the service manager builds, not in the
  // shell that installed it: launchd hands the job a minimal environment,
  // systemd --user the same. That is right in production — the deck should see
  // the user's real home — and it is exactly what makes a login item impossible
  // to test in a sandbox without this parameter. The end-to-end test passes
  // HOME and the deck's own directories through here; nothing else does.
  serviceEnv = {},
  product = "ccdeck",
  fs = { mkdirSync, writeFileSync },
  run = spawnSync,
} = {}) {
  const path = servicePath(platform, home, env);
  try {
    // BEFORE THE SERVICE MANAGER IS TOLD ANYTHING. launchd opens
    // StandardOutPath when it starts the job and systemd opens
    // `append:` when it starts the unit; neither creates a missing directory,
    // and both answer a missing one by failing the job silently. On a machine
    // where the deck has never run — which is every machine `--install-service`
    // is typed on first — that directory does not exist yet.
    fs.mkdirSync(logPathDir(logPath), { recursive: true });
    if (platform === "win32") {
      // The XML goes to a temp file beside the deck's own data rather than to
      // %TEMP%: schtasks reads it once and this way a machine that refuses the
      // import still has the file that was refused, next to everything else
      // this deck owns.
      const xmlPath = join(logPathDir(logPath), `${SERVICE_LABEL}-task.xml`);
      // UTF-16LE with a BOM: schtasks rejects UTF-8 with an unhelpful error.
      fs.writeFileSync(xmlPath, "\uFEFF" + taskXmlFor({ execPath, script, args, product }), "utf16le");
      const cmd = registerCommand(platform, xmlPath);
      const out = run(cmd.file, cmd.args, { encoding: "utf8", windowsHide: true });
      if (out?.status !== 0) {
        return { ok: false, path: SERVICE_LABEL, reason: oneLine(out?.stderr || out?.stdout) || "schtasks refused" };
      }
      return { ok: true, path: `Task Scheduler ${GLYPH_ARROW} ${SERVICE_LABEL}`, how: "schtasks" };
    }

    const body = platform === "darwin"
      ? plistFor({ execPath, script, logPath, args, env: serviceEnv })
      : unitFor({ execPath, script, logPath, args, env: serviceEnv, product });
    fs.mkdirSync(dirOf(path), { recursive: true });
    fs.writeFileSync(path, body, { mode: 0o644 });
    const cmd = registerCommand(platform, path);
    const out = run(cmd.file, cmd.args, { encoding: "utf8" });
    // A registration that failed still leaves the file, and both launchd and
    // systemd read their directories at the next login — so the service works
    // from then on either way. Said, not hidden, and not treated as fatal.
    if (out?.status !== 0) {
      return { ok: true, path, how: "file-only", reason: oneLine(out?.stderr || out?.stdout) || `${cmd.file} refused` };
    }
    return { ok: true, path, how: cmd.file };
  } catch (err) {
    return { ok: false, path, reason: err?.code ?? String(err?.message ?? err) };
  }
}

/** Take it away. Same contract: a verdict, never a throw. */
export function uninstallService({
  platform = process.platform,
  home = homedir(),
  env = process.env,
  fs = { rmSync },
  run = spawnSync,
} = {}) {
  const path = servicePath(platform, home, env);
  const cmd = unregisterCommand(platform, path);
  let out = null;
  try { out = run(cmd.file, cmd.args, { encoding: "utf8", windowsHide: true }); } catch { /* reported below */ }
  if (platform === "win32") {
    if (out?.status === 0) return { ok: true, path: SERVICE_LABEL };
    return { ok: false, path: SERVICE_LABEL, reason: oneLine(out?.stderr || out?.stdout) || "schtasks refused" };
  }
  // The FILE is what makes it start at login, so removing it is the part that
  // actually uninstalls. The unregister above only stops the copy running now.
  try { fs.rmSync(path, { force: true }); } catch (err) {
    return { ok: false, path, reason: err?.code ?? "could not remove" };
  }
  return { ok: true, path };
}

const GLYPH_ARROW = "\u2192";
const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")));
const logPathDir = (p) => dirOf(String(p ?? ""));
/** First line, trimmed — a refusal from schtasks is a paragraph and a row is a
 *  row. */
const oneLine = (s) => String(s ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] ?? "";
