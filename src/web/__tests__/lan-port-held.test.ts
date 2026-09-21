// The discovery port, and who else may hold it.
//
// Measured on a Mac that is a Tailscale exit node: a deck elsewhere on the
// tailnet sent its beacons from UDP 45317 through it, Tailscale's forwarder
// bound its end of that flow to the same port (it reuses the client's source
// port, netstack.go forwardUDP), and the Mac's own deck could never bind 45317
// again. Two halves are pinned here: a deck no longer sends from the port it
// listens on, and a deck that cannot bind it keeps running — found, dialled,
// syncing — while it names who holds the port and waits to take it back.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { createBeacon, DISCOVERY_PORT } from "../../server/lan-socket.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { fingerprint, identityFrom } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createEngine } from "../../server/lan-engine.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { friendlyHolder, holderFromNetstat, holderFromPowershell, holderFromSs, portHolder } from "../../server/port-holder.mjs";

/** A socket that remembers the port it was bound to and what it sent. */
function socket(opts: { failBind?: boolean; code?: string } = {}) {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  const s = {
    port: -1,
    sent: [] as string[],
    closed: false,
    on(ev: string, fn: (...a: unknown[]) => void) { handlers.set(ev, fn); },
    bind(port: number, _h: string, cb: () => void) {
      if (opts.failBind) { const code = opts.code ?? "EACCES"; setTimeout(() => handlers.get("error")?.(Object.assign(new Error(`bind ${code}`), { code })), 0); return; }
      s.port = port;
      cb();
    },
    setBroadcast() { /* nothing */ },
    send(_m: unknown, _p: number, addr: string, cb?: (e: Error | null) => void) { s.sent.push(addr); cb?.(null); },
    close() { s.closed = true; },
  };
  return s;
}

