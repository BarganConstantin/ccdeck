// The desktop host hands the log descriptor to the spawned deck. Its own copy
// must be closed after the handoff, including when spawn itself throws (#1183).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDeck } from "../../../desktop/deck-host.mjs";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

let deckRoot: string;
const logFile = () => join(deckRoot, "deck.log");
const launch = () => startDeck({
  deckRoot,
  appBinary: process.execPath,
  logFile: logFile(),
  path: process.env.PATH ?? "",
  launcher: join(deckRoot, "ccdeck-node"),
});

beforeEach(() => {
  deckRoot = mkdtempSync(join(tmpdir(), "ccdeck-descriptor-"));
  vi.mocked(spawn).mockReset();
});

afterEach(() => rmSync(deckRoot, { recursive: true, force: true }));

describe("the desktop deck's log descriptor", () => {
  it("is usable during spawn, then closed in the app after the handoff", () => {
    let handed = -1;
    const child = { pid: 1234 } as ReturnType<typeof spawn>;
    vi.mocked(spawn).mockImplementation((_binary, _args, options) => {
      const stdio = (options as { stdio: (string | number)[] }).stdio;
      expect(stdio[1]).toBe(stdio[2]);
      handed = stdio[1] as number;
      writeSync(handed, "deck output\n");
      return child;
    });

    expect(launch()).toBe(child);
    expect(readFileSync(logFile(), "utf8")).toBe("deck output\n");
    expect(() => writeSync(handed, "leaked descriptor")).toThrow();
  });

  it("closes the log descriptor if spawn throws", () => {
    let handed = -1;
    vi.mocked(spawn).mockImplementation((_binary, _args, options) => {
      handed = (options as { stdio: (string | number)[] }).stdio[1] as number;
      throw new Error("spawn failed");
    });

    expect(launch).toThrow("spawn failed");
    expect(handed).toBeGreaterThanOrEqual(0);
    expect(() => writeSync(handed, "leaked descriptor")).toThrow();
  });
});
