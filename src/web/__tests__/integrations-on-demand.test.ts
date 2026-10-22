// The integrations' modal and panels load the first time one opens, as Usage
// history, Browser Watch and Telemetry Radar do (#883): a deck that offers no
// integration, or never opens one, never fetches the Jira backlog, the forges'
// tabs and item pages or either HTML tree. What the rail, Settings and the
// keyboard sheet need to decide what to draw — the list read, the registry,
// Settings › Integrations — stays in the page's own bundle.
//
// Read as source, the way serve-lighter-883.test.ts reads the other three: the
// page's static imports are walked from its entry, and a module reached only
// through import() is not part of the bundle the page loads first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// What the browser's import() does when the server no longer has the chunk.
vi.mock("../components/IntegrationModal", () => {
  throw new TypeError("Failed to fetch dynamically imported module: /assets/IntegrationModal-OLDHASH.js");
});

import { LazyIntegrationModal, preloadIntegrationModal } from "../components/IntegrationModalOnDemand";
import { INTEGRATION_PANELS } from "../integrations/panels";
import { integrationDefs } from "../integrations/registry";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

/** The relative modules a file imports for their values: `import type` and
 *  `export type` are erased, import() is not static, and a stylesheet is not
 *  a module the walk follows. */
function staticImports(file: string): string[] {
  // Comments that open a line ("image/*" in a string is not one).
  const src = readFileSync(file, "utf8").replace(/^\s*\/\*[\s\S]*?\*\//gm, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[] = [];
  // An import's clause holds no semicolon, so a match never runs on past it.
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\s+from\s+)?["'](\.{1,2}\/[^"']+)["'];?/gm)) {
    if (m[1]) continue;
    const spec = m[2];
    if (/\.css$/.test(spec)) continue;
    const base = join(dirname(file), spec);
    const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
      .find(p => existsSync(p) && statSync(p).isFile());
    if (hit && /\.(ts|tsx|mjs|js)$/.test(hit)) out.push(hit);
  }
  return out;
}

/** Every module the page's entry reaches through static imports, relative to
 *  src/web. */
function firstLoad(): Set<string> {
  const seen = new Set<string>();
  const queue = [join(WEB, "entry.ts")];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...staticImports(file));
  }
  return new Set([...seen].map(f => relative(WEB, f)));
}

describe("the page's first load carries no tracker's panel", () => {
  const reached = firstLoad();

  it("walks the page from its entry", () => {
    // The walk finds what it must, or the negatives below would prove nothing.
    for (const rel of ["main.tsx", "App.tsx", "components/DeckDialogs.tsx", "components/SettingsModal.tsx"]) {
      expect(reached.has(rel), rel).toBe(true);
    }
  });

  it("leaves the modal, the panels and both HTML trees to the modal's own chunk", () => {
    for (const rel of [
      "components/IntegrationModal.tsx", "integrations/panels.tsx", "components/IntegrationSplit.tsx",
      "components/JiraPanel.tsx", "components/JiraBacklog.tsx", "components/JiraIssueDetail.tsx", "jira-html.tsx",
      "use-jira-board.ts", "components/forge/ForgePanel.tsx", "components/ForgeHtml.tsx", "forge-html.ts",
      "forge-panel.ts", "use-forge-read.ts",
    ]) {
      expect(reached.has(rel), rel).toBe(false);
    }
  });

  it("keeps what decides what to draw: the list, the registry, Settings › Integrations and the on-demand wrapper", () => {
    for (const rel of [
      "integrations/client.ts", "integrations/registry.ts", "components/IntegrationsSection.tsx",
      "components/IntegrationConnectionForm.tsx", "components/IntegrationModalOnDemand.tsx",
    ]) {
      expect(reached.has(rel), rel).toBe(true);
    }
  });

  it("gives every provider in the registry its panel in the chunk", () => {
    expect(Object.keys(INTEGRATION_PANELS).sort()).toEqual(integrationDefs().map(d => d.kind).sort());
    for (const def of integrationDefs()) expect(def, def.kind).not.toHaveProperty("Panel");
  });
});

describe("the modal loads when it opens", () => {
  const onDemand = read("components/IntegrationModalOnDemand.tsx");
  const app = read("App.tsx");

  it("is React.lazy through lazyDialog, drawing nothing while the chunk arrives, as the other three", () => {
    expect(onDemand).toContain('const loadIntegrationModal = () => import("./IntegrationModal");');
    expect(onDemand).toMatch(/export const LazyIntegrationModal = lazyDialog\(loadIntegrationModal, /);
    // Its fallback draws nothing (it holds Escape for the dialog meanwhile:
    // integrations-on-demand-escape.test.ts).
    expect(onDemand).toMatch(/<Suspense fallback=\{<Opening onClose=\{props\.onClose\} \/>\}>\s*<LazyIntegrationModal \{\.\.\.props\} \/>\s*<\/Suspense>/);
    expect(onDemand).toMatch(/function Opening\(\{ onClose \}: \{ onClose: \(\) => void \}\) \{\s*useEffect\(\(\) => modalStack\.push\(onClose, 0, "dialog"\), \[onClose\]\);\s*return null;\s*\}/);
    expect(app).toMatch(/^import IntegrationModal, \{ preloadIntegrationModal \} from "\.\/components\/IntegrationModalOnDemand";$/m);
    expect(app).not.toMatch(/from "\.\/components\/IntegrationModal";/);
  });

  it("is fetched the moment a rail control is up, so the first press finds it", () => {
    expect(app).toContain("const integrationShown = connectedKinds.length > 0;");
    expect(app).toContain("useEffect(() => { if (integrationShown) preloadIntegrationModal(); }, [integrationShown]);");
  });
});

const LAZY = Symbol.for("react.lazy");
type Lazy = { $$typeof: symbol; _payload: unknown; _init: (p: unknown) => ComponentType<Record<string, unknown>> };

/** What React.lazy hands the renderer once the import has settled. */
async function settle(type: Lazy): Promise<ComponentType<Record<string, unknown>>> {
  try {
    return type._init(type._payload);
  } catch (pending) {
    if (pending && typeof (pending as Promise<unknown>).then === "function") {
      await (pending as Promise<unknown>).then(() => {}, () => {});
      return type._init(type._payload);
    }
    throw pending;
  }
}

describe("a modal whose chunk does not arrive", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("fails as that tracker's dialog alone, named for it, with the reload", async () => {
    const type = LazyIntegrationModal as unknown as Lazy;
    expect(type.$$typeof).toBe(LAZY);
    const Shown = await settle(type);
    const html = renderToStaticMarkup(createElement(Shown, { kind: "jira", connections: [], onClose: () => {}, onReconnect: () => {} }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain(">Jira</span>");
    expect(html).toContain("Jira did not load.");
    expect(html).toMatch(/>Reload</);
    expect(html).toMatch(/>Close</);
  });

  it("leaves a failed preload for the press to show, with nothing thrown", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      preloadIntegrationModal();
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
