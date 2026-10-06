// The machine panel's rules for a reading, asked what they say.
//
// thermalTone and throttleRow have been driven by thermal.test.ts since they
// were written. The rest lived inside MachinePanel.tsx, where nothing could
// call them: the one condition the panel flags at the top, how it writes
// bytes and an uptime, and the words for the path traffic takes. They are in
// machine-readings.ts now, bytes aside — since #1128 those are the deck's one
// formatter in byte-format.ts — and these call them.
import { describe, it, expect } from "vitest";

import { attentionFlag, pathText, uptime } from "../machine-readings";
import { fmtBytes } from "../byte-format";
import { sourceOf } from "./client-source";

const calm = {
  thermal: { celsius: [], throttle: { speedLimit: 100 } },
  memory: { total: 32, available: 16, usedPct: 50 },
  network: { down: 1, up: 1, api: { host: "api.anthropic.com", ms: 20 }, route: null },
};

describe("the one condition worth saying at the top", () => {
  it("says nothing about a machine with nothing wrong, rather than a word that means fine", () => {
    expect(attentionFlag(calm)).toBeNull();
    expect(attentionFlag({ thermal: null, memory: null, network: null })).toBeNull();
  });

  it("says each of the three measured conditions", () => {
    expect(attentionFlag({ ...calm, thermal: { celsius: [], throttle: { speedLimit: 62 } } }))
      .toBe("throttled to 62% of full speed");
    // Linux counts time held down, not speed allowed, and says so.
    expect(attentionFlag({ ...calm, thermal: { celsius: [], throttle: { timeHeld: 57 } } }))
      .toBe("throttled 57% of the time");
    expect(attentionFlag({ ...calm, thermal: { celsius: [], throttle: { timeHeld: 0 } } })).toBeNull();
    expect(attentionFlag({ ...calm, memory: { total: 32, available: 2, usedPct: 93.6 } }))
      .toBe("physical memory 94% full");
    expect(attentionFlag({ ...calm, network: { ...calm.network, api: { host: "api.anthropic.com", ms: null } } }))
      .toBe("the Claude API is not answering");
  });

  it("flags memory from the same 90% its own row turns amber at", () => {
    expect(attentionFlag({ ...calm, memory: { total: 32, available: 3.3, usedPct: 89.9 } })).toBeNull();
    expect(attentionFlag({ ...calm, memory: { total: 32, available: 3.2, usedPct: 90 } })).toBe("physical memory 90% full");
  });

  it("says one at a time, worst first", () => {
    const all = {
      thermal: { celsius: [], throttle: { speedLimit: 70 } },
      memory: { total: 32, available: 1, usedPct: 97 },
      network: { ...calm.network, api: { host: "api.anthropic.com", ms: null } },
    };
    expect(attentionFlag(all)).toBe("throttled to 70% of full speed");
    expect(attentionFlag({ ...all, thermal: null })).toBe("physical memory 97% full");
    expect(attentionFlag({ ...all, thermal: null, memory: calm.memory })).toBe("the Claude API is not answering");
  });

  it("does not take an API nobody has asked yet for one that did not answer", () => {
    expect(attentionFlag({ ...calm, network: { ...calm.network, api: null } })).toBeNull();
  });
});

describe("bytes and an uptime, in the panel's units", () => {
  it("writes memory in the deck's one byte format, one decimal at every unit (#1128)", () => {
    // Gigabytes kept their one place; megabytes and kilobytes were whole, and
    // an idle swap was "0 KB", until the panel's own `bytes` went.
    expect(fmtBytes(20.5 * 1024 ** 3)).toBe("20.5 GB");
    expect(fmtBytes(1024 ** 3)).toBe("1.0 GB");
    expect(fmtBytes(512.4 * 1024 ** 2)).toBe("512.4 MB");
    expect(fmtBytes(900 * 1024)).toBe("900.0 KB");
    expect(fmtBytes(0)).toBe("0 B");
    const panel = sourceOf("components/MachinePanel.tsx");
    expect(panel).toMatch(/import \{ fmtBytes \} from "\.\.\/byte-format";/);
    for (const figure of ["used", "memory.total", "memory.available", "swap.used", "swap.total"]) {
      expect(panel, figure).toContain(`fmtBytes(${figure})`);
    }
  });

  it("writes an uptime at the two largest units it has", () => {
    expect(uptime(3 * 86_400 + 5 * 3_600 + 59 * 60)).toBe("3d 5h");
    expect(uptime(5 * 3_600 + 7 * 60)).toBe("5h 7m");
    expect(uptime(7 * 60 + 30)).toBe("7m");
    expect(uptime(0)).toBe("0m");
  });
});

describe("the path traffic takes, in the words the server's route label uses", () => {
  it("names an exit node when it knows one, and says a Tailscale exit node when it does not", () => {
    expect(pathText({ kind: "tailscale-exit", node: "office-mac", to: "claude" })).toBe("Tailscale exit node office-mac");
    expect(pathText({ kind: "tailscale-exit", node: null, to: "claude" })).toBe("a Tailscale exit node");
  });

  it("says Tailscale, or a VPN by whatever name and interface the machine gives it", () => {
    expect(pathText({ kind: "tailscale", to: "internet" })).toBe("Tailscale");
    expect(pathText({ kind: "vpn", name: "WireGuard", iface: "wg0", to: "internet" })).toBe("WireGuard VPN (wg0)");
    expect(pathText({ kind: "vpn", to: "internet" })).toBe("VPN");
  });
});
