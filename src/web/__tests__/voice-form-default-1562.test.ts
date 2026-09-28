// The spoken-voice form starts on "System default" (#1562).
//
// The Voice dropdown offers "System default" first, and the form used to leave
// it the moment the browser reported its voices: the voices effect set the
// field to the first voice in the list. That is whatever the browser puts
// first — on macOS a novelty voice like "Albert" — so a phrase added without
// opening the dropdown was spoken in it rather than in the system's own voice.
//
// Nothing in this suite renders React, so this reads the section: the field
// starts empty, empty is the System default option, the only write to the
// field is the dropdown's own, and the voices effect touches the list alone.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withoutComments } from "./tsx-scan";

const section = withoutComments(readFileSync(
  fileURLToPath(new URL("../components/CustomSoundsSection.tsx", import.meta.url)), "utf8"));

describe("the spoken voice form's Voice field (#1562)", () => {
  it("starts on System default", () => {
    expect(section).toMatch(/const \[voiceURI, setVoiceURI\] = useState\(""\);/);
    expect(section).toMatch(/value=\{voiceURI\} onChange=\{e => setVoiceURI\(e\.target\.value\)\}>\s*<option value="">System default<\/option>/);
  });

  it("is moved by the person's choice and by nothing else", () => {
    expect([...section.matchAll(/setVoiceURI\(/g)]).toHaveLength(1);
    expect(section).toMatch(/onChange=\{e => setVoiceURI\(e\.target\.value\)\}/);
  });

  it("hands the browser's voices to the dropdown and nothing else", () => {
    const start = section.indexOf("const refresh = () =>");
    const end = section.indexOf('addEventListener("voiceschanged"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const refresh = section.slice(start, end);
    expect(refresh).toContain("setVoices(window.speechSynthesis.getVoices());");
    expect(refresh).not.toMatch(/voiceURI/i);
  });
});
