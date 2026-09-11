// The README's pictures of the two guides, rendered from the guides themselves.
//
// The in-app tour is React drawing SVG through the sheet's own tokens. This
// renders each step's drawing to a standalone .svg with those tokens pinned to
// the dark theme, so the README shows exactly what a new install shows and
// cannot drift from it: change a step in src/web/components/guide-art.tsx and
// re-run this, and the README moves with it. Nothing here is a screenshot —
// see canvas-demo.mjs for why a screenshot of this app is a picture of
// somebody's e-mail addresses.
//
//   node assets/guide-svg.mjs
//
import { build } from "esbuild";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url);
const OUT = new URL("./guide/", import.meta.url);
const CSS = readFileSync(new URL("./src/web/styles.css", ROOT), "utf8");

// The dark palette, read out of the sheet rather than copied: the first
// `:root` block is the dark theme, and every --token the drawings read is in
// it. `color-mix` is left as written — every browser GitHub's readers use has
// had it since 2023.
const dark = /:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";
const tokens = [...dark.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)]
  .filter(m => !m[1].startsWith("--session") && !m[1].startsWith("--usage"))
  .map(m => `${m[1]}:${m[2].trim()}`).join(";");
// The drawings' own rules: everything from the guides marker to the intro
// card, which is the first rule after them that is not a drawing's.
const start = CSS.indexOf("/* The drawings. Every fill");
const end = CSS.indexOf("/* Local network while it is off");
const rules = CSS.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\n\s*\n/g, "\n").trim();

// Inside the checkout rather than under the OS temp dir, so the bundle's
// `import "react"` resolves to the checkout's own copy — the one react-dom
// below is going to render with.
mkdirSync(new URL("./node_modules/.cache/", ROOT), { recursive: true });
const tmp = mkdtempSync(join(new URL("./node_modules/.cache/", ROOT).pathname, "ccdeck-guide-svg-"));
try {
  await build({
    entryPoints: [new URL("./src/web/components/guide-art.tsx", ROOT).pathname],
    bundle: true, format: "esm", platform: "node", jsx: "automatic",
    outfile: join(tmp, "guide-art.mjs"), logLevel: "silent",
    external: ["react", "react/jsx-runtime"],
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { WELCOME_STEPS, LAN_STEPS } = await import(pathToFileURL(join(tmp, "guide-art.mjs")).href);
  mkdirSync(OUT, { recursive: true });
  const emit = (name, steps) => steps.forEach((step, i) => {
    const svg = renderToStaticMarkup(step.art)
      .replace(/^<svg /, `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="200" role="img" aria-label=${JSON.stringify(step.line)} `)
      // A standalone picture is not decoration: it names itself instead.
      .replace(/ aria-hidden="true" focusable="false"/, "")
      .replace(">", `><style>:root{${tokens}}svg{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;background:var(--bg)}${rules}</style>`);
    writeFileSync(new URL(`./${name}-${i + 1}.svg`, OUT), svg);
    console.log(`${name}-${i + 1}.svg  ${step.line}`);
  });
  emit("welcome", WELCOME_STEPS);
  emit("lan", LAN_STEPS);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
