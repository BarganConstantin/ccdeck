// The port fallback knew only the POSIX spelling of "you may not have this
// port" (#552).
//
// startServer builds ten random fallback candidates out of `portRange` and then
// walked to them from exactly one errno:
//
//     if (err && err.code === "EADDRINUSE") continue;
//     throw err;
//
// EADDRINUSE is what a POSIX machine says when something is already listening,
// and on POSIX it really is the only answer a port above 1024 can give — a
// `listen` EACCES there needs a privileged port, and neither 4317 nor 4318–4400
// is one. So the branch looked complete from the operating system it was written
// on and was missing half its cases on the one it was written for.
//
// WINDOWS. `winnat` hands contiguous TCP blocks to Hyper-V, WSL2 and Docker
// Desktop — the exclusion ranges `netsh interface ipv4 show excludedportrange
// protocol=tcp` prints — and a bind inside one is refused with WSAEACCES, which
// libuv reports as EACCES. Nothing is listening on the port; the machine has
// simply reserved it. On any developer laptop with containers on it, 4317 can
// land inside a range, the very first candidate rethrew, bin/deck.js printed
//
//     ccdeck: server failed: listen EACCES: permission denied 127.0.0.1:4317
//
// and the process exited 1 with the ten fallback ports never tried and no hint
// of what to do about it.
//
// The fix is not "retry on everything", and that is the half this file spends
// most of its cases on. EADDRNOTAVAIL, ENOTFOUND and EAI_AGAIN are about the
// HOST — an address this machine does not hold, a name that does not resolve —
// and eleven candidates would fail eleven times identically before saying so.
// Those stop the loop and get a sentence instead.
//
// ── why the shapes are what they are ────────────────────────────────────────
//
// `portRetryable`, `listenHint` and `listenFailure` are pure and take `platform`
// as a parameter, because the branch that matters is on the operating system the
// author cannot run — the same reason candidates(), isBatch() and spawnSpec()
// in src/server/exec.mjs are written that way. Every Windows case below
// therefore runs on Linux and macOS too; a `skipIf(process.platform !== "win32")`
// here would mean the Windows answer is only ever checked on the one CI leg
// least likely to be looked at.
//
// The two integration cases at the end are what stops those pure functions from
// being decorative: they drive the real `startServer` and read WHICH PORT the
// failure names. A loop that walked its candidates ends on one from `portRange`;
// a loop that stopped at the first ends on the port it was asked for. That is
// the only externally visible difference between the two behaviours, and it
// needs no privileges, no Windows and no network — 192.0.2.1 is RFC 5737
// documentation space, which no machine is allowed to hold.
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server as NetServer } from "node:net";
import { rmTempDir } from "./rm-temp-dir";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Temp home before the import: startServer sweeps a discovery directory under
// it, and the real ~/.agents-deck must stay untouched.
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-listen-552-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
for (const p of [process.env.HOME, process.env.USERPROFILE, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME]) {
  if (!resolve(p!).startsWith(resolve(DIR))) throw new Error(`sandbox escaped: ${p}`);
}

// @ts-expect-error — plain .mjs module, no types
const { portRetryable, listenHint, listenFailure, startServer } = await import("../../server/index.mjs") as {
  portRetryable: (err: unknown) => boolean;
  listenHint: (code: string | undefined, o?: { host?: string; port?: number; platform?: string }) => string;
  listenFailure: (err: unknown, o?: { host?: string; port?: number; platform?: string; exhausted?: boolean }) => Error & { code?: string };
  startServer: (o: Record<string, unknown>) => Promise<unknown>;
};

const errno = (code: string, message = `listen ${code}`) => Object.assign(new Error(message), { code });

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  rmTempDir(DIR);
});

