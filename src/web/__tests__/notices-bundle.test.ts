// #962: THIRD_PARTY_NOTICES.md said Vite never reaches the published bundle,
// and the published bundle opened with Vite's code.
//
// WHAT WAS OBSERVED at 26e946b. The file's second bullet listed `vite` among
// devDependencies that "never reach the published bundle". The first bytes of
// `dist/web/assets/index-*.js` were Vite's `modulePreloadPolyfill` verbatim —
// the `link[rel="modulepreload"]` feature test, then the `MutationObserver`
// watching for late ones — followed by its bundled CommonJS interop helpers.
// `dist/web` is in `package.json` `files`, so that code is physically in the
// npm tarball. Vite 6.4.3 is MIT, `Copyright (c) 2019-present, VoidZero Inc.
// and Vite contributors`, and it appeared nowhere in the notices.
//
// This is load-bearing rather than cosmetic. ccdeck distributes under
// AGPL-3.0-only, and this file is what a downstream redistributor reads to know
// what attribution travels with the tarball. It told them Vite was excluded and
// shipped Vite's code.
//
// The same audit found the mirror-image problem: the file's own preamble says
// everything in the bundled table "is compiled into that bundle and physically
// present in the published tarball", and three entries were not — `js-tokens`
// and `loose-envify`, which are a browserify transform and its dependency that
// Rollup never invokes, and `@reactflow/node-toolbar`, tree-shaken. Those are
// over-attribution and harmless legally; they are moved rather than deleted
// because the preamble makes their presence a factual claim.
//
// WHY THIS FILE DERIVES RATHER THAN PINS. A test that simply asserted the word
// "vite" appears in the notices would pass on the day somebody deleted the
// entry and re-added the old bullet, and would say nothing about the next
// package to arrive in or leave the bundle. So the direction of every assertion
// below runs from the ARTIFACT to the DOCUMENT: read what `vite build` actually
// emitted into dist/web/assets, look for each package's fingerprint in it, and
// require the notices to agree — present means a row in the bundled table,
// absent means a row under "declared but not emitted", and never both.
//
// ABOUT THE FINGERPRINTS. Each is a string literal that a minifier cannot
// rename: a CSS class name, a `querySelectorAll` selector, or a fragment of a
// regex literal. An identifier would have been useless — esbuild renames them
// all — and the two browserify packages are only checkable at all because each
// exports a regex whose source survives verbatim. Where a package's
// distinguishing string is genuinely unrecoverable it does not belong in this
// list; an absence that proves nothing is worse than no case.
//
// PLAIN NODE. The notices and the built chunks are read as text; nothing here
// imports a module that touches the filesystem on its own.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), "utf8");
const notices = read("THIRD_PARTY_NOTICES.md");

// The gate condition is spelled exactly as theme-first-paint.test.ts and
// tarball-install-smoke.test.ts spell theirs, because skip-gates.mjs keys the
// register on that source text and the three sites have to read as one
// condition. CI builds before it runs the suite, so this never skips there.
const dist = join(repo, "dist", "web", "index.html");
const assets = join(repo, "dist", "web", "assets");

/** Everything `vite build` emitted, JS and CSS together, as one string.
 *
 *  Both, not just the JS, and that distinction is the single correction this
 *  file makes to the issue that prompted it — see the node-resizer case below. */
const emitted = () =>
  readdirSync(assets)
    .filter((f) => f.endsWith(".js") || f.endsWith(".css"))
    .map((f) => readFileSync(join(assets, f), "utf8"))
    .join("\n");

/**
 * A package, and a string only that package's code puts in the output.
 *
 * `in the output` is the whole claim, so every needle here was checked against
 * a real build before it was written down, and the count observed at the time
 * is in the comment beside it. A needle that stops appearing because the
 * package was upgraded rather than dropped will fail this file, which is
 * correct: the notices are a statement about a specific version.
 */
const FINGERPRINTS: { pkg: string; needle: string; note: string }[] = [
  {
    pkg: "vite",
    // The first bytes of the entry chunk. Vite injects this polyfill itself; it
    // is not reachable from src/web and no dependency emits it.
    needle: 'link[rel="modulepreload"]',
    note: "Vite's modulePreloadPolyfill, which is what the entry chunk opens with",
  },
  { pkg: "@reactflow/background", needle: "react-flow__background", note: "the background pattern's class name" },
  { pkg: "@reactflow/controls", needle: "react-flow__controls", note: "the zoom control bar's class name" },
  { pkg: "@reactflow/minimap", needle: "react-flow__minimap", note: "the minimap's class name" },
  {
    pkg: "@reactflow/node-resizer",
    // JS: nowhere. CSS: 27 rules, via reactflow/dist/style.css, which
    // src/web/main.tsx imports. See the case that spells this out.
    needle: "react-flow__resize-control",
    note: "the resize handle's class name, which reaches the bundle through reactflow's stylesheet",
  },
  { pkg: "@reactflow/node-toolbar", needle: "react-flow__node-toolbar", note: "the node toolbar's class name" },
  {
    pkg: "js-tokens",
    // The flags character class out of its single exported regex. Inside a
    // regex literal, so it survives minification exactly as written.
    needle: "[gmiyus]{1,6}",
    note: "a fragment of its one exported regex",
  },
  {
    pkg: "loose-envify",
    // The body of `processEnvRe` in loose-envify/replace.js. Also a regex
    // literal, and distinctive enough not to collide with anything else.
    needle: "[_$a-zA-Z][$\\w]+",
    note: "the body of its process.env matcher",
  },
];

