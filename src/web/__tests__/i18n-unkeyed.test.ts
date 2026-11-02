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

// ── V4's words outside src/web/components ───────────────────────────────────
//
// The same scan, in logic mode, over the V4 files outside the components
// folder whose words were keyed: the board header, the top bar's counts and
// search field, the rail's rows and meter, the terminal's errors and notices,
// the feedback account's sentences and the Settings labels. Older English in
// other files (listed in the follow-ups, not here) is not this test's yet.
const OUTSIDE_COMPONENTS: readonly string[] = [
  "board-header.ts", "topbar-counts.ts", "node-face.ts", "rail-items.tsx", "rail-model.ts", "rail-row-copy.ts", "rail-usage.ts",
  "board-navigator.ts", "use-asks.ts", "tab-keys.ts", "terminal-api.ts", "terminal-protocol.ts", "terminal-keys.ts",
  "use-terminal-session.ts", "use-stage.ts", "workspace-pane.ts", "status-hints.ts", "inspector-tree.ts", "inspector-tab.ts",
  "account-ui-fields.ts", "settings.ts", "settings-search.ts", "feedback.ts", "feedback-conversations.ts",
  "use-feedback-conversations.ts", "App.tsx", "quick-open-items.tsx", "detail-category.tsx",
];

/** Strings in those files that are not keyed, each with why. None today. */
const EXCEPTIONS_OUTSIDE: readonly Exception[] = [];

describe("English left in V4's files outside the components folder (--logic)", () => {
  const { rows } = scanTree(OUTSIDE_COMPONENTS.map(f => join(root, "src/web", f)), { logic: true });
  const hits = rows.flatMap(r => r.hits.map(h => ({ file: r.file, line: h.line, text: h.text })));

  it("is none, outside the named exceptions", () => {
    const left = hits.filter(h => !EXCEPTIONS_OUTSIDE.some(e => covers(e, h.file, h.text)));
    expect(left.map(h => `${h.file}:${h.line}  ${h.text}`)).toEqual([]);
  });

  it("has no exception the scan no longer finds", () => {
    const stale = EXCEPTIONS_OUTSIDE.filter(e => !hits.some(h => covers(e, h.file, h.text)));
    expect(stale.map(e => `${e.file}  ${e.text ?? "(folder)"}`)).toEqual([]);
  });
});

// The scan cannot see single words or exported constants. These hold each one
// to the key it reads through, and the key to the English it has always shown.
describe("the words the scan cannot see read through a key", () => {
  it("the board header's five labels, the top bar's count pills and search field", async () => {
    const { BOARD_HEAD_LABEL_MSGS } = await import("../board-header");
    const { WORKING_WORD_MSG, DONE_WORD_MSG } = await import("../topbar-counts");
    const { QUICK_OPEN_PLACEHOLDER_MSG } = await import("../rail-items");
    const { en } = await import("../i18n/en");
    expect(BOARD_HEAD_LABEL_MSGS.map(key => en[key])).toEqual(["Waiting on you", "Working", "Done on this board", "Longest wait", "Spent on this board"]);
    expect([en[WORKING_WORD_MSG], en[DONE_WORD_MSG]]).toEqual(["working", "done"]);
    expect(QUICK_OPEN_PLACEHOLDER_MSG).toBe("board.quick.placeholder");
    expect(en[QUICK_OPEN_PLACEHOLDER_MSG]).toBe("Open a session or run a command");
  });

  it("the top bar's Board | Workspace switch", async () => {
    const { VIEW_SWITCH_LABEL_MSG, BOARD_LABEL_MSG, WORKSPACE_LABEL_MSG } = await import("../components/ViewSwitch");
    const { en } = await import("../i18n/en");
    expect([VIEW_SWITCH_LABEL_MSG, BOARD_LABEL_MSG, WORKSPACE_LABEL_MSG].map(key => en[key])).toEqual(["View", "Board", "Workspace"]);
  });

  it("the card's state words and the rail's group labels", async () => {
    const { cardState } = await import("../node-face");
    const { RAIL_GROUP_LABEL_MSGS } = await import("../rail-model");
    const { en } = await import("../i18n/en");
    const base = { kind: "root", state: "active", stopFailure: undefined, waiting: undefined } as Parameters<typeof cardState>[0];
    expect(cardState(base).word).toBe(en["board.card.stateWorking"]);
    expect(cardState({ ...base, state: "done" }).word).toBe(en["board.card.stateDone"]);
    expect(cardState({ ...base, state: "err" }).word).toBe(en["board.card.stateFailed"]);
    expect(RAIL_GROUP_LABEL_MSGS.every(key => typeof en[key] === "string")).toBe(true);
  });

  it("every Settings account label and every exported message key is in the English catalog", async () => {
    const { UI_LABEL_MSGS } = await import("../account-ui-fields");
    const { en } = await import("../i18n/en");
    const keys = [
      ...Object.values(UI_LABEL_MSGS),
      ...(await Promise.all([
        import("../tab-keys"), import("../use-stage"), import("../use-asks"), import("../terminal-keys"), import("../workspace-pane"),
        import("../feedback"), import("../feedback-conversations"),
      ])).flatMap(mod => Object.entries(mod).filter(([name, value]) => /_MSGS?$/.test(name) && value !== undefined)
        .flatMap(([, value]) => (Array.isArray(value) ? value : [value]))),
    ];
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter(key => typeof key !== "string" || typeof en[key] !== "string" || en[key] === "")).toEqual([]);
  });
});

describe("the exception list", () => {
  it("stays short and every entry says why", () => {
    expect(EXCEPTIONS.length).toBeLessThanOrEqual(12);
    for (const e of EXCEPTIONS) expect(e.why.trim().length, e.file).toBeGreaterThan(20);
  });
});
