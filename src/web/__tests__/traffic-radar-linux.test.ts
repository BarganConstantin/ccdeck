import { describe, expect, it, vi } from "vitest";
import { parseRadarSockets } from "../../server/traffic-radar.mjs";
import { linuxSockets, readProc } from "../../server/traffic-radar-platform.mjs";

const failure = (code: string) => Object.assign(new Error(code), { code });
const tcpRow = (remote: string, inode: string, state = "01") => `0: 0100007F:1234 ${remote} ${state} 0:0 0:0 0 1000 0 ${inode}`;

describe("Linux socket tables", () => {
  // A /proc file reports size 0 and answers one page per read. Node 18's
  // fs.promises.readFile stopped after that first page, so a busy machine's
  // socket table lost every row past about the 27th. This handle answers the
  // way procfs does.
  const procFile = (data: Buffer, page = 4050) => {
    let at = 0;
    const close = vi.fn(async () => {});
    const open = vi.fn(async () => ({
      read: async (buffer: Buffer, offset: number, length: number) => {
        const bytesRead = data.copy(buffer, offset, at, Math.min(at + page, at + length, data.length));
        at += bytesRead;
        return { bytesRead, buffer };
      },
      close,
    }));
    return { open, close };
  };

  it("reads a /proc file to its end one page at a time, within a bound", async () => {
    const table = Buffer.from(["header", ...Array.from({ length: 1200 }, (_, i) => tcpRow("100200C0:10DD", String(1000 + i)))].join("\n"));
    const whole = procFile(table);
    expect((await readProc("/proc/42/net/tcp", 67_108_864, whole.open))?.equals(table)).toBe(true);
    expect(whole.open).toHaveBeenCalledWith("/proc/42/net/tcp", "r");
    expect(whole.close).toHaveBeenCalledTimes(1);
    const over = procFile(table);
    expect(await readProc("/proc/42/net/tcp", table.length - 1, over.open)).toBeNull();
    expect(over.close).toHaveBeenCalledTimes(1);
  });

  it("parses a network namespace's table once per sample and retries a failed shared read", async () => {
    const links = (path: string) => path.endsWith("ns/net") ? "net:[4026531840]" : path.endsWith("cwd") ? "/home/test/project" : path.includes("/41/") ? "socket:[100]" : "socket:[200]";
    const read = vi.fn(async (path: string) => "header\n" + (path.endsWith("tcp6") ? "" : [tcpRow("100200C0:10DD", "100"), tcpRow("110200C0:10DD", "200")].join("\n")));
    const result = await linuxSockets([41, 42, 43], { list: async () => ["3"], link: async (path: string) => links(path), read });
    expect(read).toHaveBeenCalledTimes(2);
    expect(parseRadarSockets(result.sockets, [41, 42, 43]).sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 41, destination: "192.0.2.16:4317" }, { pid: 42, destination: "192.0.2.17:4317" }, { pid: 43, destination: "192.0.2.17:4317" },
    ]);
    const flaky = vi.fn(async (path: string) => { if (path === "/proc/41/net/tcp") throw failure("ENOENT"); return read(path); });
    const retried = await linuxSockets([41, 42], { list: async () => ["3"], link: async (path: string) => links(path), read: flaky });
    expect(retried.sockets).toContain("192.0.2.17:4317");
  });
});
