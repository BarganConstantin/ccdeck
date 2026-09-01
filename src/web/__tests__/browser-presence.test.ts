// The relay probe's whole value is what it REFUSES to claim, so that is what
// this file is mostly about.
//
// Two facts measured on the machine this was written on, and every case below
// exists because of one of them:
//
//   dig +short bridge.claudeusercontent.com  ->  160.79.104.10
//   dig +short api.anthropic.com             ->  160.79.104.10
//   lsof … -c "Brave Browser"  ->  14 lines · lsof … -c "Google Chrome"  ->  0
//
// The relay shares an address with the API, so a connection is not evidence of
// a relay session; and lsof cannot see some browsers' sockets, so no connection
// is not evidence either. A probe that can be wrong in both directions has to
// have a third answer, and this is where it is held to having one.
import { describe, it, expect } from "vitest";
import { browserSurvey, isRunning, relayAddresses, relayLink } from "../../server/browser-presence.mjs";

/** A fake `run`, keyed on the command, in the shape exec.mjs returns. */
const runner = (table: Record<string, { ok: boolean; stdout?: string; stderr?: string } | null>) =>
  async (cmd: string) => {
    const out = table[cmd];
    if (out === null) throw new Error("ENOENT");
    return out ?? { ok: false, stdout: "", stderr: "" };
  };

const LSOF_BRAVE_BUSY = [
  "COMMAND   PID  USER   FD TYPE NODE NAME",
  "Brave   12345  me   40u IPv4 TCP  10.0.0.2:52001->160.79.104.10:443 (ESTABLISHED)",
  "Brave   12345  me   41u IPv4 TCP  10.0.0.2:52002->140.82.121.4:443 (ESTABLISHED)",
].join("\n");

describe("what a relay connection is allowed to prove", () => {
  it("calls a hit live, and carries the reason it is not conclusive", async () => {
    // The address is shared with api.anthropic.com and claude.ai. A panel that
    // showed "connected" without that sentence would be making a claim this
    // module has already established it cannot make.
    const out = await relayLink("Brave", ["160.79.104.10"], "darwin",
      { run: runner({ lsof: { ok: true, stdout: LSOF_BRAVE_BUSY } }) });
    expect(out.state).toBe("live");
    expect(out.count).toBe(1);
    expect(out.why).toMatch(/api\.anthropic\.com|claude\.ai/);
  });

  it("does not call a browser it cannot see quiet", async () => {
    // THE ONE THAT MATTERS. lsof returned nothing for Google Chrome while
    // Chrome was running — zero lines, not zero matches. Reporting "none seen"
    // there turns "I cannot look" into "I looked and it was clear", which is
    // the single most misleading thing this panel could say.
    const blind = await relayLink("Google Chrome", ["160.79.104.10"], "darwin",
      { run: runner({ lsof: { ok: true, stdout: "" } }) });
    expect(blind.state).toBe("unknown");
    expect(blind.why).toMatch(/cannot see/i);
  });

  it("says none seen only when the probe demonstrably worked", async () => {
    const quiet = await relayLink("Brave", ["9.9.9.9"], "darwin",
      { run: runner({ lsof: { ok: true, stdout: LSOF_BRAVE_BUSY } }) });
    expect(quiet.state).toBe("none-seen");
    // And still qualified: QUIC does not appear in a TCP listing at all.
    expect(quiet.why).toMatch(/QUIC/);
  });

  it("has no answer that means definitely not connected", async () => {
    // Pinned as a claim about the API rather than about one call: the three
    // states are live, none-seen and unknown, and none of them is "clear".
    const states = new Set<string>();
    states.add((await relayLink("Brave", ["160.79.104.10"], "darwin",
      { run: runner({ lsof: { ok: true, stdout: LSOF_BRAVE_BUSY } }) })).state);
    states.add((await relayLink("Brave", ["9.9.9.9"], "darwin",
      { run: runner({ lsof: { ok: true, stdout: LSOF_BRAVE_BUSY } }) })).state);
    states.add((await relayLink("Brave", [], "darwin", { run: runner({}) })).state);
    expect([...states].sort()).toEqual(["live", "none-seen", "unknown"]);
  });

  it("is unknown where the tool does not exist, rather than clear", async () => {
    const win = await relayLink("chrome", ["1.2.3.4"], "win32", { run: runner({}) });
    expect(win.state).toBe("unknown");
    expect(win.why).toMatch(/lsof/);

    const noTool = await relayLink("Brave", ["1.2.3.4"], "darwin", { run: runner({ lsof: null }) });
    expect(noTool.state).toBe("unknown");
  });

  it("is unknown when the name did not resolve, because there is nothing to match", async () => {
    // Which is also the state a machine is in once the killswitch is on — the
    // block works by making the name not resolve.
    const out = await relayLink("Brave", [], "darwin", { run: runner({}) });
    expect(out.state).toBe("unknown");
    expect(out.why).toMatch(/did not resolve/);
  });
});

