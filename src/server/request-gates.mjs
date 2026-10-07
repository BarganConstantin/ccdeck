// Who may ask this deck for what: the four gates the router runs in front of
// every route, the two route lists they consult, and the per-process token the
// strictest of them checks.
//
// These lived in src/server/index.mjs, between the discovery sweep and the
// listen loop, and they are one argument rather than a row of helpers: whether
// a page chose the request, whether it was addressed to this machine, and who
// is asking, each comment leaning on the one before it. They answer from the
// headers alone — nothing here reads the ring, the log or a socket — so they
// sit in a leaf that imports one node builtin, and the ORDER the router asks
// them in stays in startServer, where it has always been written down.
//
// HOOK_TOKEN moved with them rather than being handed in, because
// presentsDeckToken is the one place it is checked. Its other readers — the
// hook's challenge, the event redaction and the discovery file — only need the
// value, and import it from here; index.mjs still exports hookToken() under
// the name bin/deck.js and the tests have always used.
import { randomBytes, timingSafeEqual } from "node:crypto";

// A secret this process, and only this process, knows. It goes into the
// discovery file bin/deck.js writes (mode 0600) and is never sent anywhere:
// hook/hook.js reads it from that file and asks us to hash it against a nonce
// before it will send us a single session payload.
//
// Fresh per start, deliberately. A discovery file that outlives its deck —
// SIGKILL and power cuts both leave one behind — names a pid the OS is free to
// hand to something else and a port that by then may belong to anything. The
// pid probe, isProcessAlive in deck-probe.mjs, cannot tell that apart from a
// running deck, so the token is what actually distinguishes us: the
// replacement process does not have it, and neither does the next deck, so a
// stale file authenticates nothing.
export const HOOK_TOKEN = randomBytes(32).toString("hex");

// Is this request allowed to be answered at all, whatever it asks for?
//
// The rebinding gate below was reached only by mutations, on the reasoning that
// a cross-site page cannot read a loopback reply. That is true of a genuinely
// cross-origin page and false of a rebound one: the browser resolved
// attacker.example to 127.0.0.1 itself, so it calls the reply same-origin and
// hands the body to the page. Every read was therefore open to exactly the
// attack the mutation gate was written to stop — and the reads are where the
// secrets are. GET /api/events is the whole ring buffer: prompt text, the Bash
// command lines the agent ran, the paths and contents it wrote, the contents of
// every file it read back. /api/claude-accounts names the accounts,
// /api/claude-accounts/login carries a live OAuth authorize URL, /api/health the
// absolute workspace path.
//
// So the Host check runs for every method now. What it asks is only the
// rebinding question — did this request arrive addressed to a name that can
// only ever be this machine. It was first asked of browser-shaped requests
// alone, meaning anything carrying an Origin, fetch metadata or a Referer, on
// the reasoning that a client sending none of them is not a page: that is
// hook/hook.js, a plain Node http.request from the user's own machine. The
// paragraph after next says why that is no longer the whole test.
//
// THE REFERER IS ON THAT LIST because on one browser it is the only mark a page
// leaves (#1168). A same-origin GET carries no Origin, and Safari 16.0-16.3
// sends no Sec-Fetch-Site — the premise isAuthorizedDataRead's fallback is
// built on — so a rebound page on that browser sent `Host: attacker.example:
// 4317` and `Referer: http://attacker.example:4317/` and nothing else, was not
// browser-shaped by the test as it stood, and was answered. Measured against a
// running deck before this line changed: /api/health (the absolute workspace
// path), /api/hook-challenge (the proof oracle, which handleHookChallenge says
// a rebound page cannot see), /api/system/processes and the page itself all
// answered 200. The guarded reads held only because isAuthorizedDataRead
// happens to test the Host before it reads the Referer. No client of this
// server that is not a browser sends a Referer — hook.js, the desktop app and
// bin/ send none — so nothing that reached the deck before is turned away by
// this, and the deck's own page names a loopback Host whatever it sends.
//
// THE HOST IS NOW READ ON EVERY REQUEST THAT CARRIES ONE. Whether a request
// is browser-shaped is the sending page's choice as much as the browser's — a
// page's own GET need carry none of the three marks — so it no longer decides
// whether the Host is asked about. Every client of this server that is not a
// browser dials 127.0.0.1 — hook.js, the desktop app, bin/ and deck-probe.mjs
// — so the Host Node fills in for them is a loopback one, and they are
// answered exactly as before. Two shapes still pass under a name that is not
// loopback:
//
//   - no Host at all, which is HTTP/1.0 tooling and never a browser — every
//     browser sends one;
//   - the deck's token (`token`, the raw x-ccdeck-token header), which only a
//     process that read the 0600 discovery file can present, and only on a
//     request that is not browser-shaped. A request a page chose is refused
//     whoever else may be behind it, as isTrustedMutation's is.
//
// Deliberately not part of this: the Sec-Fetch-Site test that isTrustedMutation
// applies. `cross-site` on a read is an ordinary top-level navigation — a link
// to http://localhost:4317 clicked on any page — and the document it loads is
// the deck's own UI on the deck's own origin, which is not an attack and used
// to work. Rebinding does not need that test either: a rebound page's requests
// report `same-origin`, and it is the Host that gives it away.
export function isTrustedRead({ origin, host, secFetchSite, referer, token } = {}) {
  const browserShaped = (typeof origin === "string" && origin !== "")
    || (typeof secFetchSite === "string" && secFetchSite.trim() !== "")
    || (typeof referer === "string" && referer.trim() !== "");
  if (browserShaped) return isLoopbackHost(host);
  if (typeof host !== "string" || host.trim() === "") return true;
  return isLoopbackHost(host) || presentsDeckToken({ "x-ccdeck-token": token });
}

