// #818: the tour sent a newcomer to "the bell in the topbar", and there is no
// bell. The control that set the tone and the notification was "Sound
// settings", drawn as a speaker, so the tip was rewritten to name the speaker
// by what it looks like.
//
// The speaker left the topbar (2026-10-07): the tones and the notification are
// set in Settings, behind the gear. The guarantee is the same one — the tip
// names a control by the shape the page actually draws — and it now points at
// the gear, which is always on the bar.
//
// The panel toggles left the topbar for the window's edges (2026-10-08); the
// gear did not. It is one of the two utilities the topbar keeps, defined in
// rail-items.tsx, drawn from components/rail-glyphs.tsx, and put on the bar by
// UtilityRun (components/EdgeRails.tsx) inside App.tsx's <header>.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LAN_STEPS, WELCOME_STEPS } from "../components/guide-art";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
/** The chrome's controls: what they are, what they look like, and the run that
 *  draws the topbar's two. */
const run = ["../rail-items.tsx", "../components/rail-glyphs.tsx", "../components/EdgeRails.tsx"]
  .map(rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")).join("\n");
/** The topbar's own markup in App.tsx. */
const bar = /<header className="topbar"[\s\S]*?<\/header>/.exec(app)?.[0] ?? "";
const copy = [...WELCOME_STEPS, ...LAN_STEPS].flatMap(s => [s.line, s.tip ?? ""]).join("\n");

/** The gear's outline, as the topbar draws it. */
const GEAR_PATH = 'd="M5.4 2.9L5.6 1.1L8.4 1.1L8.6 2.9L9.8 3.6L11.5 2.8L12.8 5.2L11.3 6.3L11.3 7.7L12.8 8.8L11.5 11.2L9.8 10.4L8.6 11.1L8.4 12.9L5.6 12.9L5.4 11.1L4.2 10.4L2.5 11.2L1.2 8.8L2.7 7.7L2.7 6.3L1.2 5.2L2.5 2.8L4.2 3.6Z"';

describe("the tour names the sound control by what it looks like (#818)", () => {
  it("never mentions a bell", () => {
    expect(copy).not.toMatch(/\bbell\b/i);
  });

  it("no longer sends anyone to a speaker the topbar does not draw", () => {
    expect(copy).not.toMatch(/speaker/i);
    expect(run).not.toMatch(/Sound settings/);
    expect(run).not.toContain('d="M3.2 5.2h2L7.8 3v8L5.2 8.8h-2z"');
  });

  it("points at the gear, which is what the topbar draws", () => {
    const tip = WELCOME_STEPS[0].tip ?? "";
    expect(tip).toMatch(/tone/);
    expect(tip).toMatch(/notification/);
    expect(tip).toMatch(/topbar gear/);
    // The control the tip means, and the cog it is drawn with — in the run
    // App.tsx draws in the topbar, which holds Settings first.
    expect(bar).toMatch(/<UtilityRun items=\{rails\.utilities\}/);
    expect(run).toMatch(/utilities: \[settings, feedback\]/);
    expect(run).toMatch(/ariaLabel: "Settings", glyph: <SettingsGlyph \/>/);
    expect(run).toContain(GEAR_PATH);
  });
});
