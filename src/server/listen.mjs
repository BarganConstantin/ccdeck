// Getting a port: the random fallback candidates, one listen attempt, and what
// to say when an attempt fails.
//
// These lived in src/server/index.mjs near startServer, whose listen loop is
// their only caller, and they ask nothing of the deck — a port range in, a
// bound server or a worded error out. The loop itself stays in startServer,
// because what it starts after the bind that takes is the deck's business, and
// the order of those starts is pinned there. portRetryable, listenHint and
// listenFailure were exported already, so that every platform's answer can be
// asserted on any of them.

export function randomPort(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// One attempt, leaving the server with no more listeners on it than it started
// with. `server.listen(port, host, cb)` registers `cb` for a 'listening' event
// that a failed bind never emits, so the previous shape left one behind per
// attempt — eleven candidates printed Node's "MaxListenersExceededWarning:
// 11 listening listeners added to [Server]" into the middle of a boot that was
// already going wrong. Both sides are removed by whichever fires first.
export async function tryListen(server, port, host) {
  return new Promise((res, rej) => {
    const onListening = () => { server.removeListener("error", onError); res(); };
    const onError = (err) => { server.removeListener("listening", onListening); rej(err); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * Whether another PORT could fix this failed `listen`.
 *
 * startServer builds ten random fallback candidates and they exist for exactly
 * one situation: "this port is unavailable". Until #552 only EADDRINUSE reached
 * them, which is the POSIX spelling of that answer and not the only one.
 *
 * WINDOWS. `winnat` hands out contiguous TCP blocks to Hyper-V, WSL2 and Docker
 * Desktop, and a bind INSIDE one of those reserved exclusion ranges — the ones
 * `netsh interface ipv4 show excludedportrange protocol=tcp` prints — is refused
 * with WSAEACCES, which libuv reports as EACCES. Any machine with containers or
 * WSL on it can therefore have 4317 blocked without a single socket being open
 * on it. The loop rethrew on the first candidate, bin/deck.js printed
 * `server failed: listen EACCES: permission denied 127.0.0.1:4317`, and the deck
 * exited 1 with the fallback range untouched.
 *
 * On POSIX the same code is what a bind below 1024 gets without privilege.
 * Retrying is right there too: 4317 and the whole fallback range are above 1024,
 * so a random candidate is a port the user can actually have — and the deck
 * coming up on 4322 beats it refusing to come up at all, which is already how
 * EADDRINUSE on a privileged port behaves today.
 *
 * The other direction is the half that keeps this honest. EADDRNOTAVAIL,
 * ENOTFOUND, EAI_AGAIN and EAFNOSUPPORT are about the HOST, not the port: the
 * address does not exist on this machine or does not resolve, and no candidate
 * can help. Walking eleven of them only delays the one sentence that would have
 * explained it, so anything not named here stops the loop.
 */
export const portRetryable = (err) =>
  Boolean(err) && (err.code === "EADDRINUSE" || err.code === "EACCES");

/**
 * The sentence that goes beside a listen errno, or "" when the errno says it
 * all.
 *
 * Pure, and the platform is a parameter, for the reason every Windows answer in
 * this repo is written that way: the branch that matters most is the one the
 * author cannot run. A raw `listen EACCES: permission denied 127.0.0.1:4317` is
 * true and useless — the thing the user needs is the name of the command that
 * lists the ranges their machine has reserved.
 */
export function listenHint(code, { host = "", port = 0, platform = process.platform } = {}) {
  if (code === "EACCES") {
    if (platform === "win32") {
      return "a reserved port range is the usual cause on Windows: Hyper-V, WSL2 and Docker Desktop have winnat hold contiguous TCP blocks. Run `netsh interface ipv4 show excludedportrange protocol=tcp` to see them, then pass --port with a number outside every range";
    }
    if (port > 0 && port < 1024) return "ports below 1024 need root — pass --port with a number above 1024";
    return "the OS refused the bind; a sandbox or a security policy is the usual cause";
  }
  if (code === "EADDRNOTAVAIL") {
    return `no interface on this machine holds ${host || "that address"}, so no other port can help — pass --host with an address it does hold, or 127.0.0.1 for local only`;
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `${host || "that host"} does not resolve, so no other port can help — pass --host with an address rather than a name`;
  }
  return "";
}

/**
 * The error startServer throws, with the hint already in it.
 *
 * `exhausted` is the difference between "every candidate was refused" and "this
 * one was refused for a reason more candidates cannot fix". The exhausted
 * message keeps its opening words — bin/deck.js prints them and
 * boot-listen-before-report.test.ts reads them — and now names the LAST errno
 * rather than asserting EADDRINUSE, which was a lie the moment EACCES could
 * reach the end of the loop.
 */
export function listenFailure(err, { host = "", port = 0, platform = process.platform, exhausted = false } = {}) {
  const code = err?.code;
  const head = exhausted
    ? `all ports tried — none available (last: ${code ?? "unknown"} on ${host}:${port})`
    : String(err?.message ?? err ?? "listen failed");
  const hint = listenHint(code, { host, port, platform });
  const out = new Error(hint ? `${head} — ${hint}` : head);
  if (code !== undefined) out.code = code;
  if (err) out.cause = err;
  return out;
}
