// The README's hero image, assets/canvas.png.
//
//   npm run build && node assets/capture-hero.mjs
//
// It shoots THIS checkout's deck — the version in package.json, the brand files
// under src/web/public — drawing the generated log of assets/canvas-demo.mjs,
// and it can see nothing real. In order:
//
//   1. Writes the demo log with every session under /demo, a path that exists
//      on no machine, and scans it for home directories and e-mail addresses
//      before the deck ever reads it.
//   2. Starts the deck in a fresh, empty home: HOME, CLAUDE_CONFIG_DIR,
//      CODEX_HOME, CLAUDE_SWAP_BACKUP and every XDG_* point into a temporary
//      directory, every AGENTS_DECK_NO_* switch the code knows is on (the list
//      below, and any other it finds in bin/, hook/ and src/server/), PATH holds
//      only `node`, then /usr/bin and /bin, and `--workspace /demo` keeps even a
//      stray real event off the canvas. With its own CLAUDE_CONFIG_DIR the deck
//      reads an empty deck registry, so it can neither attach to nor replace a
//      deck already running on this machine. DECK_PORT (default 4471) must be
//      outside ccdeck's own 4317–4400 and free.
//   3. Refuses to go on unless /api/health answers workspace /demo and
//      /api/version the version in package.json: proof the deck on the port is
//      the one it started.
//   4. Opens the page with one script in it before any of the deck's own (the
//      page script, pageScript() below). It seeds the panels the picture
//      wants, and it answers, inside the page, every read an empty home cannot
//      answer or must not: the Claude and Codex quota, the Codex token count,
//      ccusage's history, the Claude accounts roster (example.com addresses),
//      auto-switch and Local network (studio-mac and build-box, on
//      192.0.2.0/24, the documentation range). The machine panel's reads get
//      503 there: they would show this computer. Every write those panels can
//      make is answered there too. The page reads all of these with fetch()
//      and only the canvas's own stream with EventSource, so nothing faked
//      reaches the deck and nothing real reaches the page. What the picture
//      shows is the real deck drawing that data through its real components:
//      only the data is invented.
//   5. Lets the deck frame the canvas itself (__ccdeckHero.frame): its own R
//      lays the sessions out, its own auto-fit frames them, and nothing pans or
//      zooms — a gesture turns auto-fit off, and the deck then says so on the
//      canvas. That is why the demo is three sessions: it is what the deck's fit
//      shows at 1600x900 with both side panels open and every card still drawn
//      as a card (semantic-zoom.ts) rather than as a dot. Then it checks the
//      page (__ccdeckHero.check): it refuses a picture that shows a home or
//      temp directory, this machine's name, your user name or one of this
//      machine's network addresses, an e-mail address outside the example
//      domains, a panel whose data was not faked, auto-fit switched off, the
//      canvas at its overview zoom, a toast or a dialog, or a topbar without
//      this version and the brand kit's mark.
//   6. Writes assets/canvas.png — 1600x900 at device scale 2, so 3200x1800 —
//      then stops the deck with its own --stop and closes the browser over the
//      DevTools protocol. Nothing is killed.
//
// Only the deck is isolated. The browser runs in your own environment —
// headless, on a profile made for the run, with a mock keychain so it never
// asks the OS keychain for anything: BROWSER, else Brave, Chrome or Chromium,
// whichever is installed first, on CDP_PORT (default 9347).
//
//   --serve   steps 1–3 only, for taking the shot from a browser you drive
//             yourself (the chrome-devtools MCP, say). It prints a one-line
//             init script that loads the page script from DECK_PORT + 1, which
//             answers that one file to the deck's origin and nothing else.
//             Open http://127.0.0.1:<DECK_PORT>/ in a new isolated browser
//             context at 1600x900x2 with that init script, evaluate
//             `() => __ccdeckHero.frame()`, then `() => __ccdeckHero.check()`:
//             an empty list is a picture that may be saved. Ctrl-C stops the
//             deck.
//   OUT=<file>  write somewhere else (a dry run, a comparison)
//   KEEP=1      leave the temporary directory behind (the deck log is in it)
//   DEBUG=1     print where the deck's fit put each session
//
// POSIX only (macOS, Linux).

import { spawn, execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createConnection, createServer } from "node:net";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, networkInterfaces, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { demoLog, SESSION_IDS } from "./canvas-demo.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE = "/demo";
const VIEWPORT = { width: 1600, height: 900, dpr: 2 };
const OUT = process.env.OUT ?? join(ROOT, "assets", "canvas.png");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const SERVE = process.argv.includes("--serve");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (msg) => console.log(`capture-hero: ${msg}`);
const fail = (msg) => {
  console.error(`capture-hero: ${msg}`);
  process.exit(1);
};

