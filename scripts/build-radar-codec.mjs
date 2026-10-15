import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root, entryPoints: ["src/server/traffic-radar-codec-source.mjs"],
  outfile: "src/server/traffic-radar-codec.mjs", platform: "node", target: "node18",
  format: "esm", bundle: true, minify: true, legalComments: "inline",
  banner: { js: 'import { createRequire as radarRequire } from "node:module"; const require = radarRequire(import.meta.url);' },
});
