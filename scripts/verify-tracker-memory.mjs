// Exercise actual Jira/GitLab detail rendering in an isolated Chromium page.
// No server is needed. All network access is refused; API answers are synthetic.
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("./fixtures/tracker-memory.tsx", import.meta.url))],
  bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}),
});
try {
  for (const kind of ["jira", "gitlab"]) {
    const context = await browser.newContext();
    await context.route("**/*", route => route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setContent('<main class="ig-detail" id="root"></main>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    async function show(id) {
      await page.evaluate(({ kind, id }) => window.trackerMemory.show(kind, id), { kind, id });
      await page.getByRole("heading", { name: `Synthetic issue ${id}`, exact: true }).waitFor();
      if (!await page.evaluate(() => document.getElementById("root").textContent.length >= 65536)) {
        throw new Error("The full synthetic description was not rendered");
      }
      if (errors.length) throw new Error(errors.join("\n"));
    }
    async function close() { await page.evaluate(() => window.trackerMemory.close()); }
    async function measure() {
      // Let pending focus/paint callbacks finish before collecting. Otherwise
      // a just-closed component can legitimately survive until the next frame.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await cdp.send("HeapProfiler.collectGarbage");
      const raw = await cdp.send("Performance.getMetrics");
      const m = Object.fromEntries(raw.metrics.map(entry => [entry.name, entry.value]));
      return { heapMiB: +(m.JSHeapUsedSize / 1048576).toFixed(2), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents };
    }
    await show(1); await close();
    const warm = await measure();
    const rounds = [];
    // Each round exceeds both existing cache capacities (60 Jira / 200 forge).
    // The cache remains alive between rounds, while the component unmounts.
    for (let round = 0; round < 3; round++) {
      for (let n = 1; n <= 240; n++) {
        await show(round * 240 + n);
        if (n % 20 === 0) await close();
      }
      await close();
      rounds.push(await measure());
    }
    const beforeReopen = await page.evaluate(() => window.trackerMemory.requests());
    await show(720);
    const afterReopen = await page.evaluate(() => window.trackerMemory.requests());
    if (beforeReopen !== afterReopen) throw new Error("Fresh detail was lost on close/reopen");
    await close();
    console.log(JSON.stringify({ kind, descriptionKiB: 64, details: 720, warm, rounds, cachedReopen: true, errors }));
    await context.close();
  }
} finally {
  await browser.close();
}