/** The slice of the notices between two headings, so a table is read out of the
 *  section it belongs to rather than out of the whole file. */
const section = (from: string, to: string) => {
  const start = notices.indexOf(from);
  expect(start, `THIRD_PARTY_NOTICES.md no longer has the heading "${from}"`).toBeGreaterThan(-1);
  const end = notices.indexOf(to, start);
  expect(end, `THIRD_PARTY_NOTICES.md no longer has the heading "${to}" after "${from}"`).toBeGreaterThan(start);
  return notices.slice(start, end);
};

const BUNDLED = "## Bundled packages";
const NOT_EMITTED = "### Declared but not emitted";
const TEXTS = "## Full licence texts";

/** The package names in one section's table, read off the first column. */
const packagesIn = (body: string) => [...body.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]);

/** One package's whole row, for the assertions that read further along it. */
const rowFor = (body: string, pkg: string) =>
  body.split("\n").find((line) => line.startsWith(`| \`${pkg}\` |`)) ?? "";

const bundled = () => packagesIn(section(BUNDLED, NOT_EMITTED));
const notEmitted = () => packagesIn(section(NOT_EMITTED, TEXTS));

/** The count a heading states in brackets, which is the kind of number that
 *  goes stale — publish.yml's "17" is this repo's own worked example. */
