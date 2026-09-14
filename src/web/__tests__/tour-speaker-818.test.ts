// #818: the tour sent a newcomer to "the bell in the topbar", and there is no
// bell. The control that sets the tone and the notification is "Sound
// settings", drawn as a speaker — a cone, with two waves while sound is on and
// a cross while it is off — so a reader following the tip looked for a shape
// that does not exist on the page they were told to look at.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LAN_STEPS, WELCOME_STEPS } from "../components/guide-art";

const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");
const copy = [...WELCOME_STEPS, ...LAN_STEPS].flatMap(s => [s.line, s.tip ?? ""]).join("\n");

describe("the tour names the sound control by what it looks like (#818)", () => {
  it("never mentions a bell", () => {
    expect(copy).not.toMatch(/\bbell\b/i);
  });

  it("points at the speaker, which is what the topbar draws", () => {
    expect(copy).toMatch(/speaker in the topbar/);
    // The control the tip means, and the cone it is drawn with.
    expect(app).toMatch(/aria-label="Sound settings"/);
    expect(app).toContain('d="M3.2 5.2h2L7.8 3v8L5.2 8.8h-2z"');
  });
});