if (process.platform === "win32") fail("POSIX only. On Windows, run it under WSL.");
if (!existsSync(join(ROOT, "dist", "web", "index.html"))) fail("no dist/web — run `npm run build` first, so the deck serves this checkout's page.");

// ── Ports ───────────────────────────────────────────────────────────────────
const port = (name, fallback) => {
  const raw = process.env[name] ?? String(fallback);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) fail(`${name}=${raw} is not a port from 1024 to 65535`);
  if (n >= 4317 && n <= 4400) fail(`${name}=${n} is in ccdeck's own range, 4317–4400, where a real deck with real accounts runs. Pick a port outside it.`);
  return n;
};
const DECK_PORT = port("DECK_PORT", 4471);
const CDP_PORT = port("CDP_PORT", 9347);
if (DECK_PORT === CDP_PORT) fail("DECK_PORT and CDP_PORT must differ");
const answers = (p) => new Promise((res) => {
  const s = createConnection({ host: "127.0.0.1", port: p });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(800, () => done(false));
  s.once("connect", () => done(true));
  s.once("error", () => done(false));
});
const bindable = (p) => new Promise((res) => {
  const srv = createServer();
  srv.once("error", () => res(false));
  srv.listen({ host: "127.0.0.1", port: p, exclusive: true }, () => srv.close(() => res(true)));
});
for (const [name, p] of SERVE ? [["DECK_PORT", DECK_PORT]] : [["DECK_PORT", DECK_PORT], ["CDP_PORT", CDP_PORT]]) {
  if ((await answers(p)) || !(await bindable(p))) fail(`${name}=${p}: something is already there. This tool only starts its own deck and browser, and never talks to one it did not start.`);
}

// ── What must never be in the picture ───────────────────────────────────────
const REAL_HOME = homedir();
const USER = (() => { try { return userInfo().username; } catch { return ""; } })();
const HOST = hostname().replace(/\.local$/i, "");
const ADDRESSES = [...new Set(Object.values(networkInterfaces()).flat()
  .filter((a) => a && !a.internal && a.address)
  .map((a) => a.address.replace(/%.*$/, "").toLowerCase()))];

// ── 1. The demo log ─────────────────────────────────────────────────────────
const run = mkdtempSync(join(tmpdir(), "ccdeck-hero-"));
const dirs = Object.fromEntries(["home", "state", "config", "data", "cache", "bin", "browser"].map((d) => [d, join(run, d)]));
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const events = join(run, "events.jsonl");
const log = demoLog({ workspace: WORKSPACE }).join("\n") + "\n";
for (const m of log.matchAll(/\/(?:Users|home|var\/folders)\/|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g)) fail(`the demo log contains ${m[0]}`);
if (log.includes(REAL_HOME) || log.includes(run)) fail("the demo log contains a real path");
writeFileSync(events, log);
note(`${log.trim().split("\n").length} demo events → ${events}`);

// ── 2. The isolated deck ────────────────────────────────────────────────────
symlinkSync(process.execPath, join(dirs.bin, "node"));
const PATH = [dirs.bin, "/usr/bin", "/bin"].join(":");
for (const d of ["/usr/bin", "/bin"]) {
  for (const tool of ["claude", "claude-swap", "cswap", "codex", "ccusage"]) {
    try {
      accessSync(join(d, tool), constants.X_OK);
      fail(`${join(d, tool)} is installed system-wide, where an isolated deck would still find it.`);
    } catch (e) {
      if (e?.code !== "ENOENT" && e?.code !== "EACCES") throw e;
    }
  }
}

// What each switch keeps the deck from doing:
//   INSTALL       installing or updating claude-swap and ccusage, asking npm
//   UPDATE_CHECK  asking npm about releases
//   DOWNLOAD      downloading the uv and macmon binaries
//   FRESHEN       nudging claude-swap to collect usage early
//   NOTIFY        raising a desktop notification
//   LAN           going on the local network
//   MUSIC         contacting the music stations
//   STATUS        reading Anthropic's and OpenAI's status pages
//   REPORTS       sending the anonymous reports
const KNOWN_SWITCHES = ["INSTALL", "UPDATE_CHECK", "DOWNLOAD", "FRESHEN", "NOTIFY", "LAN", "MUSIC", "STATUS", "REPORTS"].map((s) => `AGENTS_DECK_NO_${s}`);
const named = new Set();
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(p); }
    else if (/\.(m?js|cjs)$/.test(e.name)) for (const m of readFileSync(p, "utf8").matchAll(/AGENTS_DECK_NO_[A-Z_]*[A-Z]/g)) named.add(m[0]);
  }
};
for (const sub of ["bin", "hook", join("src", "server")]) walk(join(ROOT, sub));
const extra = [...named].filter((s) => !KNOWN_SWITCHES.includes(s)).sort();
if (extra.length) note(`switches this tool does not list, on too: ${extra.join(", ")}`);

