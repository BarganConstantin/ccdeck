// Measure Settings mount/unmount retention in an isolated browser. Every API
// request is synthetic; no account action, preference or report reaches the deck.
import { pathToFileURL } from "node:url";

const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright installation.");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const origin = process.argv[2] || "http://127.0.0.1:4317";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
  await context.addInitScript(() => localStorage.setItem("agent-dag.tourSeen", "1"));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) errors.push(message.text());
  });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(origin).origin) return route.abort();
    if (url.pathname === "/events") return route.fulfill({ contentType: "text/event-stream", body: "event: replay-end\ndata: {}\n\n" });
    if (url.pathname === "/api/claude-accounts") return route.fulfill({ json: { ok: true, accounts: [] } });
    if (url.pathname === "/api/cswap-auto") return route.fulfill({ json: { ok: true, enabled: false, external: false, lastTick: null, settings: {} } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 503, json: { ok: false, error: "Synthetic memory test: unavailable" } });
    return route.continue();
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "Settings", exact: true }).first().waitFor();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  async function measure() {
    await cdp.send("HeapProfiler.collectGarbage");
    const raw = await cdp.send("Performance.getMetrics");
    const metrics = Object.fromEntries(raw.metrics.map(entry => [entry.name, entry.value]));
    return {
      heapMB: Math.round(metrics.JSHeapUsedSize / 1048576 * 10) / 10,
      nodes: metrics.Nodes,
      listeners: metrics.JSEventListeners,
      documents: metrics.Documents,
    };
  }
  async function cycle(count) {
    for (let i = 0; i < count; i++) {
      await page.getByRole("button", { name: "Settings", exact: true }).first().click();
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
  }
  await cycle(5);
  const warm = await measure();
  await cycle(30);
  const after30 = await measure();
  await cycle(30);
  const after60 = await measure();
  console.log(JSON.stringify({ warm, after30, after60, pageErrors: errors }));
  if (errors.length) throw new Error("Unexpected UI errors during memory measurement");
} finally {
  await browser.close();
}
