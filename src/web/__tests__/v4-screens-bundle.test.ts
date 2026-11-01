// The built half of "off means absent": what index.html loads on every visit,
// its entry script, the scripts it preloads and its stylesheet, carries none of
// Chat or the Decision card, and the two screens do exist, as chunks of their
// own with their stylesheet beside them. v4-screens-gate.test.ts holds the
// source half (the import graph, the one dynamic import); this reads
// dist/web, the artifact that ships.
//
// Gated on a build being on disk, spelled exactly as notices-bundle.test.ts and
// its neighbours spell theirs, and registered in skip-gates.mjs with them: CI
// builds before the suite runs, so it never skips there.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dist = join(repo, "dist", "web", "index.html");
const assets = join(repo, "dist", "web", "assets");

/** Strings only the screens put in the output: a class, a sentence, a flag key. Each
 *  survives a minifier because it is a literal. */
const FINGERPRINTS = [
  "Since you looked", "Checking the prompt is still on screen", "Reading the conversation",
  "Sent only when you pick", "pick and send", "agent-dag.chat", "agent-dag.decision",
  ".dc-dock", ".dc-dq", ".chat-col", ".chat-body", "dc-tick", "chat-tool",
];

describe.skipIf(!existsSync(dist))("what the build emitted for the screens", () => {
  const html = existsSync(dist) ? readFileSync(dist, "utf8") : "";
  const firstLoad = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.(?:js|css))"/g)].map(m => m[1]);
  const text = (file: string) => readFileSync(join(repo, "dist", "web", file), "utf8");

  it("carries none of them in the entry script, its preloads or its stylesheet", () => {
    expect(firstLoad.filter(f => /^assets\/index-[^/]+\.js$/.test(f)), "index.html no longer loads an entry chunk").toHaveLength(1);
    expect(firstLoad.filter(f => f.endsWith(".css")).length, "index.html no longer links a stylesheet").toBeGreaterThan(0);
    for (const file of firstLoad) {
      const body = text(file);
      for (const needle of FINGERPRINTS) {
        expect(body.includes(needle), `dist/web/${file} is loaded on every visit and contains "${needle}": a screen has been imported statically`).toBe(false);
      }
    }
  });

  it("emits the screens, as scripts of their own", () => {
    const own = readdirSync(assets).filter(f => f.endsWith(".js") && !firstLoad.includes(`assets/${f}`));
    const holding = own.filter(f => readFileSync(join(assets, f), "utf8").includes("Checking the prompt is still on screen"));
    expect(holding.length, "no chunk holds the Decision card").toBeGreaterThan(0);
    const chat = own.filter(f => readFileSync(join(assets, f), "utf8").includes("Since you looked"));
    expect(chat.length, "no chunk holds Chat").toBeGreaterThan(0);
  });

  it("emits their stylesheets as async CSS, not in the one index.html links", () => {
    const linked = new Set(firstLoad);
    const sheets = readdirSync(assets).filter(f => f.endsWith(".css"));
    const withDecision = sheets.filter(f => readFileSync(join(assets, f), "utf8").includes(".dc-dock"));
    const withChat = sheets.filter(f => readFileSync(join(assets, f), "utf8").includes(".chat-col"));
    expect(withDecision.length, "no stylesheet holds the Decision card's rules").toBeGreaterThan(0);
    expect(withChat.length, "no stylesheet holds Chat's rules").toBeGreaterThan(0);
    for (const f of [...withDecision, ...withChat]) expect(linked.has(`assets/${f}`), `${f} is linked from index.html`).toBe(false);
  });
});
