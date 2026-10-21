import { afterEach, expect, it, vi } from "vitest";

vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  networkInterfaces: vi.fn(),
}));

import { networkInterfaces } from "node:os";
// @ts-expect-error — plain .mjs server module, no types
import { createEngine } from "../../server/lan-engine.mjs";

const interfaces = vi.mocked(networkInterfaces);
const failure = Object.assign(new Error(
  "A system error occurred: uv_interface_addresses returned Unknown system error 2 (Unknown system error 2)",
), { code: "ERR_SYSTEM_ERROR" });

afterEach(() => interfaces.mockReset());

it("keeps a running LAN engine readable when Windows enumeration fails, and recovers on the next read", async () => {
  interfaces.mockReturnValue({});
  const engine = createEngine({
    host: "127.0.0.1",
    createSocket: () => ({
      on() {}, bind(_port: number, _host: string, done: () => void) { done(); },
      setBroadcast() {}, send(_msg: unknown, _port: number, _addr: string, done?: () => void) { done?.(); },
      close() {},
    }),
  });
  try {
    await engine.apply({ enabled: true, name: "Enumeration QA", autoAsk: false, autoAccept: false });
    expect(engine.status().running).toBe(true);
    interfaces.mockImplementation(() => { throw failure; });
    expect(engine.status()).toMatchObject({ enabled: true, running: true, addrs: [] });
    expect(engine.invite()).toBeNull();
    interfaces.mockReturnValue({ ethernet: [{
      address: "192.168.1.10", family: "IPv4", internal: false,
      netmask: "255.255.255.0", mac: "00:00:00:00:00:01", cidr: "192.168.1.10/24",
    }] });
    expect(engine.status().addrs).toEqual(["192.168.1.10"]);
    expect(engine.invite().addrs).toEqual([`192.168.1.10:${engine.status().port}`]);
  } finally {
    engine.stop();
  }
});
