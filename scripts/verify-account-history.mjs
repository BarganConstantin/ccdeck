// Optional browser verification: use an existing Playwright installation.
const { chromium } = await import(
  process.env.CCDECK_BROWSER_MODULE || "playwright"
);
import { mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const out = process.env.CCDECK_SCREENSHOT_DIR || ".impeccable/review/2104";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
    : {}),
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  timezoneId: "Europe/Chisinau",
  locale: "en-GB",
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const now = Date.now();
let state = {
  ok: true,
  enabled: true,
  retentionDays: 30,
  bytes: 123456,
  storageError: null,
  accounts: [
    {
      id: "a",
      name: "Primary example account",
      removed: false,
      points: Array.from({ length: 40 }, (_, i) => ({
        t: now - (40 - i) * 15 * 60000,
        savedAt: now - (40 - i) * 15 * 60000,
        five_hour: {
          pct: i < 20 ? i * 4 : (i - 20) * 3,
          resetAt: (now + (i < 20 ? 0 : 5 * 3600_000)) / 1000 + (i % 3) * 0.2,
        },
        seven_day: { pct: i * 2, resetAt: (now + 6 * 86400_000) / 1000 },
      })),
    },
    {
      id: "b",
      name: "a-very-long-former-account-identifier@illustrative-example.test",
      removed: true,
      points: [
        {
          t: now - 3600000,
          savedAt: now - 3600000,
          five_hour: { pct: 100, resetAt: null },
          seven_day: null,
        },
      ],
    },
  ],
};
state.accounts[0].points.unshift({
  t: now - 10 * 86400_000,
  savedAt: now - 10 * 86400_000,
  five_hour: { pct: 25, resetAt: (now - 9 * 86400_000) / 1000 },
  seven_day: null,
});
await page.route("**/history-review", (r) =>
  r.fulfill({
    contentType: "text/html",
    body: `<html data-theme="rider-black" data-color-scheme="dark"><head><link rel="stylesheet" href="/styles.css"><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><button id="launch">Open capacity</button><button id="settings">Open settings</button><div id="root"></div><script type="module" src="/__tests__/fixtures/account-history-browser.tsx"></script></body></html>`,
  }),
);
await page.route("**/api/accounts/history", (r) => r.fulfill({ json: state }));
await page.route("**/api/prefs", async (r) => {
  const p = r.request().postDataJSON();
  if ("usageSnapshots" in p) state.enabled = p.usageSnapshots;
  if ("snapshotRetentionDays" in p)
    state.retentionDays = p.snapshotRetentionDays;
  await r.fulfill({ json: { ok: true } });
});
await page.route("**/api/accounts/history/clear", async (r) => {
  assert.equal(r.request().postDataJSON().confirm, true);
  state.accounts = [];
  state.bytes = 0;
  await r.fulfill({ json: state });
});
const shot = async (name) => {
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}.png` });
};
try {
  await page.goto(
    `${process.env.CCDECK_REVIEW_ORIGIN || "http://127.0.0.1:4569"}/history-review`,
  );
  await page.locator("#launch").click();
  await shot("baseline-accounts");
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByText("5-hour window", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Account", { exact: true }).inputValue(),
    "",
  );
  assert.equal(await page.locator(".ah-legend-account").count(), 2);
  assert.equal(
    await page.locator(".ah-chart").first().locator("g[data-account]").count(),
    2,
  );
  const plottedFraction = await page
    .locator(".ah-chart svg")
    .first()
    .evaluate((svg) => {
      const xs = [...svg.querySelectorAll("circle")].map((c) =>
        Number(c.getAttribute("cx")),
      );
      return (
        (Math.max(...xs) - Math.min(...xs)) / (svg.viewBox.baseVal.width - 50)
      );
    });
  assert.ok(
    plottedFraction > 0.85,
    "Recent observations should fill the plot, not a tiny edge of a week",
  );
  await shot("desktop");
  assert.equal(
    await page
      .locator(".ah-chart")
      .first()
      .locator('g[data-account="a"] polyline')
      .count(),
    2,
    "Timestamp jitter must not break the two actual reset cycles",
  );
  assert.equal(
    await page
      .locator(".ah-line")
      .first()
      .evaluate((el) => getComputedStyle(el).strokeLinejoin),
    "round",
  );
  const viewLabel = page.locator('.ah-workspace p[role="status"]');
  const originalRange = await viewLabel.textContent();
  const browserZoomPreserved = await page
    .locator(".ah-chart svg")
    .first()
    .evaluate((svg) => {
      return ["ctrlKey", "metaKey", "altKey"].every((modifier) => {
        const event = new KeyboardEvent("keydown", {
          key: "+",
          [modifier]: true,
          bubbles: true,
          cancelable: true,
        });
        svg.dispatchEvent(event);
        return !event.defaultPrevented;
      });
    });
  assert.equal(
    browserZoomPreserved,
    true,
    "Modified keyboard shortcuts must remain available to the browser",
  );
  assert.equal(await viewLabel.textContent(), originalRange);
  await page.locator(".ah-chart svg").first().focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page
      .locator(".ah-chart svg")
      .first()
      .evaluate((el) => getComputedStyle(el).outlineStyle),
    "none",
    "Chart focus must not draw a rectangular frame",
  );
  assert.equal(
    await page
      .locator(".ah-chart h3")
      .first()
      .evaluate((el) => getComputedStyle(el).textDecorationLine),
    "underline",
    "Keyboard focus must remain visible on the chart heading",
  );
  await page.keyboard.press("+");
  assert.notEqual(await viewLabel.textContent(), originalRange);
  assert.equal(await page.locator(".ah-plot-zoomed").count(), 2);
  const axisLabels = await page.locator(".ah-chart svg").evaluateAll((svgs) =>
    svgs.map((svg) =>
      [...svg.querySelectorAll("text")]
        .slice(-2)
        .map((t) => t.textContent)
        .join("|"),
    ),
  );
  assert.equal(
    axisLabels[0],
    axisLabels[1],
    "Both charts must use the same zoomed axis",
  );
  await shot("zoomed");
  const beforePan = await viewLabel.textContent();
  await page.keyboard.press("ArrowRight");
  assert.notEqual(await viewLabel.textContent(), beforePan);
  await page.keyboard.press("ArrowLeft");
  const plot = await page.locator(".ah-chart svg").first().boundingBox();
  await page.mouse.move(plot.x + plot.width * 0.5, plot.y + 80);
  const beforeWheel = await viewLabel.textContent();
  await page.mouse.wheel(0, 50);
  await page.waitForTimeout(100);
  assert.notEqual(
    await viewLabel.textContent(),
    beforeWheel,
    "Ordinary wheel over the chart must zoom",
  );
  await page.locator(".ah-chart svg").first().scrollIntoViewIfNeeded();
  const wheelPlot = await page.locator(".ah-chart svg").first().boundingBox();
  await page.mouse.move(wheelPlot.x + wheelPlot.width * 0.5, wheelPlot.y + 80);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -100);
  await page.keyboard.up("Control");
  await page.waitForTimeout(100);
  assert.notEqual(
    await viewLabel.textContent(),
    beforeWheel,
    "Modified wheel must zoom the chart",
  );
  const beforeDrag = await viewLabel.textContent();
  await page.mouse.down();
  await page.mouse.move(
    wheelPlot.x + wheelPlot.width * 0.5 + 60,
    wheelPlot.y + 80,
    {
      steps: 5,
    },
  );
  await page.mouse.up();
  assert.notEqual(
    await viewLabel.textContent(),
    beforeDrag,
    "Dragging a zoomed chart must pan",
  );
  assert.equal(
    await page.evaluate(() => getSelection()?.toString()),
    "",
    "Chart dragging must not select axis text",
  );
  await page.locator(".ah-chart svg").first().dblclick();
  assert.equal(await viewLabel.textContent(), originalRange);
  assert.equal(await page.locator(".ah-plot-zoomed").count(), 0);
  await page.locator(".ah-chart svg").first().focus();
  await page.keyboard.press("+");
  await page.keyboard.press("0");
  assert.equal(await viewLabel.textContent(), originalRange);
  assert.equal(
    await page
      .locator(".ah-chart svg")
      .first()
      .evaluate((svg) => svg.getBoundingClientRect().height),
    290,
  );
  const hit = page.locator('g[data-account="a"] .ah-line-hit').first();
  assert.equal(
    await hit.locator("title").textContent(),
    "Primary example account",
  );
  const hitTarget = await hit.evaluate((el) => {
    const p = el.getPointAtLength(el.getTotalLength() * 0.47);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM());
    const target = document.elementFromPoint(screen.x, screen.y);
    return target?.querySelector("title")?.textContent;
  });
  assert.ok(
    hitTarget?.includes("Primary example account"),
    "Hovering a line must identify its account",
  );
  await page.locator(".ah-legend-account").first().click();
  assert.equal(
    await page.getByLabel("Account", { exact: true }).inputValue(),
    "a",
  );
  assert.equal(
    await page.locator(".ah-chart").first().locator("g[data-account]").count(),
    1,
  );
  await page.locator(".ah-legend-account").first().click();
  assert.equal(
    await page.getByLabel("Account", { exact: true }).inputValue(),
    "",
  );
  assert.equal(await page.locator(".ah-chart").count(), 2);
  await page
    .getByLabel("Inspect 5-hour observation", { exact: true })
    .selectOption(`a:${state.accounts[0].points[1].t}`);
  await page.getByLabel("Period", { exact: true }).selectOption("30");
  await page
    .getByLabel("Inspect 5-hour observation", { exact: true })
    .selectOption(`a:${state.accounts[0].points[0].t}`);
  await page.getByLabel("Period", { exact: true }).selectOption("7");
  assert.equal(
    await page
      .getByLabel("Inspect 5-hour observation", { exact: true })
      .inputValue(),
    `a:${state.accounts[0].points.at(-1).t}`,
  );
  await page.getByLabel("Account", { exact: true }).selectOption("b");
  await page.getByText("0% remaining", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".ah-chart svg circle").first().getAttribute("cy"),
    "260",
    "An exhausted account must be at the bottom",
  );
  assert.deepEqual(
    await page
      .locator(".ah-chart svg")
      .first()
      .locator("text")
      .allTextContents()
      .then((labels) => labels.slice(0, 3)),
    ["100%", "50%", "0%"],
  );
  const singlePointPosition = await page
    .locator(".ah-chart svg")
    .first()
    .evaluate((svg) => {
      return (
        (Number(svg.querySelector("circle").getAttribute("cx")) - 36) /
        (svg.viewBox.baseVal.width - 50)
      );
    });
  assert.ok(
    Math.abs(singlePointPosition - 0.5) < 0.001,
    "A single reading should be centered",
  );
  await page.getByText("Removed account", { exact: false }).count();
  await shot("removed-account");
  await page.getByLabel("Account", { exact: true }).selectOption("a");
  for (const [width, height, name] of [
    [390, 844, "mobile"],
    [320, 568, "narrow"],
    [1024, 500, "short"],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await shot(name);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "white-contrast";
    document.documentElement.dataset.colorScheme = "light";
  });
  await shot("light");
  const border = await page
    .getByLabel("Account", { exact: true })
    .evaluate((el) => getComputedStyle(el).borderTopColor);
  assert.ok(border && border !== "rgba(0, 0, 0, 0)");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "rider-black";
    document.documentElement.dataset.colorScheme = "dark";
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page
      .locator("#launch")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#settings").click();
  await page.getByRole("switch").waitFor();
  await page.getByRole("switch").click();
  await page.waitForFunction(
    () =>
      document.querySelector("[role=switch]")?.getAttribute("aria-checked") ===
      "false",
  );
  await page.getByLabel("Retention", { exact: true }).selectOption("90");
  await page.waitForFunction(
    () => document.querySelector("select")?.value === "90",
  );
  await page.getByLabel("Retention", { exact: true }).selectOption("30");
  await page.getByRole("button", { name: "Apply 30 days" }).click();
  await page
    .getByRole("button", { name: "Apply 30 days" })
    .waitFor({ state: "hidden" });
  await shot("settings");
  await page.getByRole("button", { name: "Clear history…" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(state.accounts.length, 2);
  await page.getByRole("button", { name: "Clear history…" }).click();
  await page.getByRole("button", { name: "Delete all history" }).click();
  await page.getByText("0 B", { exact: true }).waitFor();
  assert.equal(state.accounts.length, 0);
  await page.evaluate(() => window.openReport());
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByText("No readings in this period").waitFor();
  await shot("empty");
  await page.route("**/api/accounts/history", (r) =>
    r.fulfill({
      status: 503,
      json: { ok: false, error: "Controlled storage failure" },
    }),
  );
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.route("**/api/accounts/history", (r) =>
    r.fulfill({ json: state }),
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByText("No readings in this period").waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS real components: history, windows, account selection, removed/partial reading, narrow/short bounds, Escape/focus restore, pause, retention confirmation, clear/cancel, empty; no page errors.",
  );
} finally {
  await browser.close();
}
