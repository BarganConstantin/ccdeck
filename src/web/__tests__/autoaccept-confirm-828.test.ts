// #828: "Say yes to every deck that asks" paired any deck on the network from
// one unguarded press, on a switch drawn exactly like the harmless "Ask every
// deck this one finds" beside it. One mis-toggle offered the logins this deck
// shares to any machine that asked. Turning it on now costs two presses, the
// way unpair does; it wears --warn, armed and on; and the line under the
// switches says what it gives away in those words. Turning it off is one press.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const MODAL = read("../components/LanSetupModal.tsx");
const css = read("../styles.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** The <button …> whose accessible name is `label`, attributes and handlers. */
const button = (label: string): string => {
  const at = MODAL.indexOf(`aria-label="${label}"`);
  expect(at, label).toBeGreaterThan(-1);
  const open = MODAL.lastIndexOf("<button", at);
  return MODAL.slice(open, MODAL.indexOf("<span className=\"switch-knob\"", at));
};
const yes = button("Say yes to every deck that asks");
const ask = button("Ask every deck this one finds");

describe("saying yes for everybody takes two presses (#828)", () => {
  it("arms on the first press instead of writing, and only when turning it on", () => {
    expect(yes).toMatch(/if \(!says && !armedAccept\) \{ setArmedAccept\(true\); armedAt\.current = Date\.now\(\); return; \}/);
    // The write that follows is the same one, so turning it off stays one press.
    expect(yes).toMatch(/setArmedAccept\(false\);\s*void write\(\s*\{ autoAccept: !says \}/);
  });

  it("does not take a double-click or a held key as the second press", () => {
    expect(yes).toMatch(/armedAccept && Date\.now\(\) - armedAt\.current < CONFIRM_GAP_MS\) return;/);
    expect(MODAL).toMatch(/import \{ CONFIRM_GAP_MS, [^}]*\} from "\.\/LanSyncSection";/);
    expect(yes).toMatch(/onKeyDown=\{e => \{ if \(e\.repeat\) e\.preventDefault\(\); \}\}/);
  });

  it("stands down on its own, the way an armed unpair does", () => {
    expect(MODAL).toMatch(/window\.setTimeout\(\(\) => setArmedAccept\(false\), 4_000\)/);
  });

  it("marks only this switch as the one that gives something away", () => {
    expect(yes).toMatch(/data-tone="warn"/);
    expect(yes).toMatch(/data-armed=\{armedAccept \|\| undefined\}/);
    expect(ask).not.toMatch(/data-tone|data-armed/);
  });
});

describe("it looks and reads like what it does (#828)", () => {
  it("fills with --warn when on, and edges its track and knob with it while armed", () => {
    expect(css).toMatch(/\.switch\[data-tone="warn"\]\[aria-checked="true"\] \{ border-color: var\(--warn\); background: var\(--warn\); \}/);
    expect(css).toMatch(/\.switch\[data-armed="true"\],\s*\.switch\[data-armed="true"\]:hover:not\(:disabled\) \{ border-color: var\(--warn\); \}/);
    expect(css).toMatch(/\.switch\[data-armed="true"\] \.switch-knob,\s*\.switch\[data-armed="true"\]:hover:not\(:disabled\) \.switch-knob \{ background: var\(--warn\); \}/);
    // After the shared hover rule, so a pointer resting on it keeps the warning.
    expect(css.indexOf('.switch[data-tone="warn"]')).toBeGreaterThan(css.indexOf(".switch:hover:not(:disabled) {"));
  });

  it("says what it gives away, armed and on, in the line under the switches", () => {
    const line = /<p className=\{armedAccept \|\| says \? "lan-warn" : "lan-note"\} aria-live="polite">([\s\S]*?)<\/p>/.exec(MODAL)?.[1] ?? "";
    const [armed, on] = [...line.matchAll(/<>([\s\S]*?)<\/>/g)].map(m => m[1].replace(/\s+/g, " ").trim());
    expect(armed).toMatch(/^Press the switch again to turn it on\./);
    for (const said of [armed, on]) {
      expect(said).toMatch(/Any deck on this network that asks/);
      expect(said).toMatch(/offered any login ticked above, without you being asked\./);
    }
  });
});
