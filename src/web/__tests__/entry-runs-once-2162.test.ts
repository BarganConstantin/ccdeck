// #2162: the page's main bundle ran twice, and both halves of one crash report
// came from that.
//
// WHAT WAS REPORTED, by one 3.42.0 desktop install on Windows inside a minute:
// Minified React error #321, a hook called with no dispatcher, in the Telemetry
// Radar's useModalDismiss; and a removeChild NotFoundError out of React's
// commit. The renderer's frames were in `assets/index-v2.js` and the dispatcher
// the Radar called was in `assets/index-DzDnLqDX.js`, and rebuilt with source
// maps the two are one file: every position in the first lands on the same
// React function in the second. The page had loaded its entry under a URL that
// nothing in ccdeck names.
//
// WHY THAT WAS ENOUGH. The entry chunk was the whole app, and every lazy panel
// imported React and the shared code back out of it by file name,
// `./index-<hash>.js`. A browser keys a module by its URL, so opening the Radar
// fetched the entry again under its hashed name and ran it again: a second
// React, whose dispatcher was null while the first one rendered, and main.tsx's
// createRoot a second time on #root, whose first commit emptied the container
// under the first root, so that root's next deletion found its node gone.
//
// WHAT THIS HOLDS. The entry is src/web/entry.ts and nothing else; the app is a
// chunk of its own, which the entry and every lazy panel import; and no chunk
// imports the entry. However many URLs the entry then arrives under, each copy
// imports the one app chunk, and the browser runs that once.
//
// THE REAL BUILD, IN MEMORY. The question is what Rollup makes of this config,
// so the cases ask Rollup: vite.config.ts as `npm run build` reads it, with
// `write: false` and no minifier, neither of which moves a chunk boundary. A
// dist/web on disk could be any age, and other suites read it while this one
// runs, so nothing is read from it or written to it. The build costs seconds,
// once, in beforeAll, which states its own budget.
import { beforeAll, describe, expect, it } from "vitest";
import { build, normalizePath, type Rollup } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
/** A module id as Rollup spells it: absolute, forward slashes on every OS. */
const id = (rel: string) => normalizePath(resolve(repo, rel));
/** React or React DOM, including the `\0…?commonjs-…` proxies that wrap them. */
const isReact = (module: string) => /\/node_modules\/react(-dom)?\//.test(module);
/** A file name, matched literally inside a pattern. */
const literal = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let chunks: Rollup.OutputChunk[] = [];
let html = "";

beforeAll(async () => {
  const out = await build({
    configFile: resolve(repo, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false, emptyOutDir: false, minify: false, cssMinify: false, reportCompressedSize: false },
  });
  const files = (Array.isArray(out) ? out : [out as Rollup.RollupOutput]).flatMap(o => o.output);
  chunks = files.filter((f): f is Rollup.OutputChunk => f.type === "chunk");
  const page = files.find(f => f.fileName === "index.html");
  html = page?.type === "asset" ? String(page.source) : "";
}, 120_000);

const entry = () => {
  const entries = chunks.filter(c => c.isEntry);
  expect(entries.map(c => c.fileName), "the build has no single entry chunk").toHaveLength(1);
  return entries[0];
};
/** The chunk the app starts in: the one holding main.tsx. */
const app = () => {
  const found = chunks.find(c => c.moduleIds.includes(id("src/web/main.tsx")));
  expect(found, "main.tsx is in no chunk").toBeDefined();
  return found!;
};

describe("the page's entry runs the app once, whatever URL loads it (#2162)", () => {
  it("is imported by no chunk, statically or lazily", () => {
    const name = entry().fileName;
    const importers = chunks.filter(c => c.imports.includes(name) || c.dynamicImports.includes(name));
    expect(
      importers.map(c => c.fileName),
      "these chunks import the entry by its file name, so an entry loaded under any other URL runs a second time",
    ).toEqual([]);
  });

  it("holds none of the app, only the import of it", () => {
    // What else is in it: Vite's modulepreload polyfill, a virtual module, and
    // the HTML proxy that stands for index.html. Neither renders anything.
    const own = entry().moduleIds.filter(m => !m.startsWith("\0") && m !== id("src/web/index.html"));
    expect(own, "app code is back in the entry, where a second copy of the entry runs it twice")
      .toEqual([id("src/web/entry.ts")]);
    expect(entry().imports, "the entry imports something other than the app chunk").toEqual([app().fileName]);
    expect(entry().dynamicImports).toEqual([]);
  });

  it("has one React, in the app chunk, and every lazy panel imports it from there", () => {
    expect(chunks.filter(c => c.moduleIds.some(isReact)).map(c => c.fileName)).toEqual([app().fileName]);
    for (const panel of ["TrafficRadar", "RadioPanel", "BrowserWatchModal", "UsageHistoryModal"]) {
      const chunk = chunks.find(c => c.facadeModuleId === id(`src/web/components/${panel}.tsx`));
      expect(chunk?.isDynamicEntry, `${panel} no longer loads when it opens`).toBe(true);
      expect(chunk!.imports, `${panel} does not take React from the app chunk`).toContain(app().fileName);
    }
  });

  it("still names the stylesheet and the app chunk in the page", () => {
    // A dynamic `import("./main")` would also empty the entry, and would take
    // the stylesheet out of index.html, where it holds the first paint until it
    // has loaded, into a <link> the script adds once it runs. The page names
    // the app chunk too, so it is fetched alongside the entry, not after it.
    const css = [...(app().viteMetadata?.importedCss ?? [])];
    expect(css, "the app chunk carries no stylesheet").toHaveLength(1);
    expect(html).toMatch(new RegExp(`<script type="module"[^>]* src="/${literal(entry().fileName)}">`));
    expect(html, "the page no longer links the stylesheet").toMatch(new RegExp(`<link rel="stylesheet"[^>]* href="/${literal(css[0])}">`));
    expect(html, "the page no longer preloads the app chunk").toMatch(new RegExp(`<link rel="modulepreload"[^>]* href="/${literal(app().fileName)}">`));
  });
});