// Is this mutating request allowed to be acted on?
//
// The deck binds 127.0.0.1, which sounds private but is reachable from every
// page the user's browser has open: a cross-site POST with a CORS-safelisted
// `Content-Type: text/plain` fires no preflight, so any visited page could
// remove a Claude account, import an attacker-crafted one, switch the live
// account, flip auto-switching, start a global npm upgrade, restart the deck
// or truncate the event log. None of those need to read the response, so the
// same-origin policy alone never stopped them.
//
// Two headers decide it, and both are set by the browser itself — page script
// cannot forge either, they are forbidden header names:
//
//   Sec-Fetch-Site  present on every modern-browser request. `same-origin`
//                   (our own UI) and `none` (the user typed the URL) pass;
//                   `cross-site` and `same-site` are exactly the attack and
//                   are refused. Absent on older Safari, hence the second half.
//   Origin          present on every browser POST, including same-origin ones.
//                   It must name this very server: comparing it to the Host
//                   header the browser filled in from the target URL. A page
//                   on http://evil.com — or on http://localhost:8000, which is
//                   just as cross-origin — cannot make the two agree. The
//                   opaque `null` origin (sandboxed iframe, data: URL) fails
//                   to parse and is refused with it.
//
// Agreement between the two is necessary but not sufficient, because both are
// derived from the URL the page was served from and neither says a word about
// the address the socket actually landed on — so the Host must also name a
// loopback identity. See isLoopbackHost for the attack that gets through
// without it.
//
// A request carrying neither header is not a browser request and this gate
// allows it whatever Host it names: that is hook/hook.js, a plain Node
// http.request from the user's own machine that sends no Origin at all, plus
// curl and the deck's own tooling. Ambient browser authority is the whole
// threat here, and those clients have none — a process that can POST here can
// already run anything as the user, and nothing it sends is chosen by a page.
// The name such a request is addressed to is isTrustedRead's question, which
// the router asks first, of every method.
export function isTrustedMutation({ origin, host, secFetchSite } = {}) {
  const site = typeof secFetchSite === "string" ? secFetchSite.trim().toLowerCase() : "";
  if (site && site !== "same-origin" && site !== "none") return false;
  const hasOrigin = typeof origin === "string" && origin !== "";
  if (!hasOrigin && !site) return true;
  // Either header present means a browser sent this, so the rebinding gate
  // applies even to the shape that carries fetch metadata but no Origin. Every
  // request reaching this line is browser-shaped by the test just above, so
  // isTrustedRead here is exactly its isLoopbackHost half.
  if (!isTrustedRead({ origin, host, secFetchSite })) return false;
  return hasOrigin ? originMatchesHost(origin, host) : true;
}

