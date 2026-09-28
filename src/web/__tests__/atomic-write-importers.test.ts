// Who reaches the atomic-write helpers, and by which door.
//
// The six helpers moved out of installer.mjs into atomic-write.mjs, and
// installer.mjs went on re-exporting them because nine modules imported them
// from there: the prefs, the watch store and its log, the Codex token writer,
// uv-bootstrap, macmon, deck-home, the account-projects cache and the retired
// sound hook. None of those installs a hook, and each one loaded the
// installer's whole module graph to reach a rename. They import from
// atomic-write.mjs now, nothing outside src ever imported the helpers from the
// installer, and the re-export is gone.
//
// Both halves, the way the dead-surface files pin theirs: the door is shut,
// and every module that used it still has what it needs.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withoutComments } from "./tsx-scan";

const SERVER = fileURLToPath(new URL("../../server/", import.meta.url));
const code = (file: string) => withoutComments(readFileSync(join(SERVER, file), "utf8"));
const HELPERS = ["readSettingsForWrite", "writeFileAtomic", "renameWithRetry", "createTemp", "resolveWriteTarget", "stripBom"];

/** The names an import list brings in from `from`, for every such import in `text`. */
const importedFrom = (text: string, from: string) =>
  [...text.matchAll(new RegExp(`import \\{([^}]*)\\} from "${from.replace(/\./g, "\\.")}";`, "g"))]
    .flatMap(m => m[1].split(",").map(s => s.trim()).filter(Boolean));

describe("the atomic-write helpers", () => {
  it("are imported from atomic-write.mjs by every module that uses one", () => {
    const users: Record<string, string[]> = {
      "account-projects.mjs": ["renameWithRetry"],
      "browser-watch-log.mjs": ["renameWithRetry"],
      "browser-watch-store.mjs": ["renameWithRetry", "stripBom"],
      "codex-auth.mjs": ["createTemp", "renameWithRetry", "resolveWriteTarget"],
      "deck-home.mjs": ["renameWithRetry"],
      "deck-prefs.mjs": ["createTemp", "renameWithRetry", "stripBom"],
      "installer.mjs": ["readSettingsForWrite", "writeFileAtomic"],
      "macmon.mjs": ["renameWithRetry"],
      "retire-sound-hook.mjs": ["readSettingsForWrite", "writeFileAtomic"],
      "uv-bootstrap.mjs": ["renameWithRetry"],
    };
    for (const [file, names] of Object.entries(users)) {
      expect(importedFrom(code(file), "./atomic-write.mjs").sort(), file).toEqual([...names].sort());
    }
  });

  it("are not reached through installer.mjs by any server module", () => {
    for (const file of readdirSync(SERVER).filter(f => f.endsWith(".mjs"))) {
      const through = importedFrom(code(file), "./installer.mjs").filter(n => HELPERS.includes(n));
      expect(through, `${file} imports ${through.join(", ")} through installer.mjs`).toEqual([]);
    }
  });

  it("are no longer re-exported by installer.mjs", () => {
    const installer = code("installer.mjs");
    expect(installer).not.toMatch(/export \{[^}]*\} from "\.\/atomic-write\.mjs"/);
    for (const list of installer.matchAll(/^export \{([^}]*)\}/gm)) {
      for (const name of HELPERS) expect(list[1].split(",").map(s => s.trim()), name).not.toContain(name);
    }
  });
});
