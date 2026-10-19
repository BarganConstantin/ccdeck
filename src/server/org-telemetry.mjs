// What each Claude organization's settings send, remembered per organization.
//
// A Team or Enterprise organization can turn Claude Code's OpenTelemetry export
// on for every member: the admin sets it in claude.ai, and Claude Code fetches
// it at startup and hourly into <config dir>/remote-settings.json. There is ONE
// such file per machine, and it describes whichever organization's login last
// fetched it. claude-swap does not touch it on a switch, so for a while after a
// switch it still describes the account the user just left, until a Claude
// session on the new account fetches its own.
//
// So the deck cannot read an account's telemetry off the file whenever it
// likes. It reads it when the file can be attributed, and remembers the answer
// under the organization's uuid, for the accounts panel to show on every row of
// that organization — the inactive ones included, which is the point: the
// panel can say before a switch what the switch will turn on.
//
// WHEN THE FILE IS AN ORGANIZATION'S. Both of these, or nothing is recorded:
//   - it was written after claude-swap last changed its store (sequence.json's
//     `lastUpdated`), so it was fetched by the account active now;
//   - the live login (`oauthAccount` in Claude Code's own .claude.json) belongs
//     to the same organization as claude-swap's active account, so a /login
//     made outside claude-swap is not mistaken for the store's account.
// Anything else is left unknown rather than guessed: telling a user an account
// is unmonitored because the file was another organization's is the one
// mistake this must not make. `lastUpdated` also moves on an alias or an add,
// which can only make an answer wait for the next hourly fetch.
//
// Read only when the file has changed since it was last looked at. The roster
// is polled every fifteen seconds, the file changes at most hourly, and
// .claude.json can be large; one stat per poll is the whole steady-state cost.
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { claudeConfigDir } from "./claude-dir.mjs";
import { deckDataDir } from "./deck-home.mjs";
import { writeFileAtomic } from "./atomic-write.mjs";
import { radarVariables } from "./traffic-radar-config.mjs";

/** The flags that put content, not only counts, into the export. */
export const CONTENT_KEYS = Object.freeze([
  "OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES",
]);

const RECORDS_FILE = "org-telemetry.json";

/**
 * What one settings file turns on, from Radar's own reading of it (so endpoint
 * paths and credentials are already stripped): `level` is "content" when a
 * content flag is on beside telemetry, "metrics" for telemetry alone, and "off"
 * when the file does not enable it. Content flags without telemetry send
 * nothing, so they do not count.
 */