// Was this request addressed to a name that can only ever be this machine?
//
// Origin === Host alone is not a defence against DNS rebinding: the page is
// served from http://attacker.example:4317, the attacker re-points that record
// at 127.0.0.1, and the browser then sends Host: attacker.example:4317 with a
// matching Origin and Sec-Fetch-Site: same-origin — every header self-consistent
// and every one attacker-chosen, because fetch metadata comes from the origin
// tuple (scheme, host, port), not from the resolved IP. The browser also treats
// the reply as same-origin, so the page reads the body: that is the account
// share envelope, with the OAuth token in it. A loopback literal has no DNS
// record to re-point, and `localhost` is reserved to loopback, so requiring one
// of them is what separates the deck's own UI from the rebound page.
//
// Exported for the git view's hand-offs, which ask it of every launch as one of
// the tests that a request came from this machine (git-handoff-launch.mjs).
export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const authority = host.trim().toLowerCase();
  // A real Host header is bare authority. Userinfo or a path would let
  // `evil.example@127.0.0.1` and `127.0.0.1/…` parse to a loopback hostname
  // while naming something else, so refuse them rather than reason about them.
  if (authority === "" || /[/\\?#@\s]/.test(authority)) return false;
  let name;
  try { name = new URL(`http://${authority}`).hostname; } catch { return false; }
  if (name === "localhost" || name === "[::1]") return true;
  // The whole 127.0.0.0/8 is this machine, not just .0.1 — a second deck parked
  // on 127.0.0.2 is as local as the first. URL only produces a dotted quad for
  // something it already validated as an IPv4 address, so shape is enough here.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

// Does `origin` name the same host:port the request was addressed to? Ports are
// part of an origin, so http://127.0.0.1:8000 is not http://127.0.0.1:4317 —
// and the default port is spelled both ways depending on the client, so it is
// normalised off both sides before comparing.
function originMatchesHost(origin, host) {
  if (typeof host !== "string" || host === "") return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  const dropDefaultPort = (h, scheme) =>
    h.replace(scheme === "https:" ? /:443$/ : /:80$/, "");
  const fromOrigin = dropDefaultPort(parsed.host.toLowerCase(), parsed.protocol);
  const fromHost = dropDefaultPort(host.trim().toLowerCase(), parsed.protocol);
  return fromOrigin !== "" && fromOrigin === fromHost;
}

// Mutating routes that ask nothing of the caller beyond the gates above.
//
// Only the hook's ingest, and only because hook/hook.js is installed OUTSIDE
// this package — it lives in the user's ~/.claude and is loaded by whatever
// Claude Code session is already running. Requiring a credential here would
// stop every event from every session whose hook predates this change, on a
// machine where nothing is obviously broken and nothing says why, until each
// one is reinstalled. It also carries no credential and destroys nothing: the
// worst a caller does with it is draw a session on the canvas that is not
// there. See the handshake in hook/hook.js for the authentication that does
// run on this path, which is the deck proving itself to the hook.
//
// That "destroys nothing" is a claim about the whole ingest path and not only
// about this line, and #625 is what it cost the day it stopped being true: the
// ring buffer bounded the events it kept by count and not by size, so about 430
// posts of a maximum-size body — from a local process holding no credential,
// which is exactly what this set permits — reached the heap limit and aborted
// the process. Whatever else is added to this set, the same question has to be
// asked of it: what does an unbounded number of these accumulate in? For this
// one the answer is now MAX_BUFFER_CHARS.
//
// #674 is the same question asked a second time, and the answer was not in the
// ring at all. The body of this POST carries `transcript_path`, and everything
// the deck learns about a session's model, cost, name and context is read out
// of the file it names — so the credential-free route does not stop at the ring
// buffer, it reaches the filesystem, with a path the caller chose. It was read
// by allocating the whole file: 700 MB named in one POST took a fresh deck from
// 52 MB RSS to 753 MB and answered `200 {"ok":true,"seq":1}`, and because a
// file with no newline in it could never advance the scan cursor, every later
// POST paid it again. What bounds it now is three things, in the order they
// were reached for: `isClaudeTranscriptPath` means an unrecognised path is not
// opened at all, so the caller who holds no credential can name nothing;
// MAX_SCAN_CHUNK means no single read allocates more than 8 MiB whatever it is
// pointed at; MAX_SCAN_BYTES_PER_PASS means no single POST walks more than 256
// MiB of a file.
//
// #992 is the same question asked of the Codex half of this route, which the
// paragraph above never covered. A `provider: "codex"` event carries a
// `session_id` and no path, and the deck looks that id up by walking
// $CODEX_HOME/sessions. A miss was never kept, so every id no rollout carries
// walked the whole history again on every throttled pass, and a burst of fresh
// ids walked it once each, all at once. What bounds it now is
// findCodexRolloutPath: at most one walk of the whole tree per id in any
// CODEX_MISS_TTL_MS, never two in flight, and every other lookup reads the
// newest two day directories. A caller with an endless supply of fresh ids can
// keep that one walk busy; it cannot make it two.
//
// So the claim above holds again, with its scope written out: the worst a
// caller does with this route is draw a session on the canvas that is not
// there. It cannot make the deck open a file of its choosing, and it cannot
// make the deck's memory a function of anything but the two constants named
// here.
export const OPEN_MUTATIONS = new Set(["/api/event"]);

// Constant-time comparison of two secrets, and a length test that is not.
// Lengths differ freely in public — a mismatched one only says "not this
// token" — but timingSafeEqual throws rather than answering false when they do.
function secretEquals(given, expected) {
  const a = Buffer.from(String(given ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Does this request carry the deck's own token?
//
// One spelling, `x-ccdeck-token`, carrying the token itself. That is all a
// local process needs, because the only way it can hold the token is to have
// read it out of a file only it can open.
//
// The token is HOOK_TOKEN, fresh per deck and written to the discovery file at
// mode 0600. That mode is the whole of the access control: the answer to "who
// may do this" is "whoever can read that file", which is the user this deck
// runs as and nobody else. On Windows the chmod is a best-effort no-op, so
// there the file's protection is the per-user ACL on the profile directory it
// sits in rather than a mode bit; the token still works identically.
//
// The hashed challengeProof form is deliberately NOT accepted here, and this
// is the paragraph that must be read before anyone adds it. GET
// /api/hook-challenge?nonce=… answers challengeProof(HOOK_TOKEN, nonce) to any
// caller for any nonce, by design — so accepting a proof as a credential means
// the server hands out its own credentials on request, and two unauthenticated
// GETs are a complete bypass of everything below. This gate shipped that way
// for one commit; the regression test in csrf-origin.test.ts pins it shut.
//
// The premise that makes the oracle safe is the one this gate rejects, which is
// exactly why the two cannot share a secret: the challenge is the deck proving
// itself TO the hook, not the hook proving itself to the deck. hook/hook.js
// already holds the token — it read the same 0600 file — and challenges the
// port to find out whether the process listening there is really the deck that
// wrote it, or something else that inherited the port number from a stale
// discovery file. Nothing travels in the other direction, so no caller ever
// needed the hashed form as a way IN, and a client entitled to mutate holds the
// token itself anyway.
export function presentsDeckToken(headers = {}) {
  const raw = headers["x-ccdeck-token"];
  return typeof raw === "string" && secretEquals(raw.trim(), HOOK_TOKEN);
}

// Is this the deck's own page in the user's browser?
//
// A strict subset of isTrustedMutation, which every request here has already
// passed: an Origin must actually be present — a browser sends one on every
// POST, including a same-origin one — it must name this very server, the Host
// must be a loopback identity, and any fetch metadata must say `same-origin`.
// `none` is excluded on purpose: that is a top-level navigation the user typed
// or a form submitted from one, never the UI's own fetch.
function isDeckUiRequest({ origin, host, secFetchSite } = {}) {
  const site = typeof secFetchSite === "string" ? secFetchSite.trim().toLowerCase() : "";
  if (site !== "" && site !== "same-origin") return false;
  if (typeof origin !== "string" || origin === "") return false;
  if (!isLoopbackHost(host)) return false;
  return originMatchesHost(origin, host);
}

// May this request change something?
//
// Everything above this line is about the browser: whether a page chose the
// request, and whether it was addressed to this machine. None of it asks who
// the caller is, and for a client that is not a browser at all nothing did —
// a request carrying no Origin and no fetch metadata was waved through on the
// reasoning that a process able to POST here can already run anything as the
// user. That holds on a single-user laptop and fails twice elsewhere. Loopback
// is not scoped to a UID, so on a shared box or a multi-tenant container every
// other account on the machine can reach this port; and a sandboxed subprocess
// denied the credential store but allowed loopback egress — the ordinary shape
// of an agent's Bash sandbox — reaches the same credentials through the API.
// `curl -XPOST localhost:4317/api/claude-accounts/admin -d '{"action":"share"}'`
// answered with the account's live OAuth refresh token in the clear, and the
// same request reached account remove and import, the live account switch, a
// global `npm i -g`, the restart and the event log.
//
// So a mutation must now be either of two things:
//
//   - the user's own browser tab, recognised by the headers a page cannot
//     forge and the deck's own loopback address (isDeckUiRequest), or
//   - a client holding the deck's token, which it can only have read from the
//     0600 discovery file (presentsDeckToken).
//
// What this does NOT do, stated plainly so nobody mistakes it for more: the
// browser clause rests on headers that page script cannot set but any local
// program can. A local attacker who adds `Origin` and `Sec-Fetch-Site` to the
// request is back through. That is not a gap left by laziness — there is no
// fix for it here. Authenticating the tab would mean giving the tab a secret,
// and every channel from this process to a browser on the same machine is
// readable by any other process on that machine: a token in the served
// index.html is read by the same `curl http://localhost:4317/` that the gate
// is meant to stop, and a token in the URL the deck opens is read out of the
// browser's argv by `ps`. What is closed is the free pass — a request that
// presents nothing at all no longer changes anything — and what is opened is
// the honest door, so a script of the user's own authenticates by reading the
// token instead of impersonating a page.
/**
 * May this request read the deck's OWN data — the events, the accounts, the
 * browsing episodes?
 *
 * The mutation gate exists because `curl -XPOST localhost:4317/…/admin` handed
 * a live OAuth refresh token to a sandboxed subprocess with loopback egress.
 * The same caller could still `curl localhost:4317/api/events` and read the
 * whole ring — prompt text, the Bash command lines the agent ran, the paths and
 * contents it wrote, the contents of every file it read back — plus the account
 * roster and the browsing episodes. The threat model had been applied to half
 * the surface.
 *
 * Same shape as isAuthorizedMutation, with one difference forced by the
 * browser: a same-origin GET carries no `Origin` header at all, so the UI
 * cannot be recognised the way a POST is. `Sec-Fetch-Site: same-origin` is what
 * a page's own fetch and its EventSource both send, on every browser new enough
 * to run this bundle, and it is a header no non-browser client sends by
 * accident. A caller that sends neither it nor the token is not a page.
 *
 * WHAT STAYS OPEN, deliberately: /api/health (the hook's readiness probe),
 * /api/hook-challenge (the handshake itself), the static files, and every
 * measurement route — the machine panel's numbers are about the machine, not
 * about what the user is doing on it.
 */
export function isAuthorizedDataRead(req) {
  const headers = req?.headers ?? {};
  if (presentsDeckToken(headers)) return true;
  // Addressed to this machine by a name that can only be this machine — so a
  // rebound page, which also reports same-origin, does not qualify.
  if (!isLoopbackHost(headers.host)) return false;

  const site = typeof headers["sec-fetch-site"] === "string"
    ? headers["sec-fetch-site"].trim().toLowerCase() : "";
  if (site === "same-origin") return true;
  // ANY FETCH METADATA AT ALL, AND IT SAID SOMETHING ELSE. `cross-site`,
  // `same-site` and `none` are all a page that is not this one — or a top-level
  // navigation typed into the address bar, which has no business reading the
  // ring.
  if (site !== "") return false;

  // THE BROWSER THAT SENDS NO FETCH METADATA, and this is the whole reason this
  // branch exists. Sec-Fetch-Site is Safari 16.4 and newer; Safari 16.0-16.3
  // runs this bundle perfectly well (Vite's default target is Safari 16) and
  // sends none of it. Without a fallback those users get an empty canvas and a
  // 401 they cannot act on — an impediment for a browser that is otherwise
  // fine.
  //
  // Referer is what they do send, on a page's own fetches and on its
  // EventSource, and it must name THIS origin. A cross-site page's Referer
  // names its own; a rebound page's names the attacker's host, which is not a
  // loopback identity. It is forgeable by a non-browser client — and so is
  // Sec-Fetch-Site, which curl sets as easily; neither is the control that
  // stops a deliberate local caller. That control is the token, and this only
  // decides which BROWSERS are recognised as the deck's own page.
  return originMatchesHost(headers.referer, headers.host);
}

/** The reads that carry the user's own work, rather than the machine's.
 *
 *  `/api/lan` and `/api/prefs` were missing, and they are the same class of
 *  secret as the four that were here. Measured against a running deck with a
 *  request carrying no headers at all — the sandboxed subprocess with loopback
 *  egress that isAuthorizedDataRead names above, or another UID on a shared
 *  box — `/api/claude-accounts` answered 401 and `/api/lan` answered 200 with:
 *
 *    • `shared`, one `<email>@@<organization uuid>` per account this deck
 *      offers — the address of every Claude login on the machine;
 *    • `peers[].offers.accounts[]`, the same for every paired deck, plus each
 *      one's LAN address, port, hostname, OS and ccdeck version;
 *    • `invite`, whenever the owner has one open — and that one is a bearer
 *      credential, not a description. readInvite -> connectToPeer({code}) ->
 *      onInviteUsed pins the caller as trusted with nobody pressing anything,
 *      and a trusted deck may then send `manifest` and `want` and receive the
 *      sealed OAuth credentials for every shared account.
 *
 *  `/api/prefs` carries the narrower half: publicPrefs already strips
 *  `lan.secret` and every `trusted[].pub`, which was the part that had to be
 *  right, but it keeps `lan.shared` — the same addresses — and every trusted
 *  peer's name and fingerprint.
 *
 *  Neither route has a caller outside the deck's own page, so guarding them
 *  costs nothing: every fetch of both is in src/web, and a page's own GET
 *  carries Sec-Fetch-Site: same-origin. */
export const GUARDED_READS = new Set([
  "/events",
  "/api/events",
  "/api/claude-accounts",
  "/api/claude-accounts/login",
  "/api/browser-watch",
  "/api/lan",
  "/api/prefs",
  // Per-account, per-project token spend — the user's own work, the same class
  // of secret as the accounts list it hangs off.
  "/api/account-projects",
  // The signed-in Codex account's email, plan type and credit balance ride on
  // this answer (codex-quota.mjs), which is the account identity the roster
  // route above is guarded for.
  "/api/codex-quota",
  // And the rest of the usage panel, by the rule /api/account-projects is here
  // under: the active account's quota windows, Claude's spend by day and by
  // session, Codex's token spend, and the auto-switch settings with the last
  // account it moved to. Each is about what the user is doing rather than about
  // the machine, and each has one caller, the deck's own page in src/web —
  // the desktop app, bin/ and the hook never read them.
  "/api/quota",
  "/api/ccusage",
  "/api/codex-usage",
  "/api/cswap-auto",
  // Not a secret, and here for the other reason a read can be dangerous: it is
  // the one route where the caller names what the deck goes and fetches
  // (#1208). fm-station.mjs holds that to YouTube, but a page on another site
  // still had a way to make this process download pages on demand, and the
  // only caller that needs it is the deck's own canvas, which sends
  // Sec-Fetch-Site: same-origin on every fetch.
  "/api/fm-station",
  // A session's repository: its history, its working tree and the content of
  // every change in it — the user's own work, like the per-project spend
  // above. The deck's own page is the only caller.
  "/api/git/repo",
  "/api/git/log",
  "/api/git/status",
  "/api/git/diff",
  "/api/git/commit",
  // Which files each of a session's agents edited, by path in its repository.
  "/api/git/edits",
  // Its branches, tags, stashes, worktrees and submodules, for the sidebar.
  "/api/git/refs",
  // Which git client, editor and terminal this machine has, and the picks.
  "/api/git/handoffs",
]);

export function isAuthorizedMutation(req) {
  const headers = req?.headers ?? {};
  if (presentsDeckToken(headers)) return true;
  return isDeckUiRequest({
    origin: headers.origin,
    host: headers.host,
    secFetchSite: headers["sec-fetch-site"],
  });
}
