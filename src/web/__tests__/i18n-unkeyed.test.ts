// No English is written into a component: every word a reader sees is a
// t("key") call, so every language can have it. This runs the same scan as
// `npm run i18n:missing` (scripts/i18n-missing.mjs) over src/web/components,
// for the .tsx files (JSX text, title / aria-label / label / ... attributes,
// strings inside JSX expressions) and, with --logic, for the .ts files there
// that build sentences (labels, notes, announcements).
//
// FAILS on any string the scan finds that is not in EXCEPTIONS below. An
// exception is a named string with the reason it is not keyed, and each one
// must still match something the scan finds, so the list cannot go stale.
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { root, scanTree } from "../../../scripts/i18n-missing.mjs";

interface Exception {
  /** The file (or, ending in /, the folder) the string is in. */
  file: string;
  /** The string as the scan prints it; omitted, every string in `file`. */
  text?: string;
  why: string;
}

const SCREENS_NOT_BUNDLED =
  "Behind a flag that is off: the deck's first-load script must not carry the screen's words (v4-screens-bundle.test.ts), and the catalogs are bundled whole, so these wait for catalogs that load with the screen.";

const EXCEPTIONS: readonly Exception[] = [
  { file: "src/web/components/decision/", why: SCREENS_NOT_BUNDLED },
  { file: "src/web/components/chat/", why: SCREENS_NOT_BUNDLED },
  { file: "src/web/components/terminal/stage-model.ts", text: "That is not a session id.", why: "The engine's own refusal, matched as it arrives to be replaced by the panel's sentence; never shown." },
  { file: "src/web/components/terminal/stage-model.ts", text: "The provider must be claude or codex.", why: "The engine's own refusal, matched as it arrives to be replaced by the panel's sentence; never shown." },
  { file: "src/web/components/guide-art.tsx", text: "Bash(npm test)", why: "A line of Claude Code's own terminal, drawn as it prints it." },
  { file: "src/web/components/guide-art.tsx", text: "&gt; 1. Yes 2. No", why: "Claude Code's own permission prompt, drawn as it prints it." },
  ...["Read", "Grep", "Bash", "Edit"].map(text => ({ file: "src/web/components/guide-art.tsx", text, why: "A Claude Code tool name, which Claude Code prints in English." })),
];

const covers = (e: Exception, file: string, text: string) =>
  (e.file.endsWith("/") ? file.startsWith(e.file) : file === e.file) && (e.text === undefined || e.text === text);

describe.each([
  { name: "components (.tsx)", logic: false },
  { name: "components and the .ts files beside them (--logic)", logic: true },
])("English left in $name", ({ logic }) => {
  const { rows } = scanTree([join(root, "src/web/components")], { logic });
  const hits = rows.flatMap(r => r.hits.map(h => ({ file: r.file, line: h.line, text: h.text })));

  it("is none, outside the named exceptions", () => {
    const left = hits.filter(h => !EXCEPTIONS.some(e => covers(e, h.file, h.text)));
    expect(left.map(h => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });

  it("has no exception the scan no longer finds", () => {
    // Checked in a mode that reports it: a .tsx string by both scans, a .ts
    // string by --logic only.
    const stale = EXCEPTIONS.filter(e => logic || !e.file.endsWith(".ts"))
      .filter(e => !hits.some(h => covers(e, h.file, h.text)));
    expect(stale.map(e => `${e.file}  ${e.text ?? "(folder)"}`)).toEqual([]);
  });
});

describe("the exception list", () => {
  it("stays short and every entry says why", () => {
    expect(EXCEPTIONS.length).toBeLessThanOrEqual(12);
    for (const e of EXCEPTIONS) expect(e.why.trim().length, e.file).toBeGreaterThan(20);
  });
});
