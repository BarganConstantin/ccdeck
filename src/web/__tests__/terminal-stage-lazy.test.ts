// The terminal stage costs a deck with the flag off nothing (DESIGN-UI decision
// 9): no xterm, no stage, no navigator in what main.tsx's static imports reach,
// one dynamic import as the only way in, and nothing rendered, mounted or
// fetched until the flag says so.
//
// The built half of this — that the entry chunk and its stylesheet carry none
// of xterm's fingerprints — is notices-bundle.test.ts's, which reads dist/web.
// This half reads the sources, so it holds without a build: it walks the
// import graph the way Rollup will, following every static import and export
// and stopping at a dynamic import(), which is exactly where Rollup cuts a
// chunk.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { WEB_DIR } from "./client-source";
import { withoutComments } from "./tsx-scan";
import { StageDockSlot, StageNavigatorSlot } from "../components/StageSlots";
import { initialShell } from "../stage-shell";
import type { Stage } from "../use-stage";

const rel = (p: string) => relative(WEB_DIR, p).replaceAll("\\", "/");
const code = (p: string) => withoutComments(readFileSync(join(WEB_DIR, p), "utf8"));

/** A specifier, resolved the way Vite does for this tree: a file, or one of
 *  the extensions, or a folder's index. Null for a package. */
function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  throw new Error(`${rel(from)} imports ${spec}, which does not resolve`);
}

/** The specifiers a module imports statically and for its value: `import x
 *  from`, `import "x"`, `export … from`. Not `import type`/`export type`,
 *  which compile away, and not `import()`, which is a chunk boundary. */
function staticImports(source: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^;'"]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of source.matchAll(re)) {
    if (m[2]) continue;
    if (m[1] === "export" && !m[3]) continue;
    out.push(m[4]);
  }
  return out;
}

/** Every local module and every package main.tsx's static graph reaches. */
function firstLoadGraph(): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const queue = [join(WEB_DIR, "main.tsx")];
  while (queue.length) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    for (const spec of staticImports(withoutComments(readFileSync(file, "utf8")))) {
      const local = resolveLocal(file, spec);
      if (local) queue.push(local);
      else packages.add(spec);
    }
  }
  return { modules, packages };
}

describe("what a visit loads with the terminal flag off", () => {
  const { modules, packages } = firstLoadGraph();
  const reached = [...modules].map(rel);

  it("walks the real graph, so an empty answer below means something", () => {
    expect(reached).toContain("App.tsx");
    expect(reached).toContain("use-stage.ts");
    expect(reached).toContain("components/StageSlots.tsx");
    expect(reached.length).toBeGreaterThan(200);
    expect(packages).toContain("reactflow");
  });

  it("reaches no xterm package, not even its stylesheet", () => {
    expect([...packages].filter(p => p.startsWith("@xterm/"))).toEqual([]);
  });

  it("reaches none of the stage, the navigator or the motion between them", () => {
    const lazyOnly = [
      /^components\/terminal\//,
      /^components\/BoardNavigator\.tsx$/,
      /^navigator-flip\.ts$/,
      /^board-navigator\.ts$/,
      /^stage-morph\.ts$/,
      /^use-terminal-session\.ts$/,
      /^terminal-protocol\.ts$/,
      /^xterm-sheet\.ts$/,
    ];
    expect(reached.filter(p => lazyOnly.some(re => re.test(p)))).toEqual([]);
  });
});

