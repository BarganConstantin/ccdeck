// Runs actual React hooks/components through the existing Vite server.
// Playwright is supplied externally; no project dependency or live API calls.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const base = process.argv[2] || "http://localhost:5192";
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright module (or package name).");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Europe/Chisinau", reducedMotion: "reduce" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const output = process.env.CAPACITY_ARTIFACTS || "/tmp/ccdeck-capacity-audit-browser";
await mkdir(output, { recursive: true });
const now = 1_800_000_000;
const account = (num, over = {}) => ({ num, email: `sample-${num}@example.test`, alias: `Sample ${num}`, org: "Display", orgUuid: `org-${num}`, active: true, disabled: false, lanes: [{ id: "five_hour", label: "5h", pct: 100, resetAt: now + 30 }, { id: "seven_day", label: "7d", pct: 100, resetAt: now + 30 }], headroom: 0, fetchedAt: (now - 60) * 1000, nextAt: null, stale: false, error: null, ...over });
const requests = [];
const response = accounts => ({ ok: true, accounts });
const state = () => page.locator("#roster-state").evaluate(el => JSON.parse(el.textContent));
const waitRequest = async count => {
  const deadline = Date.now() + 5000;
  while (requests.length < count) { if (Date.now() > deadline) throw new Error("Expected fixture request did not arrive"); await new Promise(r => setTimeout(r, 10)); }
  return requests[count - 1];
};
const reload = async () => { const count = requests.length + 1; await page.evaluate(() => { void window.capacityLoad(true); }); return waitRequest(count); };
const read = async accounts => { const request = await reload(); await request.fulfill({ json: response(accounts) }); await page.waitForFunction(() => !JSON.parse(document.getElementById("roster-state").textContent).reloading); };
await page.route("**/api/claude-accounts*", r => { requests.push(r); });
await page.route("**/api/cswap-auto", r => r.fulfill({ json: { ok: true, enabled: false, external: false, lastTick: null, settings: {} } }));
await page.route("**/capacity-audit", r => r.fulfill({ contentType: "text/html", body: `<html data-theme="rider-black" data-color-scheme="dark"><head><link rel="stylesheet" href="/styles.css"><script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;</script></head><body><button id="unmount">Unmount fixture</button><div id="root"></div><script type="module" src="/__tests__/fixtures/capacity-reliability-browser.tsx"></script></body></html>` }));
try {
  await page.clock.install({ time: now * 1000 });
  await page.clock.pauseAt(now * 1000);
  await page.goto(`${base}/capacity-audit`);
  await page.waitForFunction(() => window.capacityLoad != null);
  const initial = await waitRequest(1);
  const newer = await reload();
  await newer.fulfill({ json: response([account(2)]) });
  await page.waitForFunction(() => JSON.parse(document.getElementById("roster-state").textContent).data?.accounts?.[0]?.num === 2);
  await initial.fulfill({ json: response([account(1)]) });
  await new Promise(r => setTimeout(r, 100));
  assert.equal((await state()).data.accounts[0].num, 2, "older response overwrote newer active account");
  console.log("PASS out-of-order roster publication");

  await page.getByRole("button", { name: "Open account capacity", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert.match(await page.locator('.ap-report-table tr[data-active] .ap-report-name').innerText(), /Sample 2/);
  await page.getByRole("button", { name: "Reset calendar", exact: true }).click();
  assert.equal(await page.locator(".ap-reset-scheduled .ap-reset-entry").count(), 1);
  await page.screenshot({ path: `${output}/reported-future.png` });
  await page.keyboard.press("Tab");
  await page.locator(".ap-reset-scheduled summary").focus();
  await page.evaluate(at => window.capacityClock(at), now + 31);
  await page.waitForFunction(() => document.activeElement?.matches('.ap-reset-coverage-link[aria-pressed="true"]'));
  assert.equal(await page.locator(".ap-reset-scheduled .ap-reset-entry").count(), 0);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  assert.match(await page.locator(".ap-report-state").innerText(), /Exhausted/i);
  assert.equal(await page.locator(".ap-report-cell .ap-report-pct").allTextContents().then(x => x.filter(t => t.trim() === "100%").length), 2);
  console.log("PASS elapsed reset retains exhausted observed usage and restores focus");

  await page.evaluate(at => window.capacityClock(at), now);
  await read([account(2, { active: false }), account(3)]);
  await page.waitForFunction(() => document.querySelector('.ap-report-table tr[data-active] .ap-report-name')?.textContent === "Sample 3");
  await page.getByRole("button", { name: "Reset calendar", exact: true }).click();
  assert.equal(await page.locator(".ap-reset-scheduled .ap-reset-entry").count(), 2);
  const total = await page.locator('.ap-reset-coverage-link[data-scope="upcoming"] b').innerText();
  assert.equal(total, "2");
  assert.equal(await page.locator(".ap-reset-day-button .ap-reset-count b").allTextContents().then(x => x.reduce((n, t) => n + (Number(t) || 0), 0)), 2);
  await page.evaluate(at => window.capacityClock(at), now + 16 * 60);
  // Use future reset times for the freshness case, independently of expiry.
  await read([account(2, { active: false, lanes: [{ id: "seven_day", label: "7d", pct: 69, resetAt: now + 3600 }] }), account(3, { lanes: [{ id: "seven_day", label: "7d", pct: 70, resetAt: now + 3600 }] })]);
  await page.waitForFunction(() => document.querySelector('.ap-reset-coverage-link[data-scope="older"] b')?.textContent === "2");
  await page.getByRole("button", { name: /2 Needs fresh data/ }).click();
  assert.equal(await page.locator(".ap-reset-disclosure summary").count(), 2);
  await read([account(3, { fetchedAt: (now + 16 * 60) * 1000, lanes: [{ id: "seven_day", label: "7d", pct: 1, resetAt: now + 3600 }] })]);
  await page.getByRole("button", { name: /1 Upcoming/ }).click();
  assert.equal(await page.locator(".ap-reset-scheduled .ap-reset-entry").count(), 1);
  console.log("PASS current identity, freshness transition/recovery, counts and account removal");

  for (const status of [401, 403, 429, 500]) {
    const r = await reload(); await r.fulfill({ status, json: { ok: false } });
    await page.waitForFunction(() => !JSON.parse(document.getElementById("roster-state").textContent).reloading);
    assert.equal((await state()).data.accounts[0].num, 3);
    assert.ok((await state()).failure);
    assert.match(await page.locator(".ap-report-held").innerText(), /last readings/i);
  }
  const invalid = await reload(); await invalid.fulfill({ json: { ok: true, accounts: {} } });
  await page.waitForFunction(() => !JSON.parse(document.getElementById("roster-state").textContent).reloading);
  assert.equal((await state()).data.accounts[0].num, 3);
  assert.match((await state()).failure, /unreadable account data/);
  const brokenJson = await reload(); await brokenJson.fulfill({ contentType: "application/json", body: "{" });
  await page.waitForFunction(() => !JSON.parse(document.getElementById("roster-state").textContent).reloading);
  assert.equal((await state()).data.accounts[0].num, 3);
  await read([account(3, { fetchedAt: (now + 16 * 60) * 1000, lanes: [{ id: "seven_day", label: "7d", pct: 0, resetAt: now + 3600 }] })]);
  assert.equal((await state()).failure, null);
  await page.screenshot({ path: `${output}/recovered.png` });
  console.log("PASS HTTP failures, invalid JSON/schema, last-reading retention and recovery");

  const offline = await reload(); await offline.abort("internetdisconnected");
  await page.waitForFunction(() => !JSON.parse(document.getElementById("roster-state").textContent).reloading);
  assert.equal((await state()).data.accounts[0].num, 3);
  const slow = await reload();
  await page.clock.runFor(30_001);
  await page.waitForFunction(() => !JSON.parse(document.getElementById("roster-state").textContent).reloading);
  assert.ok((await state()).failure);
  assert.equal((await state()).data.accounts[0].num, 3);
  await slow.fulfill({ json: response([account(9)]) }).catch(() => {});
  await read([account(3, { fetchedAt: (now + 16 * 60) * 1000, lanes: [{ id: "seven_day", label: "7d", pct: 1, resetAt: now + 3600 }] })]);
  console.log("PASS offline and deadline recovery without replacing last observations");

  await page.getByRole("button", { name: /1 Upcoming/ }).click();
  await page.locator(".ap-reset-day-button").last().click();
  assert.equal(await page.locator(".ap-reset-scheduled .ap-reset-entry").count(), 0);
  await read([account(3, { fetchedAt: (now + 16 * 60) * 1000, lanes: [{ id: "seven_day", label: "7d", pct: 70, resetAt: now + 3600 }] })]);
  assert.equal(await page.locator('.ap-reset-day-button[aria-pressed="true"]').count(), 1, "poll lost the selected empty day");
  await page.getByRole("button", { name: "All days", exact: true }).click();
  await read([account(3, { alias: `Long account ${"identifier-".repeat(12)}end`, fetchedAt: (now + 16 * 60) * 1000, lanes: [{ id: "seven_day", label: "7d", pct: 70, resetAt: now + 3600 }] })]);
  await page.locator(".ap-reset-scheduled summary").click();
  assert.equal(await page.locator(".ap-reset-account[open]").count(), 1);
  for (const viewport of [{ width: 390, height: 650 }, { width: 900, height: 480 }]) {
    await page.setViewportSize(viewport);
    assert.equal(await page.getByRole("dialog").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.getByText("How to read this schedule", { exact: true }).scrollIntoViewIfNeeded();
    const bottom = await page.getByText("How to read this schedule", { exact: true }).boundingBox();
    const dialog = await page.getByRole("dialog").boundingBox();
    assert.ok(bottom && dialog && bottom.y >= dialog.y && bottom.y + bottom.height <= dialog.y + dialog.height, "bottom content is inaccessible");
    await page.screenshot({ path: `${output}/viewport-${viewport.width}x${viewport.height}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator(".ap-reset-body").evaluate(el => { el.scrollTop = 0; });
  console.log("PASS selected empty day persistence, account expansion, narrow and short modal geometry");
  console.log("TIMEZONE runtime", await page.evaluate(() => ({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    transition: ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"].map(s => new Date(s).toLocaleString(undefined, { timeZoneName: "shortOffset" })) })));

  await read([]);
  await page.waitForFunction(() => document.querySelectorAll('.ap-reset-scheduled .ap-reset-entry').length === 0);
  assert.equal(await page.locator('.ap-reset-coverage-link[data-scope="upcoming"] b').innerText(), "0", "removed last account remains as a ghost schedule");
  assert.equal(await page.locator(".ap-reset-coverage-link b").allTextContents().then(x => x.reduce((n, t) => n + Number(t), 0)), 0, "authoritative empty roster retains a removed account in another category");
  console.log("PASS authoritative empty roster clears removed accounts");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "Open account capacity", exact: true }).evaluate(el => el === document.activeElement), true);
  const pending = await reload();
  const before = requests.length;
  await page.clock.runFor(15_000);
  assert.equal(requests.length, before, "poll overlaps an unfinished roster read");
  await page.getByRole("button", { name: "Unmount fixture", exact: true }).click();
  await page.clock.runFor(60_000);
  assert.equal(requests.length, before, "unmounted panel keeps polling");
  await pending.fulfill({ json: response([account(4)]) }).catch(() => {});
  assert.deepEqual(errors, []);
  console.log("PASS pending-read deduplication, unmount cancellation and timer cleanup");
} finally { await browser.close(); }
