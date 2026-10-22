// Continuing a background session whose turn stopped on an expired login or a
// usage limit (#2193), by a press of Continue or, when the user has switched
// it on, by itself once a working login is active again.
//
// WHAT IS RUN, AND WHY IT IS THAT. Claude Code has no command that hands a
// message to a background session from a script. Agent view's reply and
// `claude attach` both need a terminal, and `claude --resume <id> "prompt"`
// sends the prompt to a running background session only from one: with piped
// output it "sends nothing and exits with status 1" (code.claude.com/docs/en/
// sessions, "Resume a running background session"). What it does document,
// for exactly this case, is the pair: "To continue the conversation itself in
// a session of your own … run `claude stop <id>` and then repeat the command",
// and `claude --resume <session-id> --bg "<prompt>"`, which "continues that
// session under the same ID, or starts a copy under a new ID and prints a
// `note:` line" (code.claude.com/docs/en/agent-view, "Dispatch an agent from
// your shell"; v2.1.257 and later). So a continue is, in order:
//
//   claude agents --json --all      which session this is, whether its process
//                                   is alive, and what it is doing — the
//                                   documented reader of that state
//   claude stop <id>                only when its process is alive and idle
//   claude agents --json --all      until Claude Code no longer lists a live
//                                   process for it; nothing is sent otherwise
//   claude --resume <session> --bg "Continue from where you left off."
//                                   in the session's own directory
//
// NEVER A SECOND PROCESS ON ONE SESSION. The resume is run only once Claude
// Code itself reports no live process for the session, and Claude Code's own
// rule for a session that is still running is to start a copy rather than a
// second process beside it — which the `note:` line says, and the deck reports.
// A session that is busy, waiting on a permission prompt or a dialog, or
// between steps of work it drives itself (`working`) is left alone.
//
// An interactive session in a terminal is never touched: the deck cannot type
// into it, and the page says to type "continue" there instead.
//
// NOT AS A CHILD OF ANOTHER SESSION. A deck started from a Claude Code
// session's Bash tool carries that session's markers in its environment
// (CLAUDE_CODE_CHILD_SESSION, CLAUDE_JOB_DIR, its messaging socket …), and a
// `claude` that inherits them is that session's nested child: Claude Code
// leaves such a session out of `claude agents` and `--resume`, and its job
// folder is somebody else's (code.claude.com/docs/en/env-vars). So the three
// commands run with those markers taken out, and with everything else — the
// config dir, the provider, the PATH — as the deck has it.
//
// THE AUTOMATIC HALF is off until the user turns it on (prefs `continueStopped`).
// With it on, each stop that a hook posted to this process live is continued
// at most once, only once the gate in stop-continue-gate.mjs says a working
// login with room is active, only for a session Claude Code itself lists as
// background and blocked or failed, and never again for a session that stops
// again within REPEAT_HOLD_MS of being continued, until somebody acts on it.
// Across all sessions there is a cap per window and a pause after failures in
// a row. `/api/event` takes a post without the deck's token, so a stop is
// never enough on its own: what Claude Code lists is what decides.
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run } from "./exec.mjs";
import { adminClaudeBin } from "./claude-identity.mjs";
import { stopFailureOf, switchCanCure } from "./stop-failure.mjs";
import { CONTINUE_PROMPT, REPEAT_HOLD_MS, continueGate, loginEvidence } from "./stop-continue-gate.mjs";
import { heldPrefs } from "./prefs-state.mjs";
import { readBody, send } from "./http-io.mjs";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A Claude Code session id: a UUID, and so never shaped like a flag. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A background session's short id, as `claude agents --json` prints it.
 *  Never with a leading dash, so it can only be read as the id. */
export const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** What a Claude Code session sets in the environment of what it spawns,
 *  saying "a child of THIS session": the four the env-vars reference names,
 *  and the per-session ones beside them on 2.1.303 (its messaging socket and
 *  token, its pid, its entry point, its binary and its effort). */
export const SESSION_MARKERS = Object.freeze([
  "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_JOB_DIR",
  "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID",
  "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_EFFORT",
]);

