// Exercise actual Jira/GitLab rendering in isolated Chromium pages. Defaults
// to issue details; optional surfaces: jira-board, forge-list, job-log.
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
  const kinds = process.argv.slice(2);
  for (const kind of kinds.length ? kinds : ["jira", "gitlab"]) {
    if (!["jira", "gitlab", "jira-board", "forge-list", "job-log"].includes(kind)) throw new Error(`Unknown surface: ${kind}`);
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
      if (kind === "jira-board") {
        await page.locator(`[data-key="MOCK-${id * 1000}"]`).waitFor();
        await page.waitForFunction(() => document.querySelectorAll(".jr-row-main").length === 1000);
      } else if (kind === "forge-list") {
        await page.getByText(`Synthetic issue ${id * 1000}`, { exact: true }).waitFor();
        const more = page.locator("button.fg-more");
        if (await more.count()) await more.click();
        await page.waitForFunction(() => document.querySelectorAll("button.fg-row").length === 500);
      } else if (kind === "job-log") {
        await page.getByRole("button", { name: "Show log", exact: true }).click();
        for (const lines of [80, 200, 500]) {
          await page.waitForFunction(count => document.querySelectorAll(".fd-log-line").length === count, lines);
          if (lines < 500) await page.getByRole("button", { name: "Show more lines", exact: true }).click();
        }
      } else {
        await page.getByRole("heading", { name: `Synthetic issue ${id}`, exact: true }).waitFor();
        if (!await page.evaluate(() => document.getElementById("root").textContent.length >= 65536)) {
          throw new Error("The full synthetic description was not rendered");
        }
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
    const perRound = kind === "jira-board" ? 30 : kind === "forge-list" ? 110 : kind === "job-log" ? 80 : 240;
    // Each round exceeds the relevant existing cache capacity.
    // The cache remains alive between rounds, while the component unmounts.
    for (let round = 0; round < 3; round++) {
      for (let n = 1; n <= perRound; n++) {
        await show(round * perRound + n);
        if (n % 20 === 0) await close();
      }
      await close();
      rounds.push(await measure());
    }
    const beforeReopen = await page.evaluate(() => window.trackerMemory.requests());
    await show(perRound * 3);
    const afterReopen = await page.evaluate(() => window.trackerMemory.requests());
    if (beforeReopen !== afterReopen) throw new Error("Fresh cached data was lost on close/reopen");
    await close();
    console.log(JSON.stringify({ kind, visits: perRound * 3, warm, rounds, cachedReopen: true, errors }));
    await context.close();
  }
} finally {
  await browser.close();
}