const statedCount = (heading: string) => {
  const found = new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\((\\d+)\\)`).exec(notices);
  expect(found, `the "${heading}" heading no longer states a count in brackets`).not.toBeNull();
  return Number(found![1]);
};

describe("the two lists the notices keep, and the counts on them", () => {
  it("states a count for each list that matches the rows under it", () => {
    expect(statedCount(BUNDLED), "the bundled count and the bundled table disagree").toBe(bundled().length);
    expect(statedCount(NOT_EMITTED), "the not-emitted count and its table disagree").toBe(notEmitted().length);
  });

  it("never puts a package on both lists", () => {
    // The two lists make opposite claims about the same tarball, so an entry on
    // both is not a duplicate — it is a contradiction.
    const both = bundled().filter((p) => notEmitted().includes(p));
    expect(both, `${both.join(", ")} is listed as both bundled and not emitted`).toEqual([]);
  });

  it("gives every bundled package the version npm actually resolved", () => {
    // The versions are the half of a notice nobody re-reads, and a dependency
    // bump changes the licence text often enough to matter — d3-color's
    // 2010-2022 against its siblings' 2010-2021 is this file's own example of a
    // copyright line that moved with a version. Read out of node_modules rather
    // than out of package-lock.json, because what ships is what was installed.
    for (const pkg of [...bundled(), ...notEmitted()]) {
      const manifest = join(repo, "node_modules", pkg, "package.json");
      expect(existsSync(manifest), `THIRD_PARTY_NOTICES.md lists ${pkg}, which is not in node_modules`).toBe(true);
      const version = JSON.parse(readFileSync(manifest, "utf8")).version;
      const row = rowFor(section(BUNDLED, TEXTS), pkg);
      expect(row, `${pkg} is listed at a version other than the installed ${version}`)
        .toContain(`| ${version} |`);
    }
  });

  it("no longer tells a redistributor that Vite is excluded", () => {
    // The sentence the issue is named for. It listed vite, vitest, typescript
    // and @vitejs/plugin-react together as tooling that "never reach the
    // published bundle"; three of those four are true and the fourth ships.
    const bullet = notices.slice(notices.indexOf("deliberately **not** listed"), notices.indexOf(BUNDLED));
    expect(bullet, "the not-distributed bullet names `vite` again, which is the false claim #962 was filed for")
      .not.toMatch(/\(`vite`|`vite`,/);
    for (const tool of ["vitest", "typescript", "@vitejs/plugin-react", "@types/*"]) {
      expect(bullet, `the not-distributed bullet no longer names ${tool}`).toContain(tool);
    }
  });
});

describe("the tools ccdeck fetches onto the user's machine", () => {
  const fetched = () => section("### Software ccdeck fetches but does not distribute", BUNDLED);

  /** The names in that section's bullet list. */
  const named = () => [...fetched().matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);

  it("spells a count that matches the tools it goes on to name", () => {
    // It said "three" and named macmon, uv and ccusage. There are four:
    // claude-swap is installed from PyPI by src/server/cswap-install.mjs, into
    // the user's GLOBAL tool path, unprompted at startup, and it handles Claude
    // credentials — the one of the four a reader would most want named. The
    // README had it right at two places; only the list presenting itself as
    // exhaustive left it out.
    const words: Record<string, number> = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6 };
    const stated = /^(One|Two|Three|Four|Five|Six) third-party tools?/m.exec(fetched());
    expect(stated, "the fetched-tools section no longer opens by counting them").not.toBeNull();
    expect(words[stated![1]], "the number spelled out and the tools listed disagree").toBe(named().length);
  });

  it("names only tools the server really fetches, claude-swap included", () => {
    // Each name is checked back against the code that installs it, so the list
    // cannot drift in either direction: a tool dropped from the server and left
    // here, or one added to the server and never written down.
    const server = readdirSync(join(repo, "src", "server"))
      .filter((f) => f.endsWith(".mjs"))
      .map((f) => read("src", "server", f))
      .join("\n");
    expect(named(), "claude-swap is missing from the list again").toContain("claude-swap");
    for (const tool of named()) {
      expect(server, `THIRD_PARTY_NOTICES.md names ${tool}, and nothing under src/server mentions it`)
        .toContain(tool);
    }
  });
});

// Everything above reads documents. Everything below reads the ARTIFACT, which
// is the only place the question "what is actually in the tarball" can be
// answered — so it is gated on a build being on disk, the same way
// theme-first-paint.test.ts and tarball-install-smoke.test.ts are, and
// registered in skip-gates.mjs alongside them. CI builds before the suite runs,
// so these never skip there; locally without a build the reporter says so
// instead of pretending.
describe.skipIf(!existsSync(dist))("what the build actually emitted", () => {
  it("attributes every package whose code is in the chunks", () => {
    const out = emitted();
    for (const { pkg, needle, note } of FINGERPRINTS) {
      if (!out.includes(needle)) continue;
      expect(
        bundled(),
        `dist/web/assets contains ${note} (${needle}), so ${pkg}'s code is physically in the npm tarball and `
          + "THIRD_PARTY_NOTICES.md has to attribute it under `## Bundled packages`",
      ).toContain(pkg);
    }
  });

  it("does not claim a package is in the tarball when its code is not", () => {
    const out = emitted();
    for (const { pkg, needle, note } of FINGERPRINTS) {
      if (out.includes(needle)) continue;
      expect(
        notEmitted(),
        `${needle} (${note}) appears nowhere in dist/web/assets, so ${pkg} is not in the tarball — and the `
          + "preamble makes the bundled table a claim that everything on it is. It belongs under "
          + `"${NOT_EMITTED}".`,
      ).toContain(pkg);
      // And the notices say what was looked for, so the document and this file
      // cannot drift into searching for two different things.
      expect(rowFor(section(NOT_EMITTED, TEXTS), pkg), `${pkg}'s row does not record the string that was searched for`)
        .toContain(needle);
    }
  });

  it("opens with Vite's own code, which is the fact the file used to deny", () => {
    // Stated as its own case rather than left to the loop, because it is the
    // issue: the polyfill is the first thing in the entry chunk, it comes from
    // the build tool and not from any dependency, and the notices said it was
    // not there.
    const entry = readdirSync(assets).filter((f) => f.startsWith("index-") && f.endsWith(".js"));
    expect(entry, "no index-*.js entry chunk in dist/web/assets").toHaveLength(1);
    const js = readFileSync(join(assets, entry[0]), "utf8");
    expect(js.slice(0, 400), "the entry chunk no longer opens with Vite's modulePreloadPolyfill")
      .toContain('link[rel="modulepreload"]');
    expect(bundled(), "Vite emits code into the tarball and is not attributed").toContain("vite");
    expect(notices, "the Vite licence text is not reproduced").toContain("VoidZero Inc. and Vite contributors");
  });

  it("keeps node-resizer attributed on the strength of its stylesheet", () => {
    // The one place this file disagrees with the issue that prompted it. #962
    // grepped the JS chunks, found no `react-flow__resize-control`, and
    // concluded @reactflow/node-resizer was tree-shaken out of the tarball. The
    // JS half is right. But reactflow/dist/style.css — which src/web/main.tsx
    // imports — inlines the resizer's stylesheet, and those rules land in
    // dist/web/assets/index-*.css, which ships. So the package IS in the
    // tarball, its row was never over-attribution, and the case is written out
    // here so that the next person to grep only the JS finds the answer.
    const css = readdirSync(assets).filter((f) => f.endsWith(".css"));
    expect(css.length, "no CSS in dist/web/assets to check").toBeGreaterThan(0);
    const styles = css.map((f) => readFileSync(join(assets, f), "utf8")).join("\n");
    expect(styles, "the resizer stylesheet has left the bundle — node-resizer may now belong under not-emitted")
      .toContain("react-flow__resize-control");
    expect(bundled()).toContain("@reactflow/node-resizer");
  });
});