/** The environment the continue's commands run in: the deck's own, without
 *  another session's markers — see the header. Matched without regard to
 *  case, the way Windows reads its environment. */
export function continueEnv(env = process.env) {
  const drop = new Set(SESSION_MARKERS);
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!drop.has(k.toUpperCase()) && v !== undefined) out[k] = v;
  return out;
}

/** The documented reader of background-session state, completed ones too. */
export function agentsArgv() {
  return ["agents", "--json", "--all"];
}

/** `claude stop <id>`, or null for an id that is not one. */
export function stopArgv(jobId) {
  return typeof jobId === "string" && JOB_ID_RE.test(jobId) ? ["stop", jobId] : null;
}

/** `claude --resume <session> --bg "Continue from where you left off."`, or
 *  null for a session id that is not one. The prompt is the positional
 *  argument: `--bg` refuses `-p`. */
export function resumeArgv(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId)
    ? ["--resume", sessionId, "--bg", CONTINUE_PROMPT]
    : null;
}

/** `claude agents --json` prints a JSON array; take it out of anything printed
 *  around it, such as `Starting background service…`. */
function jsonArray(text) {
  const s = String(text ?? "");
  try { const v = JSON.parse(s); if (Array.isArray(v)) return v; } catch { /* below */ }
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a < 0 || b <= a) return null;
  try { const v = JSON.parse(s.slice(a, b + 1)); return Array.isArray(v) ? v : null; } catch { return null; }
}

const STATUSES = new Set(["busy", "waiting", "idle"]);

/**
 * What `claude agents --json --all` says about one session: `{ entry }` with
 * the fields the plan reads, `{ entry: null }` when it lists nothing for it,
 * or `{ entry: undefined }` when the output was not a list at all. Every field
 * is checked: these are Claude Code's words, and the plan acts on them.
 */
export function agentEntryOf(stdout, sessionId) {
  const list = jsonArray(stdout);
  if (!list) return { entry: undefined };
  const mine = list.filter(e => e && typeof e === "object" && e.sessionId === sessionId);
  if (!mine.length) return { entry: null };
  const e = mine.find(x => x.kind === "background") ?? mine[0];
  return {
    entry: {
      kind: e.kind === "background" ? "background" : e.kind === "interactive" ? "interactive" : "unknown",
      id: typeof e.id === "string" && JOB_ID_RE.test(e.id) ? e.id : null,
      state: typeof e.state === "string" ? e.state : null,
      // `pid` and `status` are there while the process is alive (agent view's
      // "List sessions as JSON").
      alive: Number.isInteger(e.pid) && e.pid > 0,
      status: STATUSES.has(e.status) ? e.status : null,
      cwd: typeof e.cwd === "string" ? e.cwd : null,
    },
  };
}

/**
 * What a continue would do with that entry: `{ id, stopFirst }`, or
 * `{ refuse }` with why not. `auto` asks the stricter question the automatic
 * continue asks: Claude Code must itself say the session is held up, which a
 * session that finished its turn (`done`) is not.
 */
export function continuePlan(entry, { auto = false } = {}) {
  if (entry === undefined) return { refuse: "unreadable" };
  if (!entry) return { refuse: "not_listed" };
  if (entry.kind !== "background") return { refuse: "interactive" };
  if (!entry.id) return { refuse: "not_listed" };
  if (entry.state === "working" || (entry.alive && entry.status === "busy")) return { refuse: "working" };
  // A live process that is not idle is waiting on something only a person can
  // answer — a permission prompt, a dialog — and stopping it would drop that.
  if (entry.alive && entry.status !== "idle") return { refuse: "waiting" };
  if (auto && entry.state !== "blocked" && entry.state !== "failed") return { refuse: "not_held" };
  return { id: entry.id, stopFirst: entry.alive };
}

/** Claude Code's `note:` line, when the resume started a copy instead. */
export function copyNote(text) {
  const m = /^\s*note:\s*(.+)$/im.exec(stripAnsi(text));
  return m ? oneLine(m[1]) : null;
}

