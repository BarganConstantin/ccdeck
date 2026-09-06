// Four exports nothing but the suite reached, an orphan CSS selector, a
// constant declared twice and a comment that stated a contract nobody had.
//
// #798. The interesting half is the four exports. A test importing a symbol is
// not a consumer — it is the opposite: the suite then pins a code path the
// server never executes, and the pinned behaviour and the shipped behaviour can
// drift apart with nothing going red. `export-surface-383.test.ts` was written
// for this class and these got past it, because each one had a plausible
// reason to exist and a green test standing over it.
//
// Each case here asserts BOTH halves, the way #383's file does: the export is
// gone, and the thing it stood in front of still works. Dropping a declaration
// and dropping an export keyword look identical in a diff read too quickly.
//
// `stopSystemMetrics` is the one the audit named that STAYS, and the reason is
// recorded below rather than left for the next audit to find again.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { guessLine } from "../notify";
import type { WaitingBlock } from "../types";

const SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
const WEB = fileURLToPath(new URL("../", import.meta.url));
const src = (root: string, file: string) => readFileSync(join(root, file), "utf8");

// @ts-expect-error — plain .mjs server module, no types
const openUrlMod = await import("../../server/open-url.mjs");
// @ts-expect-error — ditto
const indexMod = await import("../../server/index.mjs");
// @ts-expect-error — ditto
const profilesMod = await import("../../server/browser-profiles.mjs");
// @ts-expect-error — ditto
const relayMod = await import("../../server/relay-guard.mjs");
// @ts-expect-error — ditto
const metricsMod = await import("../../server/system-metrics.mjs");

describe("blockedToolLabel — the wording function with two callers and neither of them real", () => {
  it("is gone from AgentNode", () => {
    const text = src(WEB, "components/AgentNode.tsx");
    expect(text).not.toContain("export function blockedToolLabel");
    expect(text, "the declaration survived the un-export").not.toContain("function blockedToolLabel");
  });

  it("left the two surfaces on the one function that always served them", () => {
    // notify.ts's own header: "ONE FUNCTION BECAUSE THERE ARE TWO SURFACES."
    // The tooltip goes through `guessLine`, and so does the notification body.
    expect(src(WEB, "components/AgentNode.tsx")).toContain("const label = guessLine(waiting, said);");
    expect(src(WEB, "notify.ts")).toContain("const tool = guessLine(block, said);");
  });

  it("and the wording it produced is still produced, by the function that ships", () => {
    // The half that would hurt if this had been a careless deletion. `guessLine`
    // de-duplicates against the sentence it sits under, so a sentence that does
    // not name the tool asks it for exactly the long form that was removed.
    const block = (tool?: { name: string; preview: string }): WaitingBlock =>
      ({ kind: "permission", message: "x", since: 0, ...(tool ? { tool } : {}) } as WaitingBlock);
    expect(guessLine(block({ name: "Bash", preview: "rm -rf node_modules" }), "Claude needs your permission"))
      .toBe("Bash · rm -rf node_modules");
    expect(guessLine(block({ name: "Bash", preview: "" }), "Claude needs your permission")).toBe("Bash");
    expect(guessLine(block(), "Claude needs your permission")).toBeNull();
  });
});

describe("isOpenable — a boolean in front of the guard that does the work", () => {
  it("is gone, and normalizeOpenable is what remains", () => {
    expect(Object.keys(openUrlMod)).not.toContain("isOpenable");
    expect(src(SERVER, "open-url.mjs")).not.toContain("function isOpenable");
    expect(Object.keys(openUrlMod)).toContain("normalizeOpenable");
  });

  it("refuses everything it refused, through the function openUrl actually calls", () => {
    for (const bad of ["file:///etc/passwd", "/tmp/x.sh", "C:\\x.bat", "javascript:alert(1)", "", null, undefined]) {
      expect(openUrlMod.normalizeOpenable(bad), String(bad)).toBeNull();
    }
    expect(openUrlMod.normalizeOpenable("http://127.0.0.1:4317")).toBe("http://127.0.0.1:4317/");
    // And `openUrl` is still built on it, so the check is on the live path.
    expect(src(SERVER, "open-url.mjs")).toContain("const href = normalizeOpenable(url);");
  });
});

