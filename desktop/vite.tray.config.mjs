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
      entry: fileURLToPath(new URL("../src/web/tray-model.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "tray-model.mjs",
    },
    outDir: fileURLToPath(new URL("./dist/lib", import.meta.url)),
    emptyOutDir: true,
    target: "node20",
    minify: false,
    sourcemap: false,
  },
});