const env = {
  PATH,
  HOME: dirs.home,
  USERPROFILE: dirs.home,
  CLAUDE_CONFIG_DIR: join(dirs.home, ".claude"),
  CODEX_HOME: join(dirs.home, ".codex"),
  CLAUDE_SWAP_BACKUP: join(dirs.home, ".cswap"),
  XDG_STATE_HOME: dirs.state,
  XDG_CONFIG_HOME: dirs.config,
  XDG_DATA_HOME: dirs.data,
  XDG_CACHE_HOME: dirs.cache,
  ...Object.fromEntries([...KNOWN_SWITCHES, ...extra].map((name) => [name, "1"])),
  LANG: "C.UTF-8",
  TZ: "UTC",
};
const DECK_BIN = join(ROOT, "bin", "deck.js");
const started = [];

function startDeck() {
  const out = openSync(join(run, "deck.log"), "a");
  const child = spawn(process.execPath, [DECK_BIN, "--foreground", "--port", String(DECK_PORT), "--no-open", "--claude", "--codex", "--workspace", WORKSPACE, "--history", events], {
    cwd: dirs.home, env, stdio: ["ignore", out, out],
  });
  started.push({ name: "deck", child });
  return child;
}

// ── 4–5. The page script ────────────────────────────────────────────────────
//
// Everything in pageScript() runs in the page, so it is written as one
// self-contained function and handed over as source: it may use nothing from
// this file but its argument. The fakes' shapes are this checkout's server's;
// the comment on each names the function that builds the real one. Times are
// computed per request, so every countdown and age reads the same however long
// a run takes.