export function telemetrySummary(variables) {
  const on = key => variables.some(v => v.key === key && String(v.value).startsWith("Enabled"));
  const telemetry = on("CLAUDE_CODE_ENABLE_TELEMETRY");
  const content = telemetry ? CONTENT_KEYS.filter(on) : [];
  const destinations = [...new Set(variables
    .filter(v => v.key.endsWith("ENDPOINT") && /^https?:\/\//.test(v.value))
    .map(v => v.value))];
  return { level: !telemetry ? "off" : content.length ? "content" : "metrics", content, destinations };
}

/** Claude Code's own state file: beside the home directory, or inside a
 *  moved config directory. */
function claudeStatePath(env, home, platform) {
  const { join } = platform === "win32" ? win32 : posix;
  return env.CLAUDE_CONFIG_DIR?.trim() ? join(claudeConfigDir(env, home, platform), ".claude.json") : join(home, ".claude.json");
}

async function readJson(path, read) {
  try { return JSON.parse(String(await read(path, "utf8")).replace(/^﻿/, "")); } catch { return null; }
}

let _records = null;
let _examined = null;   // mtime of the remote-settings.json last looked at

/** The content flags by the words a person would use for them. The page has
 *  its own copy in org-telemetry.ts, for the row. */
export const CONTENT_WORDS = Object.freeze({
  OTEL_LOG_USER_PROMPTS: "prompts",
  OTEL_LOG_ASSISTANT_RESPONSES: "responses",
  OTEL_LOG_TOOL_DETAILS: "tool details",
  OTEL_LOG_TOOL_CONTENT: "tool output",
  OTEL_LOG_RAW_API_BODIES: "full API bodies",
});

/** "a, b and c". */
function listed(words) {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * "Acme's telemetry is on for new sessions: it sends your prompts and tool
 * details to 192.168.88.16:4317" — what a switch to an account of this
 * organization turns on, for the swap notice to carry. Null when nothing is
 * known to be on: settings seen off, or never seen.
 */
export function telemetryClause(record) {
  if (!record || (record.level !== "metrics" && record.level !== "content")) return null;
  const words = record.level === "content" ? (record.content ?? []).map(k => CONTENT_WORDS[k] ?? k) : [];
  const what = words.length ? `your ${listed(words)}` : "usage data";
  const hosts = (record.destinations ?? []).map(d => String(d).replace(/^https?:\/\//, ""));
  const who = record.orgName ? `${record.orgName}'s telemetry` : "Its organization's telemetry";
  return `${who} is on for new sessions: it sends ${what}${hosts.length ? ` to ${listed(hosts)}` : ""}`;
}

/** Every organization's record as last saved, without looking at the settings
 *  file: for a reader that has no store to pin a new reading on. */
export async function knownOrgTelemetry({
  env = process.env, home = homedir(), platform = process.platform,
  dataDir = deckDataDir(platform, env, home), read = readFile,
} = {}) {
  if (_records == null) {
    const { join } = platform === "win32" ? win32 : posix;
    const saved = await readJson(join(dataDir, RECORDS_FILE), read);
    _records = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }
  return _records;
}

/** Forget everything held in memory. For the suite. */
export function resetOrgTelemetry() { _records = null; _examined = null; }

/**
 * Look at remote-settings.json if it changed, record it under its organization
 * when it can be attributed (see the header), and answer every organization's
 * record: uuid → `{ orgName, level, content, destinations, seenAt, writtenAt }`.
 *
 * `seq` is claude-swap's sequence.json as the roster already read it. Never
 * throws: a record that could not be made is a record not made.
 */
export async function observeOrgTelemetry({
  seq,
  env = process.env, home = homedir(), platform = process.platform, now = Date.now(),
  dataDir = deckDataDir(platform, env, home),
  statFile = stat, read = readFile, write = writeFileAtomic, makeDir = mkdir,
} = {}) {
  const { join } = platform === "win32" ? win32 : posix;
  const recordsPath = join(dataDir, RECORDS_FILE);
  if (_records == null) {
    const saved = await readJson(recordsPath, read);
    _records = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }
  try {
    const remote = join(claudeConfigDir(env, home, platform), "remote-settings.json");
    const mtime = (await statFile(remote)).mtimeMs;
    if (mtime === _examined) return _records;
    _examined = mtime;

    const active = seq?.accounts?.[String(seq?.activeAccountNumber)];
    const switchedAt = Date.parse(seq?.lastUpdated ?? "");
    if (!active?.organizationUuid || !Number.isFinite(switchedAt) || mtime <= switchedAt) return _records;
    const live = (await readJson(claudeStatePath(env, home, platform), read))?.oauthAccount;
    if (!live || live.organizationUuid !== active.organizationUuid) return _records;

    const settings = await readJson(remote, read);
    if (!settings) return _records;
    _records = {
      ..._records,
      [active.organizationUuid]: {
        orgName: live.organizationName ?? active.organizationName ?? null,
        ...telemetrySummary(radarVariables(settings, "Cached organization settings")),
        seenAt: now,
        writtenAt: Math.round(mtime),
      },
    };
    await makeDir(dataDir, { recursive: true })
      .then(() => write(recordsPath, `${JSON.stringify(_records, null, 2)}\n`))
      .catch(() => {});
  } catch { /* no file, or one that could not be read: nothing new to say */ }
  return _records;
}
