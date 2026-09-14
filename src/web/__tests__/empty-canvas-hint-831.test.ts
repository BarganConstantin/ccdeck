// #831: the empty canvas told a connected reader "Not seeing anything? Make
// sure ccdeck is running."
//
// That copy is agentNoneCopy, which the hero renders only while the stream is
// live — offline has its own heading and sentence. So the hint asked the reader
// to check the one thing the page had just proved, and sent them to the
// terminal for nothing. The capture hints under it — one per CLI, each naming
// what that path depends on — are the real reasons a canvas stays empty, and
// they stay.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const code = app
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** The live empty-canvas copy, from its signature to the next function. */
const copy = /function agentNoneCopy[\s\S]*?\nfunction /.exec(code)?.[0] ?? "";

describe("the empty canvas does not ask a connected reader to check the connection (#831)", () => {
  it("has no running-check hint", () => {
    expect(copy).not.toBe("");
    expect(copy).not.toMatch(/Not seeing anything/);
    expect(copy).not.toMatch(/is running\./);
  });

  it("still lists the capture hints, which are the real reasons a canvas stays empty", () => {
    expect(copy).toMatch(/captureHints\(providers\)\.map/);
  });

  it("is only ever the live branch", () => {
    expect(code).toMatch(/\{offline \? \([\s\S]*?\) : agentNoneCopy\(providers, workspace\)\}/);
  });
});