function pageScript(C) {
  if (location.port !== String(C.port) || window.__ccdeckHero) return;
  // A tab's first page starts from an empty store, so a browser context used
  // before keeps nothing of that run: no layout, no viewport, no panel.
  try {
    if (!sessionStorage.getItem("ccdeckHero")) { localStorage.clear(); sessionStorage.setItem("ccdeckHero", "1"); }
    for (const k in C.storage) localStorage.setItem(k, C.storage[k]);
  } catch {}

  const MIN = 60_000;
  const DAY_MS = 86_400_000;
  const sec = (ms) => Math.floor(ms / 1000);
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

  // /api/quota: src/server/quota.mjs, through mapOAuthUsage (quota-shape.mjs).
  const claudeQuota = (now = Date.now()) => ({
    ok: true,
    session5hPct: 64, session5hWindowSec: 18_000, session5hReset: null, session5hResetAt: sec(now) + 3 * 3600 + 12 * 60,
    week7dPct: 38, week7dWindowSec: 604_800, week7dReset: null, week7dResetAt: sec(now) + 4 * 86_400 + 5 * 3600,
    source: "api", fetchedAt: now - 2 * MIN,
  });

  // /api/codex-quota: src/server/codex-quota.mjs (toWindow, laneFor).
  const codexQuota = (now = Date.now()) => {
    const lane = (key, label, pct, windowSec, resetIn) => ({ id: key, key, label, rank: key === "session" ? 0 : 1, pct, windowSec, resetAt: sec(now) + resetIn, reset: null });
    return {
      ok: true, limitReached: false, allowed: true,
      windows: [lane("session", "5-hour window", 18, 18_000, 4 * 3600 + 10 * 60), lane("weekly", "7-day window", 41, 604_800, 2 * 86_400 + 7 * 3600)],
      extraWindows: [], plan: "plus", planLabel: "Plus", email: null,
      creditsBalance: null, creditsUnlimited: false, overageReached: false, creditLimit: null, spendControlReached: false,
      reachedType: null, promo: null, partial: false, refreshed: false, fetchedAt: now - 30_000, resetCredits: null,
    };
  };

  // /api/codex-usage: src/server/codex-usage.mjs, the token count of the rollouts.
  const codexUsage = (now = Date.now()) => ({
    ok: true,
    window5h: { inputTokens: 104_900, outputTokens: 14_600, cacheReadTokens: 96_000, totalTokens: 119_500, sessionCount: 1 },
    window7d: { inputTokens: 2_310_000, outputTokens: 212_000, cacheReadTokens: 1_980_000, totalTokens: 2_522_000, sessionCount: 9 },
    fetchedAt: now,
  });

  // /api/ccusage: readRange in src/server/ccusage.mjs, ccusage's own rows
  // passed through. Each model's tokens are in the mix of the demo session
  // that ran on it, so a day's dollars and tokens agree with the deck's rate
  // table, and today's sessions are the canvas's, at what their cards cost.
  const MIX = {
    "claude-opus-5": { cost: 4.2835, inputTokens: 41_200, outputTokens: 96_800, cacheReadTokens: 1_840_000, cacheCreationTokens: 118_000, agent: "claude" },
    "claude-sonnet-5": { cost: 0.4637, inputTokens: 12_400, outputTokens: 28_100, cacheReadTokens: 402_000, cacheCreationTokens: 31_000, agent: "claude" },
    "gpt-5.5": { cost: 0.5305, inputTokens: 8_900, outputTokens: 14_600, cacheReadTokens: 96_000, cacheCreationTokens: 0, agent: "codex" },
  };
  const TOKEN_KEYS = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"];
  const tokensOf = (b) => TOKEN_KEYS.reduce((n, k) => n + b[k], 0);
  const breakdown = (modelName, cost) => {
    const m = MIX[modelName];
    const k = cost / m.cost;
    return { modelName, ...Object.fromEntries(TOKEN_KEYS.map((key) => [key, Math.round(m[key] * k)])), cost: Math.round(cost * 100) / 100 };
  };
  const pastDay = (i) => ({
    "claude-opus-5": 2.1 + ((i * 17) % 31) / 5,
    "claude-sonnet-5": 0.4 + ((i * 7) % 13) / 10,
    "gpt-5.5": 0.7 + ((i * 11) % 19) / 8,
  });
  const day = (dayStart, costs) => {
    const modelBreakdowns = Object.entries(costs).filter(([, c]) => c > 0).map(([m, c]) => breakdown(m, c));
    const sum = (list, k) => list.reduce((n, b) => n + b[k], 0);
    const agents = ["claude", "codex"].map((agent) => {
      const bs = modelBreakdowns.filter((b) => MIX[b.modelName].agent === agent);
      const row = { agent, modelsUsed: bs.map((b) => b.modelName), modelBreakdowns: bs, totalCost: Math.round(sum(bs, "cost") * 100) / 100 };
      for (const k of TOKEN_KEYS) row[k] = sum(bs, k);
      row.totalTokens = tokensOf(row);
      return row;
    }).filter((a) => a.modelBreakdowns.length > 0);
    const out = { period: ymd(dayStart), date: ymd(dayStart), agent: "all", modelsUsed: modelBreakdowns.map((b) => b.modelName), modelBreakdowns, metadata: { agents: agents.map((a) => a.agent) }, agents, totalCost: Math.round(sum(modelBreakdowns, "cost") * 100) / 100 };
    for (const k of TOKEN_KEYS) out[k] = sum(modelBreakdowns, k);
    out.totalTokens = tokensOf(out);
    return out;
  };
  const ccusageRange = (url, now = Date.now()) => {
    const until = url.searchParams.get("until") || null;
    const asked = url.searchParams.get("since") || null;
    if ((asked && !/^\d{8}$/.test(asked)) || (until && !/^\d{8}$/.test(until))) return undefined;
    const d = new Date(now);
    const since = asked ?? ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 30)).replace(/-/g, "");
    const dayOf = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
    const from = Math.max(dayOf(since), first);
    const to = Math.min(until ? dayOf(until) : today, today);
    const days = [];
    for (let t = from; t <= to; t += DAY_MS) {
      if (t !== today) { days.push(day(t, pastDay(Math.floor(t / DAY_MS)))); continue; }
      const costs = {};
      for (const s of C.today) costs[s.model] = (costs[s.model] ?? 0) + s.cost;
      days.push(day(t, costs));
    }
    const started = new Date(today + 9 * 3600_000).toISOString();
    const rollout = (uuid) => `${started.slice(0, 10).replace(/-/g, "/")}/rollout-${started.slice(0, 19).replace(/:/g, "-")}-${uuid}`;
    const sessions = today >= from && today <= to
      ? C.today.map((s) => ({ period: s.agent === "codex" ? rollout(s.id) : s.id, agent: s.agent, totalCost: s.cost, totalTokens: tokensOf(breakdown(s.model, s.cost)), modelsUsed: [s.model], metadata: { lastActivity: new Date(now - 5 * MIN).toISOString() } }))
      : [];
    const sum = (k) => days.reduce((n, x) => n + x[k], 0);
    const totals = { totalCost: Math.round(sum("totalCost") * 100) / 100, totalTokens: sum("totalTokens") };
    for (const k of TOKEN_KEYS) totals[k] = sum(k);
    return { ok: true, days, sessions, totals, since, until, fetchedAt: now };
  };

  // /api/claude-accounts: rosterRow in src/server/claude-accounts.mjs.
  const org = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  const roster = (now = Date.now()) => ({
    ok: true,
    accounts: C.accounts.map((a) => ({
      num: a.num, email: a.email, alias: a.alias, org: a.org, orgUuid: org(a.num),
      alive: true, active: a.num === 1, disabled: false,
      lanes: [
        { id: "five_hour", label: "5h", pct: a.five, resetAt: sec(now) + a.fiveReset },
        { id: "seven_day", label: "7d", pct: a.seven, resetAt: sec(now) + a.sevenReset },
      ],
      headroom: 100 - Math.max(a.five, a.seven),
      fetchedAt: now - a.fetchedAgo, nextAt: now - a.fetchedAgo + 3 * MIN,
      stale: false, error: null, staleCopy: false, repair: null, stopped: false, collector: "ok",
    })),
    activeNum: 1,
    fetchedAt: now,
  });

  // /api/lan: status() in src/server/lan-engine.mjs, with `ok` and `reach`
  // from lan-routes.mjs. This deck is studio-mac; build-box is paired and
  // offers the login it is on. Fingerprints invented, addresses from
  // 192.0.2.0/24 (RFC 5737).
  const keyOf = (a) => `${a.email.toLowerCase()}@@${org(a.num)}`;
  const lan = (now = Date.now()) => {
    const offered = C.accounts.find((a) => a.num === C.lan.offers);
    const shared = C.accounts.find((a) => a.num === C.lan.shares);
    const peer = {
      id: C.lan.peer.fp, fp: C.lan.peer.fp, peerFp: C.lan.peer.fp, name: C.lan.peer.name, addr: C.lan.peer.addr, port: C.lan.peer.port,
      manual: false, met: false, paired: true, via: "lan", lastSeen: now - 12_000,
      last: { at: now - 40_000, name: C.lan.peer.name, offered: 1, done: [] },
      about: { version: C.version, os: "Linux", arch: "x64", at: now - 40_000 },
      offers: { at: now - 40_000, accounts: [{ key: keyOf(offered), email: offered.email, alive: true }], current: { key: keyOf(offered) } },
      pairedAt: now - 3 * DAY_MS, autoPaired: true,
    };
    return {
      ok: true, enabled: true, running: true, stalled: null, deaf: null, lanTunneled: false,
      checkedAt: now - 40_000, name: C.lan.name, about: { version: C.version, os: "macOS 26.1", arch: "arm64" },
      aliases: {}, autoAsk: true, autoAccept: true, pairingMode: "automatic", shareActive: true, tailscale: null,
      fp: "3f1-a07-c42-9be", port: 52914, inboundAt: now - 50_000, listeningSince: now - 2 * 3600_000,
      addrs: [C.lan.addr], shared: [keyOf(shared)], invite: null,
      trusted: [{ fp: peer.fp, name: peer.name }], pending: [], strangers: [], declined: [], peers: [peer], reach: null,
    };
  };

  const AUTO_SWITCH_OFF = { ok: true, enabled: false, external: false, lastTick: null, settings: { "autoswitch.threshold": { value: "90", isDefault: true } } };
  const REFUSED = { ok: false, reason: "unknown_action" };
  // Exact paths. A function of the request's URL; undefined lets it through.
  const FAKES = {
    "/api/quota": () => claudeQuota(),
    "/api/codex-quota": () => codexQuota(),
    "/api/codex-usage": () => codexUsage(),
    "/api/ccusage": (url) => ccusageRange(url),
    "/api/claude-accounts": () => roster(),
    "/api/cswap-auto": () => AUTO_SWITCH_OFF,
    "/api/lan": () => lan(),
    // Writes. Nothing here presses them; if anything did, they reach nothing.
    "/api/claude-accounts/login": () => ({ ok: true, state: "idle" }),
    "/api/claude-accounts/admin": () => REFUSED,
    "/api/claude-accounts/switch": () => REFUSED,
    "/api/lan/peer": () => REFUSED,
    "/api/lan/invite": () => REFUSED,
    "/api/lan/sync": () => REFUSED,
  };
  // Reads that show this computer: never the deck's to answer here.
  const refused = (path) => path === "/api/system" || path.startsWith("/api/system/") || path === "/api/account-projects";

  const faked = new Set();
  const passed = new Set();
  const realFetch = window.fetch.bind(window);
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  window.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, location.href);
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
      if (refused(url.pathname)) { faked.add(url.pathname); return reply(503, { ok: false, error: "not shown in the README picture" }); }
      const fake = FAKES[url.pathname];
      const value = fake ? fake(url) : undefined;
      if (value !== undefined) { faked.add(url.pathname); return reply(200, value); }
      passed.add(url.pathname);
    }
    return realFetch(input, init);
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (what, test, ms = 15_000) => {
    const t0 = performance.now();
    while (!test()) {
      if (performance.now() - t0 > ms) throw new Error(`waited ${ms} ms for ${what}`);
      await wait(50);
    }
  };
  const press = (label) => {
    const b = document.querySelector(`button[aria-label=${JSON.stringify(label)}]`);
    if (!b) throw new Error(`no button "${label}"`);
    b.click();
  };
  const transform = () => document.querySelector(".react-flow__viewport")?.style.transform ?? "";
  const zoomNow = () => Number(/scale\(([\d.]+)\)/.exec(transform())?.[1] ?? NaN);

  /** The board as the deck frames it itself. Nothing here pans or zooms: a
   *  gesture turns auto-fit off, and the deck then says so on the canvas. The
   *  deck's own R lays the sessions out in id order whatever order the replay
   *  placed them in, and auto-fit frames the result. */
  async function frame() {
    for (const d of document.querySelectorAll(".modal.guide, .modal.release-notes")) d.querySelector('button[aria-label^="Close"]')?.click();
    await waitFor("the canvas", () => document.querySelectorAll(".react-flow__node").length >= C.frame.nodes);
    await waitFor("the waiting chip", () => document.querySelector(".topbar .waiting-stat"));
    await waitFor("this month's usage", () => document.querySelector(".topbar .month-usage b"));
    press("Re-arrange the canvas");
    await wait(1500);
    // Settled: the same viewport for a second and a half.
    let last = "";
    let since = performance.now();
    await waitFor("the canvas to settle", () => {
      const now = transform();
      if (now !== last) { last = now; since = performance.now(); }
      return performance.now() - since > 1500;
    }, 20_000);
    document.activeElement?.blur?.();
    return { zoom: zoomNow(), lod: document.querySelector("[data-lod]")?.getAttribute("data-lod"), groups: [...document.querySelectorAll('.react-flow__node[data-id^="group:"]')].map((n) => { const r = n.getBoundingClientRect(); return [n.getAttribute("data-id"), Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }) };
  }

  /** What would make this picture unfit to publish. Empty: fit. */
  function check() {
    const problems = [];
    const text = [document.title, document.body.innerText, ...[...document.querySelectorAll("input, textarea")].map((i) => i.value)].join("\n");
    const has = (s) => s && s.length > 1 && text.includes(s);
    const word = (w) => w && w.length >= 4 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
    if (has(C.forbidden.home)) problems.push("your home directory");
    if (has(C.forbidden.run)) problems.push("this run's own directory");
    for (const m of text.matchAll(/(?:^|[^\w.])(\/home\/[^\s/"'`]+|\/Users\/[^\s/"'`]+|\/var\/folders\/[^\s"'`]+|\/private\/[^\s"'`]+|[A-Za-z]:[\\/]+Users[\\/]+[^\s\\/"'`]+)/g)) problems.push(`a home or temp path (${m[1]})`);
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g)) {
      if (!/@(?:[a-z0-9-]+\.)*(?:example\.(?:com|net|org)|example)$/i.test(m[0])) problems.push(`an e-mail address outside the example domains (${m[0]})`);
    }
    for (const a of C.forbidden.addresses) {
      const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const edges = a.includes(":") ? ["(?<![\\w:])", "(?![\\w:])"] : ["(?<![\\w.])", "(?![\\w]|\\.\\d)"];
      if (new RegExp(`${edges[0]}${esc}${edges[1]}`, "i").test(text)) problems.push(`one of this machine's network addresses (${a})`);
    }
    if (word(C.forbidden.host) && !["localhost", "desktop", "laptop", "macbook"].includes(C.forbidden.host.toLowerCase())) problems.push(`this machine's name (${C.forbidden.host})`);
    if (word(C.forbidden.user)) problems.push(`your user name (${C.forbidden.user})`);
    for (const p of passed) if (refused(p) || p in FAKES) problems.push(`${p} reached the deck instead of its fake`);
    if (document.querySelector("#accounts-panel, .accounts-panel") && !faked.has("/api/claude-accounts")) problems.push("the accounts panel is open on data that was not faked");
    if (document.getElementById("ap-lan-title") && !faked.has("/api/lan")) problems.push("Local network is open on data that was not faked");
    if (document.querySelector("#system-panel")) problems.push("the machine panel is open: it shows this computer");
    const bar = document.querySelector(".topbar");
    if (!bar?.innerText.includes(`v${C.version}`)) problems.push(`the topbar does not say v${C.version}`);
    if (![...(bar?.querySelectorAll("img") ?? [])].some((i) => (i.getAttribute("src") ?? "").endsWith(C.mark))) problems.push(`the topbar does not carry the kit's mark (${C.mark})`);
    if (!document.querySelector(".topbar .waiting-stat")) problems.push("no session is waiting on you in the topbar");
    if (document.querySelector(".autofit-chip")) problems.push("auto-fit is off, and the canvas says so");
    if (document.querySelector("[data-lod]")?.getAttribute("data-lod") === "overview") problems.push("the canvas is zoomed out to its overview, where a card is a dot");
    if (document.querySelector(".toast, [role=alert], .modal, [role=dialog]")) problems.push("a toast or a dialog is open");
    if (innerWidth !== C.viewport.width || innerHeight !== C.viewport.height || devicePixelRatio !== C.viewport.dpr) problems.push(`the page is ${innerWidth}x${innerHeight}x${devicePixelRatio}, not ${C.viewport.width}x${C.viewport.height}x${C.viewport.dpr}`);
    return problems;
  }

  window.__ccdeckHero = { frame, check, faked: () => [...faked], passed: () => [...passed] };
}

/** What the picture is: which panels, which data, where the canvas sits. */
const PAGE = {
  port: DECK_PORT,
  version: VERSION,
  viewport: VIEWPORT,
  mark: "brand/ccdeck-mark-gradient-small-optical.svg",
  storage: {
    "agent-dag.tourSeen": "1",
    "agent-dag.releaseNotesSeen": VERSION,
    "agent-dag.theme": "dark",
    "agent-dag.sessionListOpen": "1",
    "agent-dag.accountsPanelOpen": "0",
    "agent-dag.usagePanelOpen": "1",
    "agent-dag.usagePeriod": "today",
    "agent-dag.usageSessionsOpen": "1",
    "agent-dag.detailOpen": "0",
    "agent-dag.systemPanelOpen": "0",
  },
  // Today's sessions as ccusage would list them: the canvas's, at what their
  // cards cost.
  today: [
    { id: SESSION_IDS.webApi, agent: "claude", model: "claude-opus-5", cost: 4.28 },
    { id: SESSION_IDS.infra, agent: "codex", model: "gpt-5.5", cost: 0.53 },
    { id: SESSION_IDS.dataPipeline, agent: "claude", model: "claude-sonnet-5", cost: 0.46 },
  ],
  // Three Claude logins: the one in use, one with room, one nearly through
  // its week and shared to this deck by build-box.
  accounts: [
    { num: 1, email: "alex@example.com", alias: "work", org: "Example Studio", five: 64, seven: 38, fetchedAgo: 2 * 60_000, fiveReset: 3 * 3600 + 12 * 60, sevenReset: 4 * 86_400 + 5 * 3600 },
    { num: 2, email: "sam@example.com", alias: "personal", org: null, five: 6, seven: 22, fetchedAgo: 4 * 60_000, fiveReset: 15_300, sevenReset: 421_000 },
    { num: 3, email: "ops@example.com", alias: "build", org: "Example Studio", five: 12, seven: 81, fetchedAgo: 3 * 60_000, fiveReset: 11_900, sevenReset: 98_400 },
  ],
  lan: { name: "studio-mac", addr: "192.0.2.14", shares: 1, offers: 3, peer: { fp: "8d2-5e1-b30-47c", name: "build-box", addr: "192.0.2.27", port: 50371 } },
  frame: { nodes: 9 },
  forbidden: { home: REAL_HOME, run, user: USER, host: HOST, addresses: ADDRESSES },
};
const PAGE_SCRIPT = `(${pageScript.toString()})(${JSON.stringify(PAGE)});`;

// ── The browser ─────────────────────────────────────────────────────────────

/** BROWSER, else the first Chromium-family browser found: Brave, Chrome,
 *  Chromium. Whichever it is runs headless on a profile made for this run. */
function browserPath() {
  if (process.env.BROWSER) return process.env.BROWSER;
  const hit = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/brave-browser", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
  ].find((p) => existsSync(p));
  if (!hit) fail("no Chromium-family browser found. Set BROWSER to a Brave, Chrome or Chromium binary.");
  return hit;
}

async function startBrowser() {
  const out = openSync(join(run, "browser.log"), "a");
  const child = spawn(browserPath(), [
    "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${dirs.browser}`, "--disable-gpu",
    "--use-mock-keychain", "--password-store=basic",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
    "--hide-scrollbars", "--force-color-profile=srgb", "about:blank",
  ], { stdio: ["ignore", out, out] });
  started.push({ name: "browser", child });
  for (let i = 0; i < 80 && child.exitCode === null; i++) {
    try { if ((await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error(`the browser did not answer on ${CDP_PORT}; run with KEEP=1 and read browser.log`);
}

/** One tab over the DevTools protocol, with Node's own WebSocket. */
async function openPage() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
  if (!res.ok) throw new Error(`cannot open a tab: ${res.status}`);
  const ws = new WebSocket((await res.json()).webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
  let next = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
  });
  const page = {
    errors: [],
    send(method, params = {}) {
      const id = next++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, cb) { listeners.set(method, [...(listeners.get(method) ?? []), cb]); },
    async eval(expression) {
      const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    close() { try { ws.close(); } catch {} },
  };
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  page.on("Runtime.exceptionThrown", (p) => page.errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  return page;
}

async function shoot() {
  const page = await openPage();
  try {
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_SCRIPT });
    await page.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: VIEWPORT.dpr, mobile: false });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] });
    const loaded = new Promise((r) => page.on("Page.loadEventFired", r));
    await page.send("Page.navigate", { url: `http://127.0.0.1:${DECK_PORT}/` });
    await loaded;
    await sleep(3000);
    const framed = await page.eval("__ccdeckHero.frame()");
    if (process.env.DEBUG) note(JSON.stringify(framed));
    const problems = await page.eval("__ccdeckHero.check()");
    if (problems.length) throw new Error(`not captured — the page shows or does ${problems.join("; ")}`);
    if (page.errors.length) note(`page exceptions: ${page.errors.slice(0, 3).join(" | ")}`);
    const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: 1 } });
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, Buffer.from(data, "base64"));
    note(`${OUT}: ${VIEWPORT.width * VIEWPORT.dpr}x${VIEWPORT.height * VIEWPORT.dpr}, ccdeck ${VERSION}`);
  } finally {
    page.close();
  }
}

