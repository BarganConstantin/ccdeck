// A WORKAROUND FOR BRAND KIT v1.0, and only for it: renders the macOS menu-bar
// templates from the kit's own tray masters into desktop/brand/rendered/macos,
// and rewrites desktop/brand/README.md's file table. Run by hand, never by the
// build, and commit what it writes:
//
//   brew install resvg            # 0.48.1, MPL-2.0; or `cargo install resvg --version 0.48.1`
//   node desktop/scripts/render-tray-templates.mjs
//
// Once a kit ships whole templates, MACOS_TEMPLATES_FROM in icons.mjs becomes
// "kit", the kit's own are copied, and this file can go.
//
// WHY RENDERED AT ALL. The kit's own macOS templates (04-tray-menu/macos) are
// cut off: each draws the mark only in the top-left of its canvas — the 18 px
// default in a 2×2 pixel corner. They cannot be shipped. The kit's monochrome
// masters (04-tray-menu/generic/svg, vendored unchanged under desktop/brand/kit)
// are whole, and a template is a rasterisation of them: black on transparent,
// each size rendered directly at that size, never scaled from a larger one.
//
// AND THE MASTERS HAVE A FAULT OF THEIR OWN. The knockout <mask id="cut"> that
// leaves the centre node as a hole declares no maskUnits, so by the SVG spec
// its region is -10 %..120 % of the masked group's bounding box — 8 to 92
// units — while the strokes reach 5.9 to 94.1. Every conformant renderer
// therefore cuts the four outermost curves flat. The working copy rendered
// here sets that one element's region to the whole viewBox; nothing else in
// the master changes, and the master under kit/ stays as delivered.
//
// WHY RESVG, AND ONE VERSION OF IT. It is a single program with no system
// libraries in the way, so one version gives the same bytes on any machine,
// and the renders could be checked twice for byte-identical output. Another
// version may rasterise an edge pixel differently, so this refuses to run on
// one it was not checked with; moving to a new one is a decision, made by
// changing RESVG_VERSION and looking at every image before it is committed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND, MACOS_TEMPLATE_SIZES, MACOS_TEMPLATE_STEMS, MACOS_TEMPLATES_FROM } from "./icons.mjs";
import { writeTable } from "./vendor-brand-kit.mjs";

export const RESVG_VERSION = "0.48.1";

const MASK = '<mask id="cut">';
const WHOLE_VIEWBOX_MASK = '<mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">';

/**
 * The master with its knockout mask's region set to the whole 100-unit viewBox,
 * and not one other byte changed. Refuses a master that is not shaped the way
 * the kit's v1.0 masters are, rather than rendering something nobody checked.
 */
export function withWholeMaskRegion(svg) {
  const at = svg.indexOf(MASK);
  if (at === -1 || svg.indexOf(MASK, at + 1) !== -1) {
    throw new Error(`expected exactly one ${MASK} in the master; a re-exported kit may have fixed it, so look before rendering`);
  }
  if (!svg.includes('viewBox="0 0 100 100"')) throw new Error("expected the master's 100-unit viewBox");
  return svg.slice(0, at) + WHOLE_VIEWBOX_MASK + svg.slice(at + MASK.length);
}

/** Render every template the app uses into `outDir`. */
export function renderTemplates(outDir, { resvg = "resvg" } = {}) {
  if (MACOS_TEMPLATES_FROM !== "rendered") throw new Error("icons.mjs copies the kit's own templates; there is nothing to render");
  const version = execFileSync(resvg, ["--version"], { encoding: "utf8" }).trim();
  if (version !== RESVG_VERSION) {
    throw new Error(`resvg ${version}: the committed templates were rendered and checked with ${RESVG_VERSION}`);
  }
  const work = mkdtempSync(join(tmpdir(), "ccdeck-templates-"));
  try {
    mkdirSync(outDir, { recursive: true });
    for (const [art, stem] of Object.entries(MACOS_TEMPLATE_STEMS)) {
      const master = readFileSync(join(BRAND, "kit", "04-tray-menu", "generic", "svg", `ccdeck-tray-${art}.svg`), "utf8");
      const copy = join(work, `ccdeck-tray-${art}.svg`);
      writeFileSync(copy, withWholeMaskRegion(master));
      for (const [suffix, size] of Object.entries(MACOS_TEMPLATE_SIZES)) {
        // No text in the masters, so no fonts: nothing on the machine can
        // change what is drawn.
        execFileSync(resvg, ["--skip-system-fonts", "-w", String(size), "-h", String(size), copy, join(outDir, `${stem}${suffix}.png`)]);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(BRAND, "rendered", "macos");
  renderTemplates(out);
  writeTable();
  console.log(`templates rendered to ${out}, desktop/brand/README.md's file table rewritten`);
}
