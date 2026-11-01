// Signing a Codex profile in from the deck, without a terminal.
//
// `codex login --device-auth` prints a link and a one-time code, then waits for
// the person to approve it in any browser, on any machine, and writes the login
// into the home it was started for. That fits a dialog: the deck starts it for
// one profile's own home, shows the link and the code, and watches the process.
// The deck never sees the credential: Codex writes it where Codex keeps it.
//
// One sign-in per profile at a time, and nothing starts until asked. A browser
// that cannot reach the machine is no problem, since the code is typed on the
// page rather than sent back to a local port.
import { spawn } from 'node:child_process';
import { forgetCodexReadings } from './codex-native-account.mjs';
import { resolveCodexProfile } from './codex-profiles.mjs';

/** Codex says the code lasts 15 minutes; the process is stopped a minute later. */
const LIFETIME_MS = 16 * 60_000;
/** A finished sign-in's answer stays readable this long, then the entry goes. */
const KEEP_MS = 10 * 60_000;
const MAX_OUTPUT = 8192;

const logins = new Map();

/** Strip terminal colour and cursor codes from what Codex prints. */
const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

/** The link and the code out of what `codex login --device-auth` prints. Only an
 *  OpenAI sign-in page is ever returned as a link: the dialog turns it into a
 *  button, and a line of output is not trusted to say where that button goes. */
export function parseDeviceLogin(output) {
  const text = plain(String(output));
  const url = text.match(/https:\/\/auth\.openai\.com\/[^\s]*/)?.[0] ?? null;
  const code = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/)?.[1] ?? null;
  return { url, code };
}

function view(entry) {
  return entry
    ? { ok: true, state: entry.state, url: entry.url, code: entry.code, expiresAt: entry.expiresAt, reason: entry.reason ?? null }
    : { ok: true, state: 'idle', url: null, code: null, expiresAt: null, reason: null };
}

/** Start a sign-in for one profile, or return the one already running. */
export async function startCodexLogin(id, options = {}) {
  const directory = await resolveCodexProfile(id, options);
  if (!directory) return { ok: false, reason: 'unknown_profile' };
  const running = logins.get(id);
  if (running && ['starting', 'waiting'].includes(running.state)) return view(running);

  const entry = { state: 'starting', url: null, code: null, expiresAt: null, reason: null, output: '', child: null, timer: null };
  logins.set(id, entry);
  const finish = (state, reason = null) => {
    if (['done', 'failed', 'cancelled', 'expired'].includes(entry.state)) return;
    entry.state = state;
    entry.reason = reason;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { if (logins.get(id) === entry) logins.delete(id); }, KEEP_MS);
    entry.timer.unref?.();
  };
  let child;
  try {
    child = (options.spawn ?? spawn)(options.command ?? 'codex', ['login', '--device-auth'], {
      env: { ...(options.env ?? process.env), CODEX_HOME: directory, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: (options.platform ?? process.platform) === 'win32',
      windowsHide: true,
    });
  } catch { finish('failed', 'codex_missing'); return view(entry); }
  entry.child = child;
  const onData = chunk => {
    entry.output = (entry.output + chunk.toString()).slice(-MAX_OUTPUT);
    if (entry.state !== 'starting') return;
    const { url, code } = parseDeviceLogin(entry.output);
    if (url && code) {
      entry.url = url;
      entry.code = code;
      entry.state = 'waiting';
      entry.expiresAt = Date.now() + 15 * 60_000;
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.once('error', error => finish('failed', error?.code === 'ENOENT' ? 'codex_missing' : 'login_failed'));
  child.once('close', code => {
    if (entry.state === 'cancelled') return;
    // "Done" waits for the old login's readings to go, so nothing reads them first.
    if (code === 0) void forgetCodexReadings(directory).catch(() => {}).finally(() => finish('done'));
    else finish('failed', entry.state === 'starting' ? 'no_code' : 'login_failed');
  });
  entry.timer = setTimeout(() => {
    if (['starting', 'waiting'].includes(entry.state)) { finish('expired', 'code_expired'); child.kill(); }
  }, options.lifetimeMs ?? LIFETIME_MS);
  entry.timer.unref?.();
  return view(entry);
}

export function codexLoginState(id) {
  return view(logins.get(id));
}

/** Stop a sign-in that is still waiting, so closing the dialog leaves no process. */
export function cancelCodexLogin(id) {
  const entry = logins.get(id);
  if (!entry || !['starting', 'waiting'].includes(entry.state)) return view(entry);
  entry.state = 'cancelled';
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { if (logins.get(id) === entry) logins.delete(id); }, KEEP_MS);
  entry.timer.unref?.();
  try { entry.child?.kill(); } catch { /* already gone */ }
  return view(entry);
}

/** For tests: forget every sign-in and stop the ones still running. */
export function resetCodexLogins() {
  for (const entry of logins.values()) { clearTimeout(entry.timer); try { entry.child?.kill(); } catch { /* gone */ } }
  logins.clear();
}