async function stopAll() {
  const browser = started.find((s) => s.name === "browser");
  if (browser && browser.child.exitCode === null) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      const ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.addEventListener("open", r, { once: true }); ws.addEventListener("error", j, { once: true }); });
      ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
      await sleep(300);
      try { ws.close(); } catch {}
    } catch {}
  }
  const deck = started.find((s) => s.name === "deck");
  if (deck && deck.child.exitCode === null) {
    try {
      execFileSync(process.execPath, [DECK_BIN, "--stop", "--port", String(DECK_PORT)], { env, cwd: dirs.home, stdio: "ignore", timeout: 20_000 });
    } catch {}
  }
  const left = [];
  for (const s of started) {
    const gone = s.child.exitCode !== null || s.child.signalCode !== null
      || (await Promise.race([new Promise((r) => s.child.once("exit", () => r(true))), sleep(15_000).then(() => false)]));
    if (!gone) left.push(`${s.name} pid ${s.child.pid}`);
  }
  if (left.length) note(`STILL RUNNING — not killed by this tool: ${left.join(", ")}. Scratch kept at ${run}.`);
  else if (process.env.KEEP) note(`scratch kept at ${run}`);
  else rmSync(run, { recursive: true, force: true });
}

let exitCode = 0;
let stopping = null;
const stop = () => (stopping ??= stopAll());
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, async () => { await stop(); process.exit(SERVE ? 0 : 130); });