describe("the one way in", () => {
  it("is a dynamic import of the shell, named once, in use-stage.ts", () => {
    expect(code("use-stage.ts")).toMatch(/export const loadStageShell = \(\) => import\("\.\/components\/terminal\/StageShell"\);/);
    const callers = ["App.tsx", "components/StageSlots.tsx", "use-stage.ts"]
      .filter(p => /import\(\s*["'][^"']*terminal\/StageShell["']\s*\)/.test(code(p)));
    expect(callers, "a second dynamic import of the shell would be a second door to keep shut").toEqual(["use-stage.ts"]);
  });

  it("is reached through React.lazy with nothing drawn while it loads", () => {
    const slots = code("components/StageSlots.tsx");
    expect(slots).toMatch(/const LazyNavigator = lazy\(\(\) => loadStageShell\(\)\.then\(/);
    expect(slots).toMatch(/const LazyDock = lazy\(\(\) => loadStageShell\(\)\.then\(/);
    expect([...slots.matchAll(/<Suspense fallback=\{null\}>/g)]).toHaveLength(2);
    // Only types cross from the shell into the first-load chunk.
    expect(slots).toMatch(/import type \{ StageDockProps, StageNavigatorProps \} from "\.\/terminal\/StageShell";/);
  });

  it("is fetched only once the flag is known to be on", () => {
    expect(code("use-stage.ts")).toMatch(/useEffect\(\(\) => \{\s*if \(enabled\) loadStageShell\(\)\.catch\(\(\) => \{\}\);\s*\}, \[enabled\]\);/);
    expect(code("use-stage.ts")).toMatch(/const \[enabled, setEnabled\] = useState\(false\);/);
    expect(code("use-stage.ts")).toMatch(/setEnabled\(d\.terminalOn === true\)/);
    expect(code("use-prefs-read.ts")).toMatch(/loadTerminalPrefs\?\.\(d\);/);
    expect(code("App.tsx")).toMatch(/loadTerminalPrefs: stage\.loadTerminalPrefs,/);
  });

  it("puts the navigator inside <main> and the stage after it", () => {
    const app = code("App.tsx");
    const main = app.slice(app.indexOf("<CanvasMain"), app.indexOf("</CanvasMain>"));
    expect(main).toMatch(/<StageNavigatorSlot stage=\{stage\} \/>/);
    const after = app.slice(app.indexOf("</CanvasMain>"));
    expect(after.indexOf("<StageDockSlot")).toBeGreaterThan(-1);
    expect(after.indexOf("<StageDockSlot"), "the stage comes before the detail panel in the tab order")
      .toBeLessThan(after.indexOf("<DetailAside"));
  });
});

describe("what the slots draw", () => {
  /** A stage as use-stage.ts hands it over, closed, with the flag as given. */
  const stage = (enabled: boolean, phase = "closed") =>
    ({ enabled, shell: { ...initialShell(), phase } }) as unknown as Stage;
  const draw = (enabled: boolean, phase?: string) => [
    renderToStaticMarkup(createElement(StageNavigatorSlot, { stage: stage(enabled, phase) })),
    // The dock's other props are never read before the flag and the phase.
    renderToStaticMarkup(createElement(StageDockSlot, { stage: stage(enabled, phase) } as never)),
  ];

  it("is nothing at all with the flag off, whatever the stage's state claims", () => {
    expect(draw(false)).toEqual(["", ""]);
    expect(draw(false, "open")).toEqual(["", ""]);
  });

  it("is nothing with the flag on and the stage closed", () => {
    expect(draw(true)).toEqual(["", ""]);
  });
});

describe("the flag off in the rest of the deck", () => {
  it("adds no attribute to <main>, no button to the canvas, no region to the page", () => {
    const app = code("App.tsx");
    // Each of these is undefined, or not rendered, unless the flag is on.
    expect(app).toMatch(/stagePhase=\{stage\.enabled && stage\.shell\.phase !== "closed" \? stage\.shell\.phase : undefined\}/);
    expect(app).toMatch(/onTerminal=\{stage\.enabled \? stage\.openFromButton : undefined\}/);
    expect(app).toMatch(/startAsks=\{stage\.enabled \? asks\.startAsks : undefined\} asksSaid=\{stage\.enabled \? asks\.said : undefined\}/);
    expect(app).toMatch(/\{stage\.enabled && <div className="vis-hidden" role="status" aria-atomic="true">\{stage\.said\}<\/div>\}/);
    expect(code("components/CanvasControls.tsx")).toMatch(/\{onTerminal && \(\s*<ControlButton/);
    expect(code("components/TopbarReadouts.tsx")).toMatch(/\{asksSaid != null && <div className="vis-hidden"/);
  });

  it("hands the click, the session list and the keys a stage that answers 'not mine'", () => {
    const stageHook = code("use-stage.ts");
    // Every entry point opens with the flag.
    expect(stageHook).toMatch(/const onNodeClick = useCallback\(\(id: string, el: Element \| null\): boolean => \{\s*if \(!enabledRef\.current\) return false;/);
    expect(stageHook).toMatch(/const followSession = useCallback\(\(sessionId: string\): boolean => \{\s*if \(!enabledRef\.current \|\| /);
    expect(stageHook).toMatch(/if \(!enabledRef\.current\) return;\s*const focus = /);
    expect(stageHook).toMatch(/keysRef\.current = enabled\s*\?/);
    expect(stageHook).toMatch(/waitingSessions: enabled \? waitingSessions : NO_WAITING,/);
    // And the click keeps every line it had after the stage's own.
    expect(code("use-canvas-clicks.ts"))
      .toMatch(/if \(stage\?\.onNodeClick\(id, e\.currentTarget as Element\)\) \{ focusHold\.cancel\(\); return; \}/);
  });
});
