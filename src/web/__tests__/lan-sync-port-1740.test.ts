// #1740: a restart inside one process moved the sync port.
//
// The listener prefers the port it was handed, so an address typed on another
// deck keeps working after this one restarts. It was handed the port prefs
// held at boot, and only on the boot's first apply — every later apply passes
// no port, as applyLanPrefs does, and the engine never took in the port its
// own listener reported. So on a first run (nothing saved, port 0) a rename,
// LAN off and on, or a new key each bound a fresh random port, and every
// address saved on another deck stopped answering. And a deck whose saved port
// was busy at boot went back to that old port on its next restart, away from
// the one it had just announced.
//
// One engine on loopback; see lan-engine-rig.ts.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { rigDeck, stopAll } from "./lan-engine-rig";

afterEach(stopAll);

/** Something else on `port`, until `close` is called. */
async function squat(port: number) {
  const s = net.createServer();
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve());
  });
  return () => new Promise<void>(resolve => s.close(() => resolve()));
}

describe("the sync port across restarts in one process (#1740)", () => {
  it("stays where the listener first came up on a first run", async () => {
    const ports: number[] = [];
    const d = await rigDeck("Deck-A", { deps: { onPort: (p: number) => ports.push(p) } });
    const first = d.e.status().port as number;
    expect(first).toBeGreaterThan(0);

    // What applyLanPrefs hands the engine after boot: no port field at all.
    await d.e.apply({ name: "renamed" });
    expect(d.e.status().port, "a rename moved the port").toBe(first);
    await d.e.apply({ enabled: false });
    await d.e.apply({ enabled: true });
    expect(d.e.status().port, "LAN off and on moved the port").toBe(first);
    expect(ports, "a port that did not move was written again").toEqual([first]);
  }, 20_000);

  it("keeps the port it moved to when the saved one was busy at boot", async () => {
    const probe = await rigDeck("Probe");
    const saved = probe.e.status().port as number;
    probe.e.stop();
    const release = await squat(saved);
    let d;
    try {
      d = await rigDeck("Deck-A", { settings: { port: saved } });
    } finally {
      await release();
    }
    const moved = d.e.status().port as number;
    expect(moved).not.toBe(saved);

    // The saved port is free again, and the deck has told everybody `moved`.
    await d.e.apply({ name: "renamed" });
    expect(d.e.status().port, "a restart went back to the port it had given up").toBe(moved);
  }, 20_000);
});
