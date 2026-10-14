// Uses an existing external Playwright installation; no project dependency.
// Captures only the Settings dialog so connected-account identifiers stay private.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright module.");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const base = process.argv[2] || "http://127.0.0.1:4590";
const output = process.env.READING_ARTIFACTS || ".impeccable/review/text-density";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
await context.addInitScript(() => localStorage.setItem("agent-dag.tourSeen", "1"));
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const open = async () => {
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.getByRole("tab", { name: "Text & density" }).click();
};
const choose = (name, value) => page.locator(`input[name="${name}"][value="${value}"]`).check();
const sample = () => page.evaluate(() => {
  const style = el => getComputedStyle(el);
  const preview = document.querySelector(".reading-preview-row");
  return { size: style(document.body).fontSize, padding: style(preview).paddingTop,
    resetHeight: document.querySelector(".reading-footer button").getBoundingClientRect().height,
    overflow: document.documentElement.scrollWidth > innerWidth,
    zoom: style(document.body).zoom,
    textSize: document.documentElement.dataset.textSize,
    density: document.documentElement.dataset.density };
});
try {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).first().waitFor();
  await open();
  assert.equal(await page.getByRole("radio", { name: /Default Original size/ }).isChecked(), true);
  const baseline = await sample();
  assert.equal(baseline.size, "13px");
  assert.equal(baseline.padding, "10px");
  assert.equal(await page.getByRole("button", { name: "Reset to defaults" }).isDisabled(), true);
  await page.getByRole("dialog").screenshot({ path: `${output}/default-desktop.png` });
  // Native radio keyboard interaction moves the selection, not the canvas.
  await page.locator('input[name="text-size"][value="default"]').focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.documentElement.dataset.textSize === "larger");
  assert.equal((await sample()).size, "15px");
  await choose("text-size", "largest");
  await choose("density", "compact");
  const compact = await sample();
  assert.equal(compact.size, "17px");
  assert.equal(compact.padding, "8px");
  assert.ok(compact.resetHeight >= 38);
  assert.equal(compact.zoom, baseline.zoom);
  await choose("density", "comfortable");
  assert.equal((await sample()).padding, "14px");
  await page.getByRole("dialog").screenshot({ path: `${output}/largest-comfortable-desktop.png` });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.dataset.textSize === "largest");
  assert.equal((await page.evaluate(() => document.documentElement.dataset.density)), "comfortable");
  await open();
  assert.equal(await page.locator('input[name="density"][value="comfortable"]').isChecked(), true);
  // A second tab changes this tab through the actual storage event listener.
  const other = await context.newPage();
  await other.goto(base, { waitUntil: "domcontentloaded" });
  await other.getByRole("button", { name: "Settings", exact: true }).first().waitFor();
  await other.evaluate(() => localStorage.setItem("agent-dag.density", "compact"));
  await page.waitForFunction(() => document.documentElement.dataset.density === "compact");
  await other.close();
  for (const [name, width, height] of [["narrow", 320, 640], ["mobile", 390, 844], ["short", 1024, 500]]) {
    await page.setViewportSize({ width, height });
    assert.equal((await sample()).overflow, false, `${name}: horizontal document overflow`);
    const pane = page.locator(".settings-pane");
    await pane.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.getByRole("button", { name: "Reset to defaults" }).scrollIntoViewIfNeeded();
    assert.ok(await page.getByRole("button", { name: "Reset to defaults" }).isVisible());
    await pane.evaluate(el => { el.scrollTop = 0; });
    await page.getByRole("dialog").screenshot({ path: `${output}/${name}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("tab", { name: "General", exact: true }).click();
  await page.getByRole("radio", { name: /White Contrast/ }).check().catch(async () => {
    await page.getByRole("radio", { name: /White Contrast/ }).click();
  });
  await page.getByRole("tab", { name: "Text & density" }).click();
  await page.getByRole("dialog").screenshot({ path: `${output}/light-largest.png` });
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  assert.equal((await sample()).size, baseline.size);
  assert.equal((await sample()).padding, baseline.padding);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.match(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent || ""), /Settings/);
  const blocked = await browser.newContext();
  await blocked.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } }));
  const denied = await blocked.newPage();
  await denied.goto(base, { waitUntil: "domcontentloaded" });
  await denied.getByRole("button", { name: "Settings", exact: true }).first().waitFor();
  if (await denied.getByRole("dialog").count()) await denied.keyboard.press("Escape");
  await denied.getByRole("button", { name: "Settings", exact: true }).first().click();
  await denied.getByRole("tab", { name: "Text & density" }).click();
  await denied.locator('input[name="text-size"][value="larger"]').check();
  await denied.waitForFunction(() => document.documentElement.dataset.textSize === "larger");
  await blocked.close();
  assert.deepEqual(errors, []);
  console.log("PASS default geometry, independent text/density, native keyboard radios, reload, cross-tab sync, reset, Escape/focus restoration, blocked storage, narrow/short/light rendering");
} finally { await browser.close(); }