describe("which failed binds another port could fix", () => {
  it("treats a port that is already listening as one to walk past", () => {
    // The case that always worked, kept so a rewrite cannot lose it.
    expect(portRetryable(errno("EADDRINUSE"))).toBe(true);
  });

  it("treats Windows' reserved-range refusal as one to walk past too", () => {
    // WSAEACCES from inside a winnat exclusion range. Nothing is listening on
    // the port, so the ten random candidates are exactly the right answer — and
    // before #552 this was the errno that ended the boot on the first try.
    expect(portRetryable(errno("EACCES", "listen EACCES: permission denied 127.0.0.1:4317"))).toBe(true);
  });

  it("stops on an address this machine does not hold", () => {
    // The port is not the problem and no candidate can become one that is.
    expect(portRetryable(errno("EADDRNOTAVAIL"))).toBe(false);
  });

  it("stops on a host that does not resolve", () => {
    expect(portRetryable(errno("ENOTFOUND"))).toBe(false);
    expect(portRetryable(errno("EAI_AGAIN"))).toBe(false);
  });

  it("stops on an errno it has never heard of, rather than guessing", () => {
    // Ten more binds is not a safe default for an unknown failure: it delays
    // the message and, on the errors that come from the socket itself, repeats
    // whatever went wrong ten times.
    expect(portRetryable(errno("EAFNOSUPPORT"))).toBe(false);
    expect(portRetryable(errno("EPERM"))).toBe(false);
    expect(portRetryable(null)).toBe(false);
    expect(portRetryable(undefined)).toBe(false);
    expect(portRetryable(new Error("no code at all"))).toBe(false);
  });
});

describe("the sentence that goes beside the errno", () => {
  it("names the command that lists Windows' reserved ranges", () => {
    // The whole point of the hint. A user reading `permission denied` on a port
    // nothing is using has no way to guess that Hyper-V reserved it, and the
    // one thing that tells them is a netsh incantation nobody remembers.
    const hint = listenHint("EACCES", { host: "127.0.0.1", port: 4317, platform: "win32" });
    expect(hint).toContain("netsh interface ipv4 show excludedportrange");
    expect(hint).toMatch(/Hyper-V|WSL2|Docker/);
    expect(hint).toContain("--port");
  });

  it("says something different on POSIX, where EACCES means a privileged port", () => {
    // Same errno, entirely different cause, and the Windows advice would be
    // nonsense here. Both branches are checked from whichever OS runs the
    // suite, which is why `platform` is a parameter rather than a lookup.
    const low = listenHint("EACCES", { host: "127.0.0.1", port: 80, platform: "linux" });
    expect(low).toMatch(/below 1024/);
    expect(low).not.toContain("netsh");

    const high = listenHint("EACCES", { host: "127.0.0.1", port: 4317, platform: "darwin" });
    expect(high).not.toMatch(/below 1024/);
    expect(high).not.toContain("netsh");
  });

  it("says that another port cannot help when the address is the problem", () => {
    // The user has to be told this explicitly: the deck moving itself to a
    // random port is exactly what it does for the OTHER errnos, so silence here
    // reads as "it will sort itself out".
    const hint = listenHint("EADDRNOTAVAIL", { host: "10.1.2.3", port: 4317, platform: "linux" });
    expect(hint).toContain("10.1.2.3");
    expect(hint).toContain("--host");
    expect(hint).toMatch(/no other port can help/);
  });

  it("adds nothing to an errno that already explains itself", () => {
    // EADDRINUSE needs no gloss, and a hint on every line is a hint nobody
    // reads.
    expect(listenHint("EADDRINUSE", { host: "127.0.0.1", port: 4317, platform: "win32" })).toBe("");
    expect(listenHint(undefined, { platform: "linux" })).toBe("");
  });
});