describe("resolving the relay", () => {
  it("keeps the addresses and drops the noise", async () => {
    const out = await relayAddresses("bridge.example.com",
      { run: runner({ dig: { ok: true, stdout: "some-alias.example.com.\n160.79.104.10\n\n" } }) });
    expect(out).toEqual(["160.79.104.10"]);
  });

  it("answers empty rather than throwing when dig is not there", async () => {
    expect(await relayAddresses("bridge.example.com", { run: runner({ dig: null }) })).toEqual([]);
  });
});

describe("whether a browser is running", () => {
  it("tells a clean no from a failure to ask", async () => {
    // pgrep exits 1 when it matched nothing, which `run` reports the same way
    // it reports a missing pgrep. Only stderr separates them, and conflating
    // them would put "not running" beside a browser that is.
    expect(await isRunning("Brave Browser", "darwin",
      { run: runner({ pgrep: { ok: true, stdout: "123\n" } }) })).toBe(true);
    expect(await isRunning("Brave Browser", "darwin",
      { run: runner({ pgrep: { ok: false, stdout: "", stderr: "" } }) })).toBe(false);
    expect(await isRunning("Brave Browser", "darwin",
      { run: runner({ pgrep: { ok: false, stdout: "", stderr: "pgrep: illegal option" } }) })).toBeNull();
    expect(await isRunning("Brave Browser", "darwin", { run: runner({ pgrep: null }) })).toBeNull();
  });
});

describe("the survey", () => {
  const fakeFs = (present: string[]) => ({
    existsSync: (p: string) => present.some(x => p.includes(x)),
    readdirSync: (p: string) => (present.some(x => p.includes(x)) ? ["Default"] : []),
    statSync: () => ({ isDirectory: () => true }),
  });

  it("lists a browser that is not installed, rather than leaving it out", async () => {
    // "Chrome is not installed" and "Chrome is installed and has never been
    // opened" are different answers, and a list of only what was found cannot
    // tell them apart — the same failure browser-profiles guards against a
    // level down.
    const fs = fakeFs(["Google/Chrome"]);
    const rows = await browserSurvey({
      relayHost: "bridge.example.com", platform: "darwin", env: {}, home: "/h",
      deps: { existsSync: fs.existsSync, fs, run: runner({ dig: { ok: true, stdout: "" }, pgrep: { ok: false, stdout: "", stderr: "" } }) },
    });
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]));
    expect(rows.length).toBeGreaterThan(4);
    expect(byKey.chrome.installed).toBe(true);
    expect(byKey.brave.installed).toBe(false);
    expect(byKey.brave.profiles).toBe(0);
  });

  it("never probes the relay for a browser that is not running", async () => {
    // The probe costs a subprocess each. A browser that is not running cannot
    // hold a connection, so asking is pure cost.
    let lsofCalls = 0;
    const fs = fakeFs(["Google/Chrome"]);
    await browserSurvey({
      relayHost: "bridge.example.com", platform: "darwin", env: {}, home: "/h",
      deps: {
        existsSync: fs.existsSync, fs,
        run: async (cmd: string) => {
          if (cmd === "lsof") lsofCalls += 1;
          if (cmd === "dig") return { ok: true, stdout: "1.2.3.4\n" };
          return { ok: false, stdout: "", stderr: "" };   // pgrep: nothing running
        },
      },
    });
    expect(lsofCalls).toBe(0);
  });
});
