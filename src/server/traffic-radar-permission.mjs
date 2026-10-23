// Packet capture is the one thing Telemetry Radar needs that a person cannot
// grant from inside ccdeck: macOS and Linux keep it for administrators. Allow
// capture asks for the password once, through the system's own prompt, and
// sets capture up for good, so monitoring, which is always on, starts by
// itself afterwards:
//
//  - macOS: a LaunchDaemon of ccdeck's own does at every startup what
//    Wireshark's ChmodBPF does: it makes the BPF devices and lets the
//    access_bpf group read and write them, and the person joins that group.
//    A new group reaches a person's processes only after they log in again, so
//    this boot's devices are also handed to them directly and capture starts now.
//  - Linux: tcpdump, installed by the system's package manager when missing,
//    may capture (cap_net_raw, cap_net_admin) and may be run by the person's
//    own group only: a group they already have, so it applies now. A tcpdump
//    update replaces the file and drops this; Radar then asks again.
//
// Windows has no such step: Npcap's free edition may not be installed by
// another program, so the person installs Wireshark with Npcap themselves.
//
// Where no prompt can open (a deck reached over SSH, a Linux desktop with no
// polkit agent) the same script is written to the deck's folder and the answer
// names the one command that runs it.
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.mjs';

export const OSASCRIPT = '/usr/bin/osascript';
export const PKEXEC = 'pkexec';
export const LAUNCH_LABEL = 'dev.ccdeck.chmodbpf';
const HELPER = '/Library/Application Support/ccdeck/ccdeck-chmodbpf';
const PLIST = `/Library/LaunchDaemons/${LAUNCH_LABEL}.plist`;
/** Long enough for a person to find and type their password. */
const PROMPT_TIMEOUT_MS = 5 * 60_000;
const PROMPT = 'ccdeck needs your password once so Telemetry Radar can read the telemetry Claude Code sends to its collector.';
/** osascript's "User canceled.", and its "No user interaction allowed." where no one is logged in to answer. */
const CANCELLED = /\(-128\)/;
const NO_SESSION = /\(-1713\)|no user interaction/i;

/** A login name safe to write into a root script inside single quotes. */
export const validUser = name => typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name);

/** Run as root on macOS. Every value in it is a constant but `user`, checked by validUser. */
export function macosScript(user) {
  if (!validUser(user)) throw new Error('Unexpected user name.');
  return `set -e
user='${user}'
mkdir -p '/Library/Application Support/ccdeck'
cat > '${HELPER}' <<'CCDECK_HELPER'
#!/bin/sh
# ccdeck: lets the access_bpf group capture packets for Telemetry Radar, as
# Wireshark's ChmodBPF does. macOS makes BPF devices on demand, owned by root,
# and opening the last one makes the next, so all exist before their group is set.
max=$(sysctl -n debug.bpf_maxdevices 2>/dev/null || echo 256)
[ "$max" -le 256 ] 2>/dev/null || max=256
i=0
while [ "$i" -lt "$max" ]; do true 2>/dev/null < "/dev/bpf$i"; i=$((i + 1)); done
chgrp access_bpf /dev/bpf*
chmod g+rw /dev/bpf*
CCDECK_HELPER
cat > '${PLIST}' <<'CCDECK_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>Program</key><string>${HELPER}</string>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
CCDECK_PLIST
chown root:wheel '${HELPER}' '${PLIST}'
chmod 755 '${HELPER}'
chmod 644 '${PLIST}'
dseditgroup -q -o read access_bpf >/dev/null 2>&1 || dseditgroup -q -o create access_bpf
dseditgroup -q -o edit -a "$user" -t user access_bpf
launchctl bootout system/${LAUNCH_LABEL} >/dev/null 2>&1 || true
launchctl bootstrap system '${PLIST}'
'${HELPER}'
chown "$user" /dev/bpf*
`;
}