describe("where a beacon leaves from", () => {
  it("leaves from a port of its own, never from the one it listens on", async () => {
    const made: ReturnType<typeof socket>[] = [];
    const b = createBeacon({
      port: 51_234, name: "Mac", fp: fingerprint(randomBytes(32)), ifaces: () => ({}),
      createSocket: () => { const s = socket(); made.push(s); return s; },
    });
    await b.start();
    const listen = made.find(s => s.port === DISCOVERY_PORT)!;
    const out = made.find(s => s.port === 0)!;
    expect(listen.sent).toEqual([]);
    expect(out.sent).toEqual(["255.255.255.255"]);
    expect(b.hearing()).toBe(true);
    b.stop();
    expect(listen.closed && out.closed).toBe(true);
  });

  it("still shouts from the listening socket when a second one cannot open", async () => {
    // A beacon from the wrong port is still a beacon; none at all is a deck
    // nobody finds.
    const made: ReturnType<typeof socket>[] = [];
    const b = createBeacon({
      port: 51_234, name: "Mac", fp: fingerprint(randomBytes(32)), ifaces: () => ({}),
      createSocket: () => { const s = socket({ failBind: made.length > 0 }); made.push(s); return s; },
    });
    await b.start();
    expect(made[0].port).toBe(DISCOVERY_PORT);
    expect(made[0].sent).toEqual(["255.255.255.255"]);
    b.stop();
  });

  it("keeps announcing when it cannot listen, and listens once the port is free", async () => {
    // The Mac this was found on: Tailscale held 45317. The deck is still found
    // by everybody — it only cannot hear them — so it keeps shouting, and
    // tries the port again on its own.
    let taken = true;
    const told: boolean[] = [];
    const made: ReturnType<typeof socket>[] = [];
    const b = createBeacon({
      port: 51_234, name: "Mac", fp: fingerprint(randomBytes(32)), ifaces: () => ({}),
      rebindMs: 30, onHearing: (h: boolean) => told.push(h),
      createSocket: (o: { reuseAddr?: boolean }) => {
        const s = socket({ failBind: !!o?.reuseAddr && taken, code: "EADDRINUSE" });
        made.push(s);
        return s;
      },
    });
    await b.start();
    expect(b.hearing()).toBe(false);
    expect(b.deafError()?.code).toBe("EADDRINUSE");
    const out = made.find(s => s.port === 0)!;
    expect(out.sent).toEqual(["255.255.255.255"]);
    taken = false;
    const deadline = Date.now() + 2_000;
    while (!b.hearing() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    expect(b.hearing()).toBe(true);
    // Once per change, not once per try.
    expect(told).toEqual([false, true]);
    b.stop();
  });
});

describe("who holds the port", () => {
  it("reads the owner off macOS netstat, which names it for any user", () => {
    // The line measured on the Mac this was found on, trimmed of its counters.
    const text = [
      "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)   rxbytes  txbytes  process:pid",
      "udp46      0      0  *.45317                *.*                              2377196    83570  io.tailscale.ipn:592    00180",
      "udp4       0      0  *.41641                *.*                              1502764  2099830  io.tailscale.ipn:592    00180",
    ].join("\n");
    expect(holderFromNetstat(text, 45317)).toBe("io.tailscale.ipn");
    expect(holderFromNetstat(text, 4317)).toBeNull();
  });

  it("reads the owner off Linux ss and Windows PowerShell", () => {
    expect(holderFromSs('UNCONN 0 0 0.0.0.0:45317 0.0.0.0:* users:(("tailscaled",pid=812,fd=17))')).toBe("tailscaled");
    expect(holderFromSs("UNCONN 0 0 0.0.0.0:45317 0.0.0.0:*")).toBeNull();
    expect(holderFromPowershell("tailscaled\r\n")).toBe("tailscaled");
    expect(holderFromPowershell("")).toBeNull();
  });

  it("calls Tailscale Tailscale, whatever its process is named", () => {
    expect(friendlyHolder("io.tailscale.ipn")).toBe("Tailscale");
    expect(friendlyHolder("tailscaled")).toBe("Tailscale");
    expect(friendlyHolder("syncthing")).toBe("syncthing");
    expect(friendlyHolder(null)).toBeNull();
  });

  it("asks each platform its own command, and says nothing when the machine will not", async () => {
    const asked: string[] = [];
    const run = async (cmd: string) => { asked.push(cmd); return { ok: false, stdout: "" }; };
    for (const platform of ["darwin", "linux", "win32"]) expect(await portHolder(45317, { platform, run })).toBeNull();
    expect(asked).toEqual(["netstat", "ss", "powershell.exe"]);
  });
});

const running: Array<{ stop: () => void }> = [];
afterEach(() => { for (const e of running.splice(0)) e.stop(); });

describe("a deck whose discovery port is taken", () => {
  it("keeps running and names who took the port, asking only once", async () => {
    let asked = 0;
    const e = createEngine({
      readAccounts: async () => ({ accounts: [] }), exportAccount: async () => null, importAccount: async () => true,
      host: "127.0.0.1", bindRetryMs: 40,
      createSocket: (o: { reuseAddr?: boolean }) => socket({ failBind: !!o?.reuseAddr, code: "EADDRINUSE" }),
      portHolder: async () => { asked++; return "Tailscale"; },
    });
    running.push(e);
    await e.apply({ enabled: true, name: "Mac", secret: identityFrom("").secret });
    // Running: the listener is up and the deck can be dialled.
    expect(e.status()).toMatchObject({ enabled: true, running: true, stalled: null });
    expect(e.status().port).toBeGreaterThan(0);
    const deadline = Date.now() + 2_000;
    while (!/^Tailscale/.test(e.status().deaf ?? "") && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    expect(e.status().deaf).toMatch(/^Tailscale is holding UDP 45317, so this deck hears no new decks\./);
    // More tries go by, and the answer is the one already had.
    await new Promise(r => setTimeout(r, 150));
    expect(asked).toBe(1);
  });

  it("does not tell the panel there is no other deck while it cannot look", () => {
    const SECTION = readFileSync(fileURLToPath(new URL("../components/LanSyncSection.tsx", import.meta.url)), "utf8");
    expect(SECTION).toMatch(/rest\.length === 0 && asks\.length === 0 && !status\?\.stalled && !status\?\.deaf && \(/);
  });
});