const DETAIL_MAX = 240;

function stripAnsi(text) {
  return String(text ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "");
}

/** One line of what a command said, short, with anything shaped like a
 *  credential masked: it is drawn on a card. */
function oneLine(text) {
  const t = stripAnsi(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 …")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > DETAIL_MAX ? `${t.slice(0, DETAIL_MAX - 1).trimEnd()}…` : t;
}

/** What a failed run said: stderr when it wrote any, else stdout, else how it
 *  ended. */
function said(r) {
  const text = oneLine(r?.stderr || r?.stdout || "");
  if (text) return text;
  if (r?.timedOut) return "timed out";
  if (r?.code === "ENOENT") return "the claude CLI could not be run";
  return `exited ${r?.code ?? "?"}`;
}

/** A directory that is there, or null. */
function usableDir(p) {
  if (typeof p !== "string" || !p || !isAbsolute(p)) return null;
  try { return statSync(p).isDirectory() ? p : null; } catch { return null; }
}

/** The automatic continue's limits. A window's cap, so a whole machine of
 *  sessions stopped at once cannot become a burst of Claude Code processes,
 *  and a pause after failures in a row, so a CLI that cannot do this is not
 *  asked again every minute. */
export const AUTO_CAP = 6;
export const AUTO_WINDOW_MS = 10 * 60_000;
export const FAIL_STREAK = 3;
export const FAIL_PAUSE_MS = 30 * 60_000;
/** How often the automatic continue looks again while a stop is waiting for a
 *  working login. The reading it asks for is cached and floored (quota.mjs),
 *  so this costs a file read or nothing on most passes. */
export const AUTO_EVERY_MS = 60_000;
/** How long a continue's outcome stays on its card. */
export const LAST_KEEP_MS = 6 * 60 * 60_000;
/** How many sessions this keeps anything for. `/api/event` takes a post
 *  without the deck's token, so this is bounded like every set it feeds. */
export const MAX_RECORDS = 256;
/** How many times, a second apart, a stopped session's process is looked for
 *  before the resume is given up. */
export const STOP_POLLS = 10;
/** How long a stop is worth continuing at all: Claude Code's own bound for
 *  continuing a turn that ended on an API error by itself (code.claude.com/
 *  docs/en/env-vars, CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS). Older,
 *  the automatic continue leaves it, and nothing keeps looking for it. */
export const STOP_KEEP_MS = 6 * 60 * 60_000;
/** How many passes a stop Claude Code does not yet call held up — its state
 *  not written yet, a prompt open in it — is looked at again before the
 *  automatic continue leaves it. */
export const NOT_NOW_LOOKS = 5;
/** The answers that mean "not now" rather than "no": nothing was run. */
const NOT_NOW = new Set(["not_held", "working", "waiting"]);

const STOP_KINDS = new Set(["login", "usage-limit", "api-error"]);

/** A stop the page says it is continuing, when this process never saw it — a
 *  deck restarted since. Only its kind and time are taken. */
function claimedStop(raw) {
  if (!raw || typeof raw !== "object" || !STOP_KINDS.has(raw.kind)) return null;
  const at = Number(raw.at);
  return Number.isFinite(at) && at > 0 ? { kind: raw.kind, at } : null;
}

const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

/**
 * The continuer, with everything that reaches outside injected:
 *
 *   run(bin, args, opts)  exec.mjs's `run`
 *   bin()                 which `claude` to run (claude-identity.mjs)
 *   login({ force })      the gate's evidence (stop-continue-gate.mjs
 *                         loginEvidence of the newest quota reading)
 *   autoOn()              the setting, asked per pass
 *   environ()             the deck's environment, which continueEnv cleans
 *   now, sleep, every     the clock, a pause between polls, and the interval
 *
 * Every method answers rather than throws.
 */
export function createStopContinuer({
  run: exec, bin, login, autoOn = () => false, environ = () => process.env,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)),
  every = (fn, ms) => { const t = setInterval(fn, ms); t.unref?.(); return t; },
  cancel = t => clearInterval(t),
} = {}) {
  /** sid -> { stop, cwd, held, tried, autoAt, actedAt, last, touched } */
  const records = new Map();
  const inFlight = new Map();
  const autoRuns = [];
  let failStreak = 0;
  let pausedUntil = 0;
  let passing = false;
  let forceNext = false;
  let timer = null;

  const record = sid => {
    let r = records.get(sid);
    if (!r) {
      r = { stop: null, cwd: null, held: false, tried: false, looks: 0, autoAt: 0, actedAt: 0, last: null, touched: 0 };
      records.set(sid, r);
      if (records.size > MAX_RECORDS) {
        const oldest = [...records].sort((a, b) => a[1].touched - b[1].touched)[0];
        if (oldest && oldest[0] !== sid) records.delete(oldest[0]);
      }
    }
    r.touched = now();
    return r;
  };

  /** A stop the automatic continue may still act on. */
  const pending = (r, t) => r.stop && switchCanCure(r.stop.kind) && !r.tried && !r.held && t - r.stop.at < STOP_KEEP_MS;
  const waiting = () => { const t = now(); return [...records.values()].some(r => pending(r, t)); };

  /** The interval runs while a stop is waiting for a login, and only then. */
  const arm = () => {
    if (waiting()) { if (!timer) timer = every(() => { void consider(); }, AUTO_EVERY_MS); }
    else if (timer) { cancel(timer); timer = null; }
  };

  /**
   * A hook event, as pushEvent takes it in from a live hook post. A
   * StopFailure records the stop; anything that shows the session working
   * again — its next prompt, a tool call of the root's own, a Stop, a new
   * start — takes the stop down, the rule the page applies to its card
   * (session-lifecycle.ts). A typed prompt that is not the deck's own continue
   * is somebody acting on the session, which is what lifts the repeat hold.
   */
  function noteEvent(raw, at = now()) {
    try {
      const sid = raw?.session_id;
      if (typeof sid !== "string" || !SESSION_ID_RE.test(sid)) return;
      const name = raw.hook_event_name;
      const stop = stopFailureOf(raw, at);
      if (stop) {
        const r = record(sid);
        r.stop = { kind: stop.kind, error: stop.error, at };
        r.cwd = typeof raw.cwd === "string" ? raw.cwd : r.cwd;
        r.tried = false;
        r.looks = 0;
        r.held = r.autoAt > 0 && r.actedAt <= r.autoAt && at - r.autoAt < REPEAT_HOLD_MS;
        arm();
        return;
      }
      const r = records.get(sid);
      if (!r) return;
      if (name === "UserPromptSubmit" && typeof raw.prompt === "string" && raw.prompt.trim() !== CONTINUE_PROMPT) {
        r.actedAt = Math.max(r.actedAt, at);
      }
      const resumes = name === "UserPromptSubmit" || name === "Stop" || name === "SessionStart"
        || (TOOL_EVENTS.has(name) && !raw.agent_id);
      if (resumes && r.stop && at > r.stop.at) { r.stop = null; arm(); }
    } catch { /* never the ingest path's problem */ }
  }

  /** What the page reads: the setting, the gate's evidence when asked for,
   *  and each session's stop and the last continue's outcome. */
  async function status({ withLogin = false } = {}) {
    const t = now();
    const sessions = {};
    for (const [sid, r] of records) {
      const last = r.last && t - r.last.at < LAST_KEEP_MS ? r.last : null;
      if (!r.stop && !last) continue;
      sessions[sid] = { stop: r.stop ? { kind: r.stop.kind, at: r.stop.at } : null, held: r.held, tried: r.tried, last };
    }
    let evidence = null;
    if (withLogin) { try { evidence = await login({}); } catch { evidence = null; } }
    return { ok: true, auto: autoOn() === true, login: evidence, sessions };
  }

  /** The continue itself, for one session — see the header. */
  async function continueBackground(sid, cwdHint, { auto }) {
    const claude = bin();
    const env = continueEnv(environ());
    const listed = await exec(claude, agentsArgv(), { timeout: 20_000, env });
    if (!listed.ok) return { ok: false, reason: "cli_failed", detail: said(listed) };
    const { entry } = agentEntryOf(listed.stdout, sid);
    const plan = continuePlan(entry, { auto });
    if (plan.refuse) return { ok: false, reason: plan.refuse };
    const cwd = usableDir(entry.cwd) ?? usableDir(cwdHint);
    if (!cwd) return { ok: false, reason: "no_dir" };
    if (plan.stopFirst) {
      const stopped = await exec(claude, stopArgv(plan.id), { timeout: 30_000, env });
      if (!stopped.ok) return { ok: false, reason: "stop_failed", detail: said(stopped) };
      let gone = false;
      for (let i = 0; i < STOP_POLLS && !gone; i++) {
        if (i > 0) await sleep(1_000);
        const again = await exec(claude, agentsArgv(), { timeout: 20_000, env });
        const e = again.ok ? agentEntryOf(again.stdout, sid).entry : undefined;
        gone = e === null || (e !== undefined && !e.alive);
      }
      if (!gone) return { ok: false, reason: "still_running" };
    }
    const resumed = await exec(claude, resumeArgv(sid), { timeout: 90_000, cwd, env });
    // Said with whether the deck stopped the session first: if it did, the
    // session is now stopped, its conversation kept, and agent view or
    // `claude attach` starts it again.
    if (!resumed.ok) return { ok: false, reason: "resume_failed", detail: said(resumed), stopped: plan.stopFirst };
    const note = copyNote(`${resumed.stdout}\n${resumed.stderr}`);
    return note ? { ok: true, outcome: "copied", detail: note } : { ok: true, outcome: "continued" };
  }

  /** One continue, never two at once for one session. */
  function runOnce(sid, cwdHint, opts) {
    if (inFlight.has(sid)) return Promise.resolve({ ok: false, reason: "busy" });
    const p = continueBackground(sid, cwdHint, opts)
      .catch(err => ({ ok: false, reason: "cli_failed", detail: oneLine(err?.message ?? "") }))
      .finally(() => inFlight.delete(sid));
    inFlight.set(sid, p);
    return p;
  }

  const keep = (r, out, auto) => {
    r.last = {
      at: now(), auto, ok: out.ok === true, outcome: out.outcome ?? null, reason: out.reason ?? null,
      detail: out.detail ?? "", stopped: out.stopped === true,
    };
  };

  /**
   * A press of Continue: `claimed` is the stop the page drew, which stands in
   * for one this process never saw (a deck restarted since). The gate is asked
   * here too — the page drew the button from the same rule, and this is the
   * one that decides.
   */
  async function press(sid, claimed) {
    try {
      if (typeof sid !== "string" || !SESSION_ID_RE.test(sid)) return { ok: false, reason: "bad_request" };
      const known = records.get(sid)?.stop ?? null;
      const stop = known ?? claimedStop(claimed);
      if (!stop) return { ok: false, reason: "bad_request" };
      const gate = continueGate(stop, await login({}).catch(() => null));
      if (!gate.ready) return { ok: false, reason: "not_ready", gate: gate.reason };
      const r = record(sid);
      // Pressing is somebody acting on the session: a hold the automatic
      // continue left on it is lifted.
      r.actedAt = now();
      r.held = false;
      const out = await runOnce(sid, r.cwd, { auto: false });
      // A press that ran is this stop's go, whatever came of it: one that
      // failed is the user's to look at, not the automatic continue's to repeat.
      if (out.reason !== "busy") { keep(r, out, false); r.tried = true; }
      arm();
      return out;
    } catch {
      return { ok: false, reason: "cli_failed" };
    }
  }

  const capAllows = t => {
    while (autoRuns.length && t - autoRuns[0] >= AUTO_WINDOW_MS) autoRuns.shift();
    return autoRuns.length < AUTO_CAP;
  };

  /**
   * One pass of the automatic continue. Off, it does nothing; on, it reads the
   * gate's evidence once and continues every stop it clears, each once, one at
   * a time, inside the cap. A pass that starts while one runs does nothing.
   */
  async function consider() {
    if (passing) return;
    passing = true;
    try {
      if (autoOn() !== true || !waiting() || now() < pausedUntil) return;
      const force = forceNext;
      forceNext = false;
      const evidence = await login({ force }).catch(() => null);
      for (const [sid, r] of records) {
        if (!pending(r, now()) || !continueGate(r.stop, evidence).ready) continue;
        if (autoOn() !== true || !capAllows(now())) break;
        r.tried = true;
        const out = await runOnce(sid, r.cwd, { auto: true });
        if (out.reason === "busy") { r.tried = false; continue; }
        // Not now: Claude Code does not call the session held up yet, or it is
        // busy or waiting on a person. Looked at again a few passes, then left.
        if (NOT_NOW.has(out.reason)) { r.tried = ++r.looks >= NOT_NOW_LOOKS; continue; }
        // Not a background session at all: nothing was done, nothing goes on
        // the card, and nothing is counted.
        if (out.reason === "interactive" || out.reason === "not_listed") continue;
        autoRuns.push(now());
        r.autoAt = now();
        keep(r, out, true);
        if (out.ok) failStreak = 0;
        else if (++failStreak >= FAIL_STREAK) { pausedUntil = now() + FAIL_PAUSE_MS; failStreak = 0; break; }
      }
    } catch { /* a pass reports through each session's outcome */ } finally {
      passing = false;
      arm();
    }
  }

  /** An auto-switch tick finished. One that moved the account is the moment a
   *  working login most likely came back, so the next pass asks for a fresh
   *  reading rather than the cached one, and runs now. */
  function noteTick(result) {
    try {
      if (!result || !waiting()) return;
      if (result.switched) forceNext = true;
      void consider();
    } catch { /* never the tick's problem */ }
  }

  return {
    noteEvent, noteTick, status, press, consider,
    /** For the suite. */
    records: () => records,
    pausedUntil: () => pausedUntil,
    armed: () => timer != null,
  };
}

