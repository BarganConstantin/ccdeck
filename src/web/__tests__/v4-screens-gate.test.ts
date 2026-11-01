// Chat and the Decision card are screens only, each behind a flag that is off,
// and off means absent: not reachable, not drawn, not in the first-load chunk,
// no network from the new code. The built half of that (the entry JS and CSS
// carry none of the screens) is v4-screens-bundle.test.ts's, which reads
// dist/web; this half reads the sources, so it holds without a build.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clientSources, WEB_DIR } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { sheetText } from "./sheet-source";
import { NO_SCREENS, readScreenFlags, screensEffective } from "../use-screen-flags";
import { chatShown, ScreensSlot, type ScreensProps } from "../use-screens";
import StageBody, { type StageBodyProps } from "../components/terminal/StageBody";
import StageHeader, { type StageHeaderProps } from "../components/terminal/StageHeader";
import { PERMISSION, TRANSCRIPT } from "./screens-fixtures";

const rel = (p: string) => relative(WEB_DIR, p).replaceAll("\\", "/");
const code = (p: string) => withoutComments(readFileSync(join(WEB_DIR, p), "utf8"));

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  throw new Error(`${rel(from)} imports ${spec}, which does not resolve`);
}
/** Static value imports and `export … from`: not `import type`, not `import()`. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?([^;'"]*?\s+from\s+)?["']([^"']+)["']/gm)) {
    if (m[2]) continue;
    if (m[1] === "export" && !m[3]) continue;
    out.push(m[4]);
  }
  return out;
}
function graphFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [join(WEB_DIR, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    for (const spec of staticImports(withoutComments(readFileSync(file, "utf8")))) {
      const local = resolveLocal(file, spec);
      if (local) queue.push(local);
    }
  }
  return [...seen].map(rel);
}
const SCREEN_PATH = [/^components\/chat\//, /^components\/decision\//, /^components\/screens\.ts$/, /^components\/chat\/chat\.css$/, /^components\/decision\/decision\.css$/];
const reachesScreens = (paths: string[]) => paths.filter(p => SCREEN_PATH.some(re => re.test(p)));

describe("the flags", () => {
  it("are off unless the stored value is exactly 1", () => {
    const store = (v: Record<string, string>) => (k: string) => v[k] ?? null;
    expect(readScreenFlags(store({}))).toEqual(NO_SCREENS);
    expect(readScreenFlags(store({ "agent-dag.chat": "1" }))).toEqual({ chat: true, decision: false });
    expect(readScreenFlags(store({ "agent-dag.decision": "1" }))).toEqual({ chat: false, decision: true });
    for (const v of ["0", "true", "on", "", "yes", "11", " 1"]) {
      expect(readScreenFlags(store({ "agent-dag.chat": v, "agent-dag.decision": v })), `"${v}"`).toEqual(NO_SCREENS);
    }
  });

  it("are off where the browser refuses the store", () => {
    // readStored answers null for a store that throws (storage.ts); the flags read null as off.
    expect(readScreenFlags(() => null)).toEqual(NO_SCREENS);
    expect(readScreenFlags()).toEqual(NO_SCREENS);
  });

  it("count only with the Command Panel's gate on, in Workspace, off a phone", () => {
    const on = { chat: true, decision: true };
    expect(screensEffective(on, { gate: true, workspace: true, phone: false })).toEqual(on);
    expect(screensEffective(on, { gate: false, workspace: true, phone: false })).toEqual(NO_SCREENS);
    expect(screensEffective(on, { gate: true, workspace: false, phone: false })).toEqual(NO_SCREENS);
    expect(screensEffective(on, { gate: true, workspace: true, phone: true })).toEqual(NO_SCREENS);
  });

  it("are declared as named keys in the deck's namespace, in neither the account's fields nor the shape keys", () => {
    const flags = code("use-screen-flags.ts");
    expect(flags).toMatch(/const CHAT_FLAG_KEY = "agent-dag\.chat";/);
    expect(flags).toMatch(/const DECISION_FLAG_KEY = "agent-dag\.decision";/);
    expect(flags).toContain('import { readStored } from "./storage";');
    expect(code("account-ui-fields.ts")).not.toMatch(/agent-dag\.(chat|decision)/);
    expect(code("storage.ts")).not.toMatch(/agent-dag\.(chat|decision)/);
  });

  it("have no Settings row", () => {
    for (const [path, text] of clientSources().map(p => [rel(p), withoutComments(readFileSync(p, "utf8"))] as const)) {
      if (/^use-screen-flags\.ts$|^use-screens\.ts$/.test(path)) continue;
      expect(text, path).not.toMatch(/agent-dag\.(chat|decision)\b/);
    }
  });
});

describe("what a visit loads with the flags off", () => {
  it("reaches no screen from main.tsx: no component, no sheet, no barrel", () => {
    const reached = graphFrom("main.tsx");
    expect(reached).toContain("App.tsx");
    expect(reached.length).toBeGreaterThan(200);
    expect(reachesScreens(reached)).toEqual([]);
  });

  it("reaches no screen from the stage either, except through the one dynamic import", () => {
    const reached = graphFrom("components/terminal/StageShell.tsx");
    expect(reached).toContain("components/terminal/StageBody.tsx");
    expect(reached).toContain("use-screens.ts");
    expect(reached).toContain("use-screen-flags.ts");
    expect(reachesScreens(reached)).toEqual([]);
  });

  it("keeps the two flag modules free of any screen, in value or in name", () => {
    for (const file of ["use-screen-flags.ts", "use-screens.ts"]) {
      for (const spec of staticImports(code(file))) expect(spec, file).not.toMatch(/chat|decision|screens/);
    }
  });

  it("has exactly one dynamic import of the screens, named once, in use-screens.ts", () => {
    expect(code("use-screens.ts")).toMatch(/export const loadScreens = \(\) => import\("\.\/components\/screens"\);/);
    const callers = clientSources()
      .filter(p => /import\(\s*["'][^"']*components\/screens["']\s*\)/.test(withoutComments(readFileSync(p, "utf8"))))
      .map(rel);
    expect(callers).toEqual(["use-screens.ts"]);
  });

  it("imports the screens' sheets from the screens alone, never from styles.css", () => {
    expect(sheetText()).not.toMatch(/\.chat[\s{.\-:[,]|\.dc-/);
    const sheetList = readFileSync(join(WEB_DIR, "styles.css"), "utf8");
    expect(sheetList).not.toMatch(/(chat|decision)\.css/);
    const importers = clientSources().filter(p => /import "\.\/(chat|decision)\.css"/.test(readFileSync(p, "utf8"))).map(rel).sort();
    expect(importers).toEqual(["components/chat/ChatView.tsx", "components/decision/DecisionCard.tsx"]);
  });

  it("does not preload the chunk: nothing calls loadScreens but the two lazy doors", () => {
    const text = code("use-screens.ts");
    expect([...text.matchAll(/loadScreens\(\)/g)]).toHaveLength(2);
    expect(text).not.toMatch(/useEffect|prefetch|modulepreload/);
  });
});

describe("what is drawn with the flags off", () => {
  const screens: ScreensProps = { view: "chat", source: TRANSCRIPT, decision: { model: PERMISSION } };
  const body = (over: Partial<StageBodyProps> = {}) => renderToStaticMarkup(createElement(StageBody, {
    hostRef: { current: null }, phase: { kind: "empty" },
    onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(), ...over,
  } as StageBodyProps));

  it("is the pane it always was, whatever the caller hands it", () => {
    const plain = body({ workspace: true });
    expect(body({ workspace: true, screens })).toBe(plain);
    expect(plain).not.toMatch(/data-view|chat|dc-/);
  });

  it("the slot is nothing with the flags off, with a flag on and nothing to draw, or with no props", () => {
    expect(ScreensSlot({ screens, flags: NO_SCREENS })).toBeNull();
    expect(ScreensSlot({ flags: { chat: true, decision: true } })).toBeNull();
    expect(ScreensSlot({ screens: { view: "chat" }, flags: { chat: true, decision: true } })).toBeNull();
    expect(ScreensSlot({ screens: { view: "term", source: TRANSCRIPT }, flags: { chat: true, decision: false } })).toBeNull();
  });

  it("the slot draws only what a flag allows and the caller gave", () => {
    expect(ScreensSlot({ screens, flags: { chat: true, decision: false } })).not.toBeNull();
    expect(ScreensSlot({ screens: { view: "term", decision: { model: PERMISSION } }, flags: { chat: false, decision: true } })).not.toBeNull();
    expect(ScreensSlot({ screens: { view: "term", decision: { model: PERMISSION } }, flags: { chat: true, decision: false } })).toBeNull();
  });

  it("the pane is Chat only with the flag, the Chat view and a source", () => {
    expect(chatShown({ chat: true, decision: false }, screens)).toBe(true);
    expect(chatShown({ chat: false, decision: true }, screens)).toBe(false);
    expect(chatShown({ chat: true, decision: false }, { ...screens, view: "term" })).toBe(false);
    expect(chatShown({ chat: true, decision: false }, { view: "chat" })).toBe(false);
    expect(chatShown({ chat: true, decision: false }, undefined)).toBe(false);
  });

  it("the deck hands the pane no screens: no caller outside the tests passes any", () => {
    for (const path of ["components/terminal/StageShell.tsx", "components/terminal/TerminalStage.tsx", "components/StageSlots.tsx", "App.tsx"]) {
      expect(code(path), path).not.toMatch(/screens=\{|ScreensProps|view=\{\{/);
    }
  });
});

describe("with a flag set by hand", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a deck with both flags on and no transcript draws today's pane and today's header", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "1" } });
    const markup = renderToStaticMarkup(createElement(StageBody, {
      hostRef: { current: null }, phase: { kind: "empty" }, workspace: true,
      onAdopt: vi.fn(), onNotNow: vi.fn(), onRetry: vi.fn(), onNewSession: vi.fn(),
    } as StageBodyProps));
    expect(markup).not.toMatch(/data-view|chat|dc-/);
    // The header is the deck's own: it is drawn (the session's name is in it), and it
    // carries no switch and none of Chat's words, because the deck hands it no `view`.
    const header = renderToStaticMarkup(createElement(StageHeader, {
      identity: "session:a", name: "web-api", provider: "claude", status: { state: "waiting", phrase: "waiting" },
      keysOwner: "board", chordLabel: "Ctrl+]", canType: true, expanded: false, takeover: false,
      onKeys: vi.fn(), onExpand: vi.fn(), onClose: vi.fn(),
    } as StageHeaderProps));
    expect(header).toContain("web-api");
    expect(header).not.toMatch(/view-switch|view-opt|Chat|dc-/);
  });
});

describe("what the new code never does", () => {
  const NEW = [
    "use-screen-flags.ts", "use-screens.ts", "components/screens.ts",
    ...clientSources().map(rel).filter(p => /^components\/(chat|decision)\//.test(p)),
  ];

  it("lists the files it means", () => {
    expect(NEW.length).toBeGreaterThanOrEqual(14);
  });

  it("makes no request of any kind: no fetch, socket, event source, beacon or XHR", () => {
    for (const path of NEW) {
      expect(code(path), path).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\/api\//);
    }
  });

  it("touches no server file and none of the hook, and no send path", () => {
    for (const path of NEW) {
      const text = code(path);
      expect(text, path).not.toMatch(/src\/server|\.\.\/server|\/hook\//);
      expect(text, path).not.toMatch(/terminal-keys|use-terminal-session|terminal-protocol|sendKeys|send-keys/);
    }
  });

  it("holds no stand-in data: none of the fixtures' texts is in src/", () => {
    const fixture = ["Add rate limiting", "npm test -- rate-limit", "web-api", "Which docs move", "token-bucket", "gradlew", "Getting started"];
    for (const path of NEW) for (const text of fixture) expect(code(path), `${path}: ${text}`).not.toContain(text);
  });

  it("names no design-file path, node id or file key", () => {
    for (const path of NEW) {
      const raw = readFileSync(join(WEB_DIR, path), "utf8");
      expect(raw, path).not.toMatch(/design-v\d|figma\.com|\b\d{1,3}:\d{4,5}\b/i);
    }
    for (const path of ["components/chat/chat.css", "components/decision/decision.css"]) {
      expect(readFileSync(join(WEB_DIR, path), "utf8"), path).not.toMatch(/design-v\d|figma\.com|\b\d{1,3}:\d{4,5}\b/i);
    }
  });
});