/** Run as root on Linux, by pkexec, whose PATH has the sbin folders. `gid` is the person's own group. */
export function linuxScript(gid) {
  if (!Number.isInteger(gid) || gid <= 0) throw new Error('Unexpected group.');
  return `set -e
found() { for t in "$(command -v tcpdump 2>/dev/null)" /usr/sbin/tcpdump /usr/bin/tcpdump /sbin/tcpdump; do if [ -n "$t" ] && [ -x "$t" ]; then echo "$t"; return 0; fi; done; return 1; }
install() {
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y "$1" || { apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y "$1"; }
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "$2"
  elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install "$3"
  elif command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed "$4"
  else echo "ccdeck: no supported package manager. Install $1, then allow capture again." >&2; exit 4
  fi
}
found >/dev/null || install tcpdump tcpdump tcpdump tcpdump
command -v setcap >/dev/null 2>&1 || install libcap2-bin libcap libcap-progs libcap
tool=$(readlink -f "$(found)")
chgrp ${gid} "$tool"
chmod 0750 "$tool"
setcap cap_net_raw,cap_net_admin=eip "$tool"
`;
}

/** The script, written where its owner can read it, and the command that runs it. */
async function handOver(script, directory) {
  const file = join(directory, 'radar-capture-setup.sh');
  await mkdir(directory, { recursive: true });
  await writeFile(file, script, { mode: 0o600 });
  return `sudo sh '${file.replaceAll("'", "'\\''")}'`;
}

/** The last line a failed script said, for the person: a package manager's own words. */
const lastLine = text => String(text ?? '').trim().split('\n').filter(Boolean).pop()?.slice(0, 300) ?? '';

let inFlight = null;

/**
 * Ask the system for capture permission, once. Answers one of:
 *   granted       the script ran as root; capture can start now
 *   cancelled     the person closed the password prompt; nothing changed
 *   unavailable   no prompt can open here; `command` runs the same script
 *   failed        the script ran and stopped; `message` says why, `command` retries it
 * Windows, and anything else, answer unavailable with no command.
 */
export function askCapturePermission(deps = {}) {
  if (!inFlight) inFlight = ask(deps).finally(() => { inFlight = null; });
  return inFlight;
}

async function ask({ platform = process.platform, env = process.env, user = userInfo(), exec = run, directory = join(homedir(), '.agents-deck') } = {}) {
  if (platform === 'darwin') {
    if (!validUser(user.username) || user.uid === 0) return { outcome: 'unavailable', message: 'Capture permission is set up for a signed-in user.' };
    const script = macosScript(user.username);
    const r = await exec(OSASCRIPT, ['-e', 'on run argv\ndo shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges\nend run', '--', script, PROMPT], { timeout: PROMPT_TIMEOUT_MS });
    if (r.ok) return { outcome: 'granted' };
    if (CANCELLED.test(r.stderr ?? '')) return { outcome: 'cancelled' };
    const command = await handOver(script, directory);
    if (r.timedOut) return { outcome: 'failed', message: 'Nobody answered the password prompt.', command };
    if (NO_SESSION.test(r.stderr ?? '')) return { outcome: 'unavailable', message: 'No password prompt can open in this session.', command };
    return { outcome: 'failed', message: `macOS refused: ${lastLine(r.stderr) || 'the setup did not finish'}.`, command };
  }
  if (platform === 'linux') {
    if (!Number.isInteger(user.gid) || user.gid <= 0 || user.uid === 0) return { outcome: 'unavailable', message: 'Capture permission is set up for a signed-in user.' };
    const script = linuxScript(user.gid);
    // A desktop session is where pkexec's agent draws its prompt; over SSH,
    // pkexec would fall back to asking on a terminal nobody is looking at.
    if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { outcome: 'unavailable', message: 'No password prompt can open in this session.', command: await handOver(script, directory) };
    const r = await exec(PKEXEC, ['/bin/sh', '-c', script], { timeout: PROMPT_TIMEOUT_MS });
    if (r.ok) return { outcome: 'granted' };
    // pkexec: 126 is a dismissed prompt, 127 one that could not be shown or was refused.
    if (r.code === 126) return { outcome: 'cancelled' };
    const command = await handOver(script, directory);
    if (r.code === 'ENOENT' || /authentication agent/i.test(r.stderr ?? '')) return { outcome: 'unavailable', message: 'No password prompt can open in this session.', command };
    if (r.timedOut) return { outcome: 'failed', message: 'Nobody answered the password prompt.', command };
    if (r.code === 127) return { outcome: 'failed', message: 'The password was not accepted.', command };
    return { outcome: 'failed', message: `The setup stopped: ${lastLine(r.stderr) || `exit ${r.code}`}.`, command };
  }
  return { outcome: 'unavailable', message: 'Install Wireshark with Npcap to allow packet capture.' };
}
