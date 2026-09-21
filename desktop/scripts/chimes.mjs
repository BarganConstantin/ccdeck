// Write the deck's two tones as WAV files the app plays with its
// notifications (#1160). The rendering is the page's own synthesis
// (src/web/chime-wav.ts), bundled into dist/lib by vite.tray.config.mjs.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { renderChime, wavFile, CHIME_FILES } = await import(pathToFileURL(join(here, "..", "dist", "lib", "chime-wav.mjs")).href);
const out = join(here, "..", "dist", "sounds");
mkdirSync(out, { recursive: true });
for (const [chime, file] of Object.entries(CHIME_FILES)) {
  writeFileSync(join(out, file), wavFile(renderChime(chime)));
}
console.log(`tones written to ${out}`);
