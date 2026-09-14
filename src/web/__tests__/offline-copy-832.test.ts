// #832: the offline screen said "The browser cannot reach /events".
//
// `/events` is the stream's route. Somebody who typed `npx ccdeck` has never
// seen it, and the sentence did not say the one thing they could act on: whether
// the page had lost a deck that was there, or never found one. It says which of
// the two it is now, names the product rather than the route, and keeps the
// promise that the page picks up again by itself.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const code = app
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

/** The offline branch of the empty hero, from its heading to its paragraph. */
const offline = /\{offline \? \([\s\S]*?<\/>\s*\)/.exec(code)?.[0] ?? "";

describe("the offline screen speaks the reader's words (#832)", () => {
  it("no longer names the stream's route", () => {
    expect(offline).not.toBe("");
    expect(offline).not.toMatch(/\/events/);
  });

  it("says whether the page lost the deck or never found it", () => {
    expect(offline).toMatch(/everConnected \? "This page lost its connection to " : "This page cannot reach "/);
  });

  it("still says where to look and that the page recovers by itself", () => {
    expect(offline).toMatch(/still running in your terminal/);
    expect(offline).toMatch(/picks up again on its own/);
  });
});