describe("readSessionNaming — a whole-text loop the scan never runs", () => {
  it("is gone, and the fold production uses is exported in its place", () => {
    expect(Object.keys(indexMod)).not.toContain("readSessionNaming");
    expect(Object.keys(indexMod)).toContain("foldSessionNamingLine");
  });

  it("folds the same two records, one line at a time, as foldTranscriptLine does", () => {
    // The behaviour, asserted against the function the server calls — which is
    // the entire point of the swap.
    const out = { aiTitle: null as string | null, agentName: null as string | null };
    for (const line of [
      JSON.stringify({ type: "ai-title", aiTitle: "First title", sessionId: "s1" }),
      JSON.stringify({ type: "agent-name", agentName: "a-name", sessionId: "s1" }),
      JSON.stringify({ type: "ai-title", aiTitle: "Newer title", sessionId: "s1" }),
    ]) indexMod.foldSessionNamingLine(out, line);
    expect(out).toEqual({ aiTitle: "Newer title", agentName: "a-name" });
    // The scan really does fold through it, rather than through some other copy.
    expect(src(SERVER, "index.mjs")).toContain("foldSessionNamingLine(state, line);");
  });
});

describe("stopSystemMetrics — the one the audit named that stays", () => {
  it("is still exported, because it is a RESET and the suite has nothing else", () => {
    // Production starts the loop once and never stops it; the process ending is
    // what stops it. But this clears `history`, `thermal`, the CPU baselines and
    // the miss counters, which is what a case needs between two runs of
    // `startSystemMetrics` in one process. Deleting it would leave the suite
    // leaking intervals into the values the next case reads — and unlike the
    // three above, there is no shipped counterpart for it to drift away from.
    expect(Object.keys(metricsMod)).toContain("stopSystemMetrics");
    const text = src(SERVER, "system-metrics.mjs");
    expect(text).toContain("history.length = 0;");
    expect(text, "the reason it stays is not written down").toContain("THE SUITE'S, AND SAID PLAINLY (#798)");
  });
});

describe("the extension id", () => {
  it("is declared once and read from there", () => {
    // Two copies of one literal in modules that never imported each other: a
    // republished extension would leave whichever was not updated answering
    // "not installed" forever, with nothing going red.
    const relay = src(SERVER, "relay-guard.mjs");
    const profiles = src(SERVER, "browser-profiles.mjs");
    expect((relay.match(/"fcoeoabgfenejglbffodgkkbkcdhcgfn"/g) ?? []).length).toBe(1);
    expect(profiles, "the literal is written out here again")
      .not.toContain('"fcoeoabgfenejglbffodgkkbkcdhcgfn"');
    expect(profiles).toContain('import { CLAUDE_EXT_ID } from "./relay-guard.mjs";');
    // Both modules still answer with it, so the re-export is real.
    expect(profilesMod.CLAUDE_EXT_ID).toBe(relayMod.CLAUDE_EXT_ID);
    expect(relayMod.CLAUDE_EXT_ID).toBe("fcoeoabgfenejglbffodgkkbkcdhcgfn");
  });

  it("travels in the direction that keeps relay-guard unable to run or write", () => {
    // relay-guard imports node:path and nothing else — its header says so and
    // relay-guard.test.ts pins it by reading the source. Importing
    // browser-profiles (node:fs) into it would have broken that, so the
    // dependency goes the other way.
    expect(src(SERVER, "relay-guard.mjs")).not.toContain("browser-profiles");
  });
});

describe("the comment at readSessionNamingFromTranscript", () => {
  it("no longer claims an export the function does not have", () => {
    const text = src(SERVER, "index.mjs");
    expect(text).toContain("async function readSessionNamingFromTranscript(path) {");
    expect(text).not.toContain("export async function readSessionNamingFromTranscript");
    expect(text, "the comment states a test contract that does not exist")
      .not.toContain("Exported beside readContextFromTranscript");
  });
});

describe("the README's share prefix (#805)", () => {
  it("names the one the deck actually writes", () => {
    // `ccdeck1:` is read-only legacy and is never produced. A user holding a
    // `ccdeck2:` string against a README promising `ccdeck1:` suspects the
    // share before the docs.
    const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
    const admin = src(SERVER, "cswap-admin.mjs");
    expect(admin).toContain('const SHARE_PREFIX = "ccdeck2:";');
    expect(readme).toContain("`ccdeck2:…` blob");
    expect(readme, "the README still advertises the legacy prefix").not.toContain("`ccdeck1:…`");
  });
});
