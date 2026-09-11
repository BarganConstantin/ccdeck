// The deck explains itself in pictures now, and this is the rule that keeps
// them pictures.
//
// The welcome was a changelog and Local network was a sentence in a panel and
// three dialogs of controls; both were reported the same way — "there is
// value here and it is not clear", and "a lot of text is tiring". A guide is
// one drawing at a time with one line under it, and the failure mode of a
// guide is that the line grows back into the paragraph it replaced. So the
// budget is counted, per step, against the steps that ship.
//
// No DOM, as everywhere else in this suite: the steps are data, the drawings
// are read as source, and the sheet is read as text.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LAN_STEPS, WELCOME_STEPS } from "../components/guide-art";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(`${WEB}${rel}`, "utf8");
const bare = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const css = read("styles.css");
const art = bare(read("components/guide-art.tsx"));
const modal = bare(read("components/GuideModal.tsx"));
const lan = bare(read("components/LanSyncSection.tsx"));
const app = bare(read("App.tsx"));

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

describe("a step is a picture with one line under it", () => {
  it("keeps every line under the budget, in both guides", () => {
    // Fourteen words is the longest a caption stays a caption. The step that
    // needs more gets a `tip`, which is one more line and never a paragraph.
    for (const [name, steps] of [["welcome", WELCOME_STEPS], ["lan", LAN_STEPS]] as const) {
      expect(steps.length, name).toBeGreaterThanOrEqual(3);
      for (const step of steps) {
        expect(words(step.line), `${name}: ${step.line}`).toBeLessThanOrEqual(14);
        expect(step.line, name).toMatch(/[.!]$/);
        if (step.tip) expect(words(step.tip), `${name} tip: ${step.tip}`).toBeLessThanOrEqual(16);
      }
    }
  });

  it("tells the story it was written for, in the order it happens", () => {
    // The Local network guide is the answer to "what do I do on the other
    // machine": the problem, both switches, the share list, the repair.
    expect(LAN_STEPS.map(s => s.line)).toEqual([
      expect.stringMatching(/expire/),
      expect.stringMatching(/both machines/),
      expect.stringMatching(/Tick/),
      expect.stringMatching(/copied/),
    ]);
    // And the welcome is the product: who is waiting, the tree, the cost,
    // how to get a first node on the canvas — then the accounts panel's three
    // verbs, and the network that keeps its logins working.
    expect(WELCOME_STEPS.map(s => s.line)).toEqual([
      expect.stringMatching(/waiting/),
      expect.stringMatching(/node/),
      expect.stringMatching(/cost/),
      expect.stringMatching(/claude/),
      expect.stringMatching(/switch.*add.*share/),
      expect.stringMatching(/local network/),
    ]);
  });

  it("draws every step on one board, so the dialog never changes height between steps", () => {
    const boards = [...art.matchAll(/viewBox="([^"]+)"/g)].map(m => m[1]);
    const stage = boards.filter(b => b === "0 0 440 200");
    // Ten steps, ten boards; the eleventh is the panel-sized intro.
    expect(stage).toHaveLength(1);
    expect(art).toMatch(/function Board\(/);
    expect((art.match(/<Board>/g) ?? []).length).toBe(WELCOME_STEPS.length + LAN_STEPS.length);
  });

  it("hides every drawing from the tree, because the line says the same thing", () => {
    for (const m of art.matchAll(/<svg[^>]*>/g)) {
      expect(m[0]).toContain("aria-hidden");
      expect(m[0]).toContain('focusable="false"');
    }
    expect(modal).toMatch(/<p className="guide-line" aria-live="polite">/);
  });

  it("colours nothing outside the sheet's tokens, so the drawings are right in both themes", () => {
    // Not one literal colour in the drawings or in their rules: a hex or an
    // rgb() here is a drawing that is right in one theme and a mystery in the
    // other. Everything reads a token, and a token is what the theme swaps.
    expect(art).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    const rules = css.slice(css.indexOf("/* ---------------- guides"));
    for (const m of rules.matchAll(/\.ga-[\w-]+[^{]*\{([^}]*)\}/g)) {
      expect(m[1], m[0]).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });

  it("stops its own arrows at the dialog, and takes no other key", () => {
    // Escape belongs to the dismiss queue and Tab to its trap; a guide that
    // read either would be the fourth spelling modal-dismiss.test.ts exists to
    // prevent. The arrows are the guide's own, and they stop here so nothing
    // behind the dialog pans the canvas on the same press.
    expect(modal).toMatch(/if \(e\.key !== "ArrowRight" && e\.key !== "ArrowLeft"\) return;/);
    expect(modal).toMatch(/e\.stopPropagation\(\);\s*go\(/);
    expect(modal).not.toMatch(/"Escape"|"Tab"|"Enter"/);
  });
});

describe("where the guides open from", () => {
  it("is a press in every case, and never a flag", () => {
    // The LAN section already keeps this rule for its setup dialog, and the
    // reason holds here twice over: a guide that opened on `enabled` would open
    // on every reload of a deck that is on.
    for (const [effect] of lan.matchAll(/useEffect\([\s\S]*?\n  \}, \[[^\]]*\]\);/g)) {
      expect(effect).not.toMatch(/setGuideOpen/);
    }
    // The card while it is off, and the word under an empty list.
    expect(lan).toMatch(/className="ap-lan-intro" onClick=\{\(\) => setGuideOpen\(true\)\}/);
    expect(lan).toMatch(/className="ap-lan-word ap-lan-how" onClick=\{\(\) => setGuideOpen\(true\)\}/);
    expect([...lan.matchAll(/setGuideOpen\(true\)/g)]).toHaveLength(2);
  });

  it("ends the LAN guide on the switch it was describing, through the same toggle", () => {
    // `Turn it on` goes through `toggle`, so the setup dialog still opens on
    // the press that puts this deck on the network — the guide is a longer
    // road to the same switch, not a way round what the switch does.
    expect(lan).toMatch(/finish=\{on \? undefined : \{ label: "Turn it on", act: \(\) => \{ setGuideOpen\(false\); void toggle\(\); \} \}\}/);
  });

  it("gives the empty canvas its way back, and only while the server is there", () => {
    expect(app).toMatch(/\{!offline && \(\s*<button type="button" className="btn empty-tour" onClick=\{onTour\}>Take the tour<\/button>/);
    // The hero is pointer-transparent so a drag starting on it pans; the one
    // control on it has to be given its pointer back or it is a drawing of a
    // button.
    expect(css).toMatch(/\.empty-hero \.empty-tour \{[^}]*pointer-events: auto/);
  });
});

describe("the README shows the same pictures", () => {
  // assets/guide-svg.mjs renders every step to a standalone .svg and the
  // README embeds them, so the front page shows exactly what a new install
  // shows. This is what keeps the two from drifting: a step whose line has
  // changed since the last render fails here until the script is run again.
  const readme = read("../../README.md");

  it("has one rendered picture per step, named by the step's own line", () => {
    for (const [name, steps] of [["welcome", WELCOME_STEPS], ["lan", LAN_STEPS]] as const) {
      steps.forEach((step, i) => {
        const svg = read(`../../assets/guide/${name}-${i + 1}.svg`);
        expect(svg, `${name}-${i + 1}`).toContain(`aria-label=${JSON.stringify(step.line)}`);
        // Themed by the sheet's own tokens, pinned inside the file, and not by
        // a colour somebody typed into the script.
        expect(svg).toContain("--accent:#7dd3fc");
        expect(svg).not.toContain("aria-hidden");
      });
    }
  });

  it("embeds all ten, each captioned with its line", () => {
    for (const [name, steps] of [["welcome", WELCOME_STEPS], ["lan", LAN_STEPS]] as const) {
      steps.forEach((step, i) => {
        expect(readme).toContain(`<img src="assets/guide/${name}-${i + 1}.svg" width="440" alt="${step.line}">`);
      });
    }
    expect(readme).toContain("## Local network");
    expect(readme).toContain("[Local network](#local-network)");
  });
});
