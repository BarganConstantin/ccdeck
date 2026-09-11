// The setup dialog opens by itself on the press that puts this deck on the
// network, and it ended on a × and nothing else — which reads as a form with
// something still to confirm. Nothing is: every box and switch in it is saved
// the moment it changes. So it ends on Done, says why there is no Save, and
// Done saves the one field that is not saved as it changes.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The dialog with its comments taken out, so a rule cannot be satisfied by a
 *  paragraph that describes it. */
const MODAL = readFileSync(fileURLToPath(new URL("../components/LanSetupModal.tsx", import.meta.url)), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

describe("the setup dialog's way out", () => {
  it("ends on a Done button, the primary one, in a foot of its own", () => {
    expect(MODAL).toMatch(/<footer className="lan-setup-foot">[\s\S]*className="btn primary"[\s\S]*Done[\s\S]*<\/footer>/);
  });

  it("saves a name somebody typed and did not save, and stays open when that fails", () => {
    const body = /const done = useCallback\(async \(\) => \{([\s\S]*?)\}, \[/.exec(MODAL)?.[1] ?? "";
    expect(body).toMatch(/nameDraft != null && nameDraft !== \(status\.name \?\? ""\)/);
    expect(body).toMatch(/await write\(\{ name: nameDraft \}, "save the name", "name"\)/);
    expect(body).toMatch(/if \(!ok\) return;/);
    // Closing comes after the save, never instead of it.
    expect(body.indexOf("onClose()")).toBeGreaterThan(body.indexOf("if (!ok) return;"));
  });

  it("says why there is no Save button", () => {
    expect(MODAL).toMatch(/<span className="lan-foot-note">Changes are saved as you make them\.<\/span>/);
  });
});