describe("the error the deck prints when it could not bind at all", () => {
  it("keeps the opening words bin/deck.js and the boot test read", () => {
    const err = listenFailure(errno("EADDRINUSE"), { host: "127.0.0.1", port: 4399, exhausted: true, platform: "linux" });
    expect(err.message).toMatch(/^all ports tried/);
  });

  it("names the errno it actually ended on rather than asserting EADDRINUSE", () => {
    // The old exhaustion error hard-coded `code: "EADDRINUSE"`, which became a
    // lie the moment EACCES could reach the end of the loop: a Windows user
    // whose whole fallback range sat inside a reserved block would have been
    // told every port was in use.
    const err = listenFailure(errno("EACCES"), { host: "127.0.0.1", port: 4399, exhausted: true, platform: "win32" });
    expect(err.message).toContain("EACCES");
    expect(err.message).toContain("127.0.0.1:4399");
    expect(err.code).toBe("EACCES");
    expect(err.message).toContain("netsh interface ipv4 show excludedportrange");
  });

  it("keeps a single failure's own message when it stopped early", () => {
    // Not exhaustion: one bind, one reason. libuv's own sentence is the most
    // precise thing anyone will get, so it is kept and the hint is added after
    // it rather than in place of it.
    const err = listenFailure(errno("EADDRNOTAVAIL", "listen EADDRNOTAVAIL: address not available 10.1.2.3:4317"),
      { host: "10.1.2.3", port: 4317, platform: "linux" });
    expect(err.message).toContain("listen EADDRNOTAVAIL: address not available 10.1.2.3:4317");
    expect(err.message).toContain("--host");
    expect(err.code).toBe("EADDRNOTAVAIL");
  });

  it("keeps the original error reachable as a cause", () => {
    const original = errno("EACCES");
    expect(listenFailure(original, { host: "127.0.0.1", port: 4317, platform: "win32" }).cause).toBe(original);
  });
});

// ── the loop itself, driven for real ────────────────────────────────────────
// Which port the failure names is the observable difference between "walked all
// eleven candidates" and "stopped at the first", and both cases below get there
// without a privilege, a mock or a Windows.

describe("startServer against a port nothing will ever give it", () => {
  let squatter: NetServer | null = null;

  afterAll(async () => {
    if (squatter) await new Promise<void>(done => squatter!.close(() => done()));
    squatter = null;
  });

  it("walks every candidate for EADDRINUSE and then says which port it ended on", async () => {
    // One port, occupied, used as BOTH the request and the whole fallback range
    // — so all eleven candidates are the same taken port and the loop has to run
    // to the end. The message names it, which is the proof it got there.
    const taken = await new Promise<number>((done, fail) => {
      const s = createServer();
      s.on("error", fail);
      s.listen(0, "127.0.0.1", () => { squatter = s; done((s.address() as { port: number }).port); });
    });

    await expect(startServer({
      port: taken, host: "127.0.0.1", persist: null, codex: false, claude: false,
      portRange: [taken, taken],
    })).rejects.toThrow(new RegExp(`all ports tried.*EADDRINUSE.*127\\.0\\.0\\.1:${taken}`));
  }, 30_000);

  it("stops on the first candidate when the ADDRESS is what is wrong", async () => {
    // 192.0.2.1 is RFC 5737 documentation space: no machine is permitted to
    // hold it, so every OS answers EADDRNOTAVAIL and nothing here depends on the
    // runner's network. `portRange` is a port far from the requested one, so
    // the two behaviours cannot be confused — before #552 this threw libuv's
    // bare sentence, and a loop that retried would have ended on 45999.
    await expect(startServer({
      port: 45123, host: "192.0.2.1", persist: null, codex: false, claude: false,
      portRange: [45999, 45999],
    })).rejects.toThrow(/EADDRNOTAVAIL/);

    const err = await startServer({
      port: 45123, host: "192.0.2.1", persist: null, codex: false, claude: false,
      portRange: [45999, 45999],
    }).then(() => null, (e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("192.0.2.1");
    expect(err!.message).not.toContain("45999");
    expect(err!.message).not.toMatch(/all ports tried/);
    // And the sentence that stops the user re-running it with a different port.
    expect(err!.message).toContain("--host");
  }, 30_000);
});
