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
  await page.locator(".ah-workspace").evaluateAll((nodes) =>
    nodes.forEach((el) => {
      el.scrollTop = 0;
    }),
  );
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
  await page
    .getByRole("heading", { name: "7-day window", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "7-day window", exact: true })
      .getAttribute("aria-pressed"),
    "true",
    "History must default to the weekly window",
  );
  await shot("default-weekly");
  await page
    .getByRole("button", { name: "5-hour window", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "5-hour window", exact: true })
    .waitFor();
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
      .locator('g[data-account="a"] .ah-line')
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
  const zoomedY = await page
    .locator(".ah-chart:visible svg text")
    .allTextContents();
  assert.notDeepEqual(
    zoomedY.slice(0, 3),
    ["0%", "50%", "100%"],
    "Zoom must also change the usage axis",
  );
  const priorY = zoomedY.slice(0, 3).join("|");
  assert.ok(
    (
      await page.locator(".ah-chart:visible svg").getAttribute("aria-label")
    ).includes("Top is 75 percent used; bottom is 25 percent used"),
    "Accessible description must follow the zoomed usage bounds",
  );
  await page.keyboard.press("ArrowUp");
  assert.notEqual(
    (await page.locator(".ah-chart:visible svg text").allTextContents())
      .slice(0, 3)
      .join("|"),
    priorY,
    "Keyboard must pan usage axis",
  );
  await page.keyboard.press("ArrowDown");
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
  const beforeDragY = (
    await page.locator(".ah-chart:visible svg text").allTextContents()
  )
    .slice(0, 3)
    .join("|");
  await page.mouse.down();
  await page.mouse.move(
    wheelPlot.x + wheelPlot.width * 0.5 + 60,
    wheelPlot.y + 120,
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
  assert.notEqual(
    (await page.locator(".ah-chart:visible svg text").allTextContents())
      .slice(0, 3)
      .join("|"),
    beforeDragY,
    "Mouse drag must pan the usage axis too",
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
    486,
  );
  assert.ok(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.getBoundingClientRect().width > 1100),
    "History modal should give the chart more horizontal space",
  );
  const hit = page.locator('g[data-account="a"] .ah-line-hit').first();
  const hitPoint = await hit.evaluate((el) => {
    const p = el.getPointAtLength(el.getTotalLength() * 0.47);
    const screen = new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.move(hitPoint.x, hitPoint.y);
  await page.getByRole("tooltip").waitFor();
  assert.equal(
    await page
      .locator(".ah-chart:visible svg")
      .evaluate((el) => getComputedStyle(el).cursor),
    "pointer",
    "A visible hover reading must make the plot cursor a pointer",
  );
  assert.ok(
    (await page.getByRole("tooltip").textContent()).includes(
      "Primary example account",
    ),
  );
  assert.ok(
    (await page.getByRole("tooltip").textContent()).includes("Observed"),
  );
  await shot("hover");
  await page.mouse.move(5, 5);
  await page.getByRole("button", { name: "7-day window", exact: true }).click();
  assert.equal(await page.locator(".ah-chart:visible").count(), 1);
  await page
    .getByRole("heading", { name: "7-day window", exact: true })
    .waitFor();
  await shot("weekly");
  await page
    .getByRole("button", { name: "5-hour window", exact: true })
    .click();
  await page.locator(".ah-inspector").first().locator("summary").click();
  await page.locator(".ah-chart:visible svg").focus();
  await page.keyboard.press("+");
  await page
    .getByLabel("Inspect 5-hour observation", { exact: true })
    .selectOption(`a:${state.accounts[0].points[21].t}`);
  assert.equal(
    (await page.locator(".ah-chart:visible svg text").allTextContents())[0],
    "0%",
    "Choosing an observation outside the zoomed usage range must bring it into view",
  );
  const selectedMarker = page.locator(
    ".ah-chart:visible [data-tracked-observation] circle",
  );
  assert.ok(
    Number(await selectedMarker.getAttribute("cy")) <= 456,
    "Selected observation marker must remain inside the plot",
  );
  await page.locator(".ah-chart:visible svg").focus();
  await page.keyboard.press("0");
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
  const inspector = page.getByLabel("Inspect 5-hour observation", {
    exact: true,
  });
  await inspector.focus();
  await page.keyboard.press("ArrowUp");
  const keyboardReading = await inspector.inputValue();
  assert.equal(
    await page
      .locator(".ah-chart")
      .first()
      .locator("[data-tracked-observation]")
      .getAttribute("data-tracked-observation"),
    keyboardReading,
    "Keyboard inspection must track the selected observation on the plot",
  );
  await shot("keyboard-inspection");
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
  await page.getByText("100% used", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".ah-chart svg circle").first().getAttribute("cy"),
    "20",
    "An exhausted account must be at the top",
  );
  assert.deepEqual(
    await page
      .locator(".ah-chart svg")
      .first()
      .locator("text")
      .allTextContents()
      .then((labels) => labels.slice(0, 3)),
    ["0%", "50%", "100%"],
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
  await page.locator(".ah-chart svg").first().scrollIntoViewIfNeeded();
  const touchBox = await page.locator(".ah-chart svg").first().boundingBox();
  const touchSession = await page.context().newCDPSession(page);
  await touchSession.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
  });
  const tx = touchBox.x + touchBox.width * 0.5,
    ty = touchBox.y + 150;
  const touchTap = async () => {
    await touchSession.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: tx, y: ty }],
    });
    await touchSession.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  };
  await touchTap();
  await touchTap();
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator(".ah-plot-zoomed").count(),
    2,
    "Touch double-tap must initiate shared zoom",
  );
  const touchRange = await viewLabel.textContent();
  const touchY = (
    await page.locator(".ah-chart:visible svg text").allTextContents()
  )
    .slice(0, 3)
    .join("|");
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: tx, y: ty }],
  });
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: tx + 60, y: ty + 40 }],
  });
  await touchSession.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  assert.notEqual(
    await viewLabel.textContent(),
    touchRange,
    "Touch drag must pan after zoom",
  );
  assert.notEqual(
    (await page.locator(".ah-chart:visible svg text").allTextContents())
      .slice(0, 3)
      .join("|"),
    touchY,
    "Native vertical touch movement must pan usage as well",
  );
  await touchTap();
  await touchTap();
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator(".ah-plot-zoomed").count(),
    0,
    "Touch double-tap must reset zoom",
  );
  await touchSession.send("Emulation.setTouchEmulationEnabled", {
    enabled: false,
  });
  await touchSession.detach();
  await page.getByLabel("Account", { exact: true }).selectOption("");
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
    assert.equal(
      await page.locator(".ah-window-switch > span").isVisible(),
      true,
      "Usage semantics must remain visible in narrow all-account mode",
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel("Account", { exact: true }).selectOption("a");
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
  const originalAccounts = state.accounts;
  state.accounts = [
    ...originalAccounts,
    ...Array.from({ length: 10 }, (_, i) => ({
      ...originalAccounts[0],
      id: `comparison-${i}`,
      name: `Account ${i + 3} · sample@example.test`,
      points: originalAccounts[0].points.map((p) => ({
        ...p,
        five_hour: p.five_hour
          ? {
              ...p.five_hour,
              pct: Math.min(100, (p.five_hour.pct + i * 7) % 101),
            }
          : null,
      })),
    })),
  ];
  await page.locator("#launch").click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("button", { name: "5-hour window", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "5-hour window", exact: true })
    .waitFor();
  assert.equal(await page.locator(".ah-legend-account").count(), 12);
  assert.equal(await page.locator(".ah-chart:visible").count(), 1);
  await shot("many-accounts");
  if (process.env.CCDECK_HISTORY_PROFILE) {
    await page.evaluate(() => {
      window.__historyProfile.length = 0;
    });
    const targets = await page
      .locator('g[data-account="a"] .ah-line')
      .first()
      .evaluate((el) =>
        Array.from({ length: 60 }, (_, i) => {
          const point = el.getPointAtLength(
            el.getTotalLength() * (0.2 + (i * 0.6) / 59),
          );
          const position = new DOMPoint(point.x, point.y).matrixTransform(
            el.getScreenCTM(),
          );
          return { x: position.x, y: position.y };
        }),
      );
    for (const target of targets) await page.mouse.move(target.x, target.y);
    await page.waitForTimeout(100);
    const profile = await page.evaluate(() => {
      const values = [...window.__historyProfile].sort((a, b) => a - b);
      return {
        commits: values.length,
        totalRenderMs: Math.round(values.reduce((a, b) => a + b, 0)),
        p95RenderMs: Number(
          (values[Math.floor(values.length * 0.95)] ?? 0).toFixed(2),
        ),
      };
    });
    console.log(
      `History hover profile (60 pointer moves, 12 accounts): ${JSON.stringify(profile)}`,
    );
    await page.mouse.move(5, 5);
    await page.locator(".ah-chart:visible svg").focus();
    await page.keyboard.press("+");
    const panBox = await page.locator(".ah-chart:visible svg").boundingBox();
    await page.mouse.move(
      panBox.x + panBox.width * 0.5,
      panBox.y + panBox.height * 0.5,
    );
    await page.evaluate(() => {
      window.__historyProfile.length = 0;
    });
    await page.mouse.down();
    await page.mouse.move(
      panBox.x + panBox.width * 0.5 + 80,
      panBox.y + panBox.height * 0.5 + 60,
      { steps: 30 },
    );
    await page.mouse.up();
    const panProfile = await page.evaluate(() => {
      const values = [...window.__historyProfile].sort((a, b) => a - b);
      return {
        commits: values.length,
        totalRenderMs: Math.round(values.reduce((a, b) => a + b, 0)),
        p95RenderMs: Number(
          (values[Math.floor(values.length * 0.95)] ?? 0).toFixed(2),
        ),
      };
    });
    console.log(
      `History pan profile (30 pointer moves, 12 accounts): ${JSON.stringify(panProfile)}`,
    );
    await page.locator(".ah-chart:visible svg").focus();
    await page.keyboard.press("0");
  }
  await page.locator(".ah-workspace").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.screenshot({ path: `${out}/bottom.png` });
  await page.keyboard.press("Escape");
  state.accounts = [
    {
      ...originalAccounts[1],
      name: `${"long-account-identifier-".repeat(7)}@example.test`,
      points: originalAccounts[1].points.map((p) => ({
        ...p,
        five_hour: { ...p.five_hour, pct: 0 },
      })),
    },
  ];
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator("#launch").click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page
    .getByRole("button", { name: "5-hour window", exact: true })
    .click();
  const bottomPoint = page.locator(".ah-chart:visible .ah-dot").first();
  await bottomPoint.scrollIntoViewIfNeeded();
  const bottomBox = await bottomPoint.boundingBox();
  await page.mouse.move(
    bottomBox.x + bottomBox.width / 2,
    bottomBox.y + bottomBox.height / 2,
  );
  await page.getByRole("tooltip").waitFor();
  await page.screenshot({ path: `${out}/long-tooltip.png` });
  const tooltipBounds = await page.getByRole("tooltip").evaluate((el) => {
    const rect = el.getBoundingClientRect(),
      plot = el.closest(".ah-plot-wrap").getBoundingClientRect();
    return {
      inside:
        rect.top >= plot.top &&
        rect.bottom <= plot.bottom &&
        rect.left >= plot.left &&
        rect.right <= plot.right,
      height: rect.height,
      plotHeight: plot.height,
    };
  });
  assert.ok(
    tooltipBounds.inside,
    `Long-identifier tooltip must fit the plot: ${JSON.stringify(tooltipBounds)}`,
  );
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 900 });
  state.accounts = originalAccounts;
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
    "PASS History studio: window switching, instant tooltip, keyboard point tracking, wheel/drag/double-click, touch zoom/pan/reset, 12-account comparison, partial/empty/error states, responsive bounds, Escape/focus restore and settings; no page errors.",
  );
} finally {
  await browser.close();
}
