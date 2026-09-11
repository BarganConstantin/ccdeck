// Is that process a deck, and is it still there — asked from anywhere.
//
// These four lived in src/server/index.mjs, which is the whole server: 5,800
// lines, a dozen watchers, and timers that arm the moment the module is
// imported. Everything that had to ask one of these questions therefore had to
// import all of that, and three callers cannot:
//
//   • running-deck.mjs, read on the boot path before anything else, which for
//     one commit took both of these as PARAMETERS purely to avoid the import.
//   • `ccdeck --stop` and `--status`, one-shot commands that talk to a deck and
//     exit. Starting a server to ask a server to stop is absurd on its face,
//     and on a cold start it is also slower than the thing it is asking for.
//   • the tests, which pin these against hook/hook.js's copy and should cost a
//     millisecond rather than a server boot.
//
// So they moved down here, to a leaf that imports two node builtins and nothing
// else. index.mjs imports them from here and RE-EXPORTS them under the names it
// always had, so every existing caller and every existing test is untouched —
// and there is still exactly one spelling of the handshake in the package.
//
// hook/hook.js keeps its own duplicate of challengeProof for the one reason
// that has always justified it: that script is copied out of the package and
// installed into ~/.claude, where it cannot import from anywhere. A test pins
// the two spellings against each other, and that test is the only thing
// standing between a changed hash and a deck that silently stops being told
// anything.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest } from "node:http";

// The same deadline hook.js gives a challenge, and for the same reason: a
// bodyless GET to a loopback port is sub-millisecond when a deck is there and an
// instant ECONNREFUSED when nothing is.
export const DECK_CHALLENGE_TIMEOUT_MS = 400;

// Signal 0 delivers nothing; it asks whether the pid could be signalled.
//
// BOTH ERRNOS, and the second one is the Windows spelling. POSIX `kill(2)`
// answers EPERM for a process this account may not signal. On Windows
// `uv_kill` calls `OpenProcess`, a denial is ERROR_ACCESS_DENIED, and libuv
// maps that to EACCES — so a deck started from an elevated terminal, or under
// another account, read as DEAD to every probe in this repo. What followed was
// silent: the live deck's discovery file was unlinked on the next hook fire,
// rewritten five seconds later by keepDiscovery, and its banner went on
// claiming it was receiving events it had stopped receiving.
export function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && (e.code === "EPERM" || e.code === "EACCES"); }
}

/**
 * The proof of knowing `token`, for a nonce the challenger chose.
 *
 * hook/hook.js spells this out a second time — it is installed outside the
 * package and cannot import from here — and a test pins the two against each
 * other. Changing one without the other silently blinds the deck.
 */
export function challengeProof(token, nonce) {
  return createHash("sha256").update(`${token}:${nonce}`).digest("hex");
}

/**
 * One challenge round trip, resolving true only on a correct proof.
 *
 * The compare is constant-time for the reason hook.js's sameProof is: whatever
 * is on that port may not be a deck, and it must not be able to walk the
 * expected proof out of us one byte at a time by timing how long we take to hang
 * up. The nonce is fresh per call, so an answer overheard earlier is worth
 * nothing, and the token itself never leaves this process.
 */
export function challengeDeck(port, token) {
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => { if (settled) return; settled = true; resolve(ok); };
    const nonce = randomBytes(16).toString("hex");
    const want = challengeProof(token, nonce);
    const req = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: `/api/hook-challenge?nonce=${nonce}`,
      method: "GET",
      timeout: DECK_CHALLENGE_TIMEOUT_MS,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return res.on("end", () => finish(false)); }
      let answer = "";
      res.setEncoding("utf8");
      res.on("data", c => {
        answer += c;
        // A deck answers in ~100 bytes. Anything pouring data at us is not one,
        // and must not be allowed to grow this buffer without bound.
        if (answer.length > 4096) { req.destroy(); finish(false); }
      });
      res.on("end", () => {
        if (settled) return;
        let proof;
        try { proof = JSON.parse(answer).proof; } catch { return finish(false); }
        finish(sameProof(proof, want));
      });
    });
    req.on("error", () => finish(false));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

/** hook.js's sameProof, for the same reason it is constant-time there. */
export function sameProof(got, want) {
  if (typeof got !== "string") return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