try {
  const deck = startDeck();
  let health = null;
  for (let i = 0; i < 160 && deck.exitCode === null; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DECK_PORT}/api/health`);
      if (r.ok) { health = await r.json(); break; }
    } catch {}
    await sleep(250);
  }
  if (!health) throw new Error(`the deck did not come up on ${DECK_PORT}; run with KEEP=1 and read deck.log`);
  if (health.workspace !== WORKSPACE) throw new Error(`the deck on ${DECK_PORT} is scoped to ${health.workspace}, not ${WORKSPACE}: not ours, refusing to shoot it`);
  const said = await fetch(`http://127.0.0.1:${DECK_PORT}/api/version`).then((r) => r.json()).then((v) => v.running ?? v.version).catch(() => null);
  if (said !== VERSION) throw new Error(`the deck on ${DECK_PORT} says it is ${said}, not ${VERSION}`);
  note(`deck ${VERSION} up on ${DECK_PORT} (workspace ${WORKSPACE})`);
  if (SERVE) {
    // The page script is ~20 KB, so the browser is handed a one-line loader
    // instead, which fetches it — synchronously, so it still runs before any
    // of the deck's own — from a server that answers that one file to that
    // one origin.
    const scriptPort = DECK_PORT + 1;
    if ((await answers(scriptPort)) || !(await bindable(scriptPort))) throw new Error(`port ${scriptPort}, for the page script, is taken`);
    const origin = `http://127.0.0.1:${DECK_PORT}`;
    const server = createHttpServer((req, res) => {
      if (req.url !== "/hero-page.js" || req.headers.origin !== origin) { res.writeHead(404).end(); return; }
      res.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": origin, "cache-control": "no-store" }).end(PAGE_SCRIPT);
    });
    await new Promise((r) => server.listen(scriptPort, "127.0.0.1", r));
    const loader = `if (location.origin === ${JSON.stringify(origin)}) { const x = new XMLHttpRequest(); x.open("GET", "http://127.0.0.1:${scriptPort}/hero-page.js", false); x.send(); (0, eval)(x.responseText); }`;
    writeFileSync(join(run, "hero-page.js"), PAGE_SCRIPT);
    writeFileSync(join(run, "init-script.js"), loader);
    note(`open ${origin}/ at ${VIEWPORT.width}x${VIEWPORT.height}x${VIEWPORT.dpr}, in an isolated context, with this init script:`);
    console.log(loader);
    note("then evaluate `() => __ccdeckHero.frame()` and `() => __ccdeckHero.check()`; save the picture only on an empty list. Ctrl-C stops the deck.");
    await new Promise(() => {});
  }
  await startBrowser();
  await shoot();
} catch (e) {
  console.error(`capture-hero: ${e.message}`);
  exitCode = 1;
} finally {
  if (!SERVE || exitCode) await stop();
}
process.exit(exitCode);
