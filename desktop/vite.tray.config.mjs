// Bundles the page's own board logic (src/web/tray-model.ts and everything it
// imports) into one ES module the app's main process can run, so the tray icon
// counts with exactly the code the page counts with (#1160). Uses the repo's
// vite, from the root node_modules.
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  logLevel: "warn",
  build: {
    lib: {
      // The tray's board, and the page's tones rendered for notifications.
      entry: {
        "tray-model": fileURLToPath(new URL("../src/web/tray-model.ts", import.meta.url)),
        "chime-wav": fileURLToPath(new URL("../src/web/chime-wav.ts", import.meta.url)),
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.mjs`,
    },
    outDir: fileURLToPath(new URL("./dist/lib", import.meta.url)),
    emptyOutDir: true,
    target: "node20",
    minify: false,
    sourcemap: false,
  },
});