/** The gate's evidence on this machine: the newest quota reading, asked for
 *  through the panel's own cache and floors, and never waited on longer than
 *  the route waits (quota.mjs QUOTA_DEADLINE_MS). */
async function readLogin({ force = false } = {}) {
  const { fetchClaudeQuota, QUOTA_DEADLINE_MS } = await import(
    pathToFileURL(join(PKG_ROOT, "src/server/quota.mjs")).href
  );
  return loginEvidence(await fetchClaudeQuota({ force, deadlineMs: QUOTA_DEADLINE_MS }));
}

const continuer = createStopContinuer({
  run,
  bin: () => adminClaudeBin(),
  login: readLogin,
  autoOn: () => heldPrefs.current().continueStopped === true,
});

/** pushEvent's door, for a live hook post. Returns at once; never throws. */
export function noteStopContinue(raw, at) {
  continuer.noteEvent(raw, at);
}

/** The auto-switch loop's door, after every tick. Never throws. */
export function noteContinueTick(result) {
  continuer.noteTick(result);
}

/** The settings route's door: the switch was just turned on, so a stop
 *  already waiting is looked at now rather than at the next pass. */
export function noteContinueSwitchedOn() {
  void continuer.consider();
}

/** GET /api/stop-continue — `?login=1` adds the gate's evidence. */
export async function handleStopContinueRead(req, res) {
  const url = new URL(req.url, "http://localhost");
  send(res, 200, await continuer.status({ withLogin: url.searchParams.get("login") === "1" }));
}

/** POST /api/stop-continue — `{ sessionId, stop: { kind, at } }`. */
export async function handleStopContinue(req, res) {
  const body = await readBody(req, res).catch(() => null);
  let parsed = null;
  try { parsed = JSON.parse(body ?? ""); } catch { /* handled below */ }
  if (!parsed || typeof parsed !== "object") return send(res, 400, { ok: false, reason: "bad_request" });
  const out = await continuer.press(parsed.sessionId, parsed.stop);
  send(res, out.ok ? 200 : out.reason === "bad_request" ? 400 : 409, out);
}
