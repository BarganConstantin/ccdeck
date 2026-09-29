// Every test that hands a child its input goes through endStdin, or handles the
// pipe's error itself (see child-stdin.ts for why an EPIPE there is not a
// failure, and why leaving it unhandled fails the whole run).
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { endStdin } from "./child-stdin";

const HERE = fileURLToPath(new URL(".", import.meta.url));

describe("a child that ends before reading its input", () => {
  it("does not throw at the writer", async () => {
    // Four megabytes to a child that exits without reading: far past any pipe
    // buffer, so the write is still going out when the child closes its end.
    // Handed over with a bare `child.stdin.end`, this raises EPIPE as an
    // uncaught exception every time.
    const escaped: Error[] = [];
    const catchAll = (e: Error) => { escaped.push(e); };
    process.on("uncaughtException", catchAll);
    try {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "ignore", "ignore"] });
      endStdin(child, "x".repeat(1 << 22));
      await new Promise(done => child.on("exit", done));
      await new Promise(done => setTimeout(done, 100));
      expect(child.exitCode).toBe(0);
    } finally { process.off("uncaughtException", catchAll); }
    expect(escaped).toEqual([]);
  });
});

describe("the suite's own writes to a child's stdin", () => {
  it("all allow an EPIPE", () => {
    const bare = readdirSync(HERE)
      .filter(f => /\.(test\.)?tsx?$/.test(f) && f !== "child-stdin.ts" && f !== "child-stdin.test.ts")
      .filter(f => {
        const text = readFileSync(HERE + f, "utf8");
        return /\.stdin!?\.(end|write)\(/.test(text) && !/stdin!?\??\.on\("error"/.test(text);
      });
    expect(bare).toEqual([]);
  });
});
