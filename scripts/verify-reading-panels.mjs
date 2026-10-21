// Actual App with synthetic sessions/account; provider usage reads suppressed.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdir } from "node:fs/promises";
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath)
  throw new Error(
    "Set PLAYWRIGHT_MODULE to an existing Playwright installation.",
  );
const { chromium } = await import(
  modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath
);
const origin = process.argv[2] || "http://127.0.0.1:4590";
const output =
  process.env.READING_ARTIFACTS || ".impeccable/review/text-density";
await mkdir(output, { recursive: true });
const b = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE }
    : {}),
});
try {
  const c = await b.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await c.addInitScript(() => localStorage.setItem("agent-dag.tourSeen", "1"));
  const p = await c.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const now = Date.now();
  let seq = 0;
  const events = [];
  for (let i = 0; i < 4; i++)
    for (const payload of [
      { hook_event_name: "SessionStart", cwd: `/preview/project-${i}` },
      {
        hook_event_name: "UserPromptSubmit",
        prompt: `Synthetic interface preview ${i + 1}: check readable text and account row spacing.`,
      },
    ])
      events.push({
        seq: ++seq,
        epoch: "reading-preview",
        receivedAt: now,
        source: "hook",
        payload: {
          provider: "claude",
          session_id: `reading-visual-${i}`,
          ...payload,
        },
      });
  await p.route("**/events", (r) =>
    r.fulfill({
      contentType: "text/event-stream",
      body:
        events
          .map((e) => `event: hook\ndata: ${JSON.stringify(e)}\n\n`)
          .join("") + "event: replay-end\ndata: {}\n\n",
    }),
  );
  await p.route("**/api/claude-accounts*", (r) =>
    r.fulfill({
      json: {
        ok: true,
        accounts: [
          {
            num: 1,
            email: "preview-account@example.test",
            alias: "Preview account",
            active: true,
            disabled: false,
            lanes: [
              {
                id: "five_hour",
                label: "5h",
                pct: 25,
                resetAt: Math.floor(now / 1000) + 3600,
              },
              {
                id: "seven_day",
                label: "7d",
                pct: 60,
                resetAt: Math.floor(now / 1000) + 86400,
              },
            ],
            headroom: 40,
            fetchedAt: now,
            nextAt: null,
            stale: false,
            error: null,
          },
        ],
      },
    }),
  );
  await p.route("**/api/codex-quota*", (r) =>
    r.fulfill({ json: { ok: false, error: "No fixture reading" } }),
  );
  await p.route("**/api/quota*", (r) =>
    r.fulfill({ json: { ok: false, error: "No fixture quota" } }),
  );
  await p.route("**/api/ccusage*", (r) =>
    r.fulfill({ json: { ok: false, error: "No fixture usage" } }),
  );
  await p.route("**/api/codex-usage*", (r) =>
    r.fulfill({ json: { ok: false, error: "No fixture usage" } }),
  );
  await p.goto(origin, { waitUntil: "domcontentloaded" });
  await p.waitForFunction(
    () => document.querySelectorAll(".agent-node").length === 4,
  );
  await p.waitForTimeout(800);
  for (const size of ["default", "largest"]) {
    await p
      .getByRole("button", { name: "Settings", exact: true })
      .first()
      .click();
    await p.getByRole("tab", { name: "Text & density" }).click();
    await p.locator(`input[name="text-size"][value="${size}"]`).check();
    await p.locator('input[name="density"][value="comfortable"]').check();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(450);
    const cards = await p.locator(".agent-node").evaluateAll((xs) =>
      xs.map((el) => ({
        font: parseFloat(getComputedStyle(el).fontSize),
        height: el.getBoundingClientRect().height,
        scroll: el.scrollHeight,
        client: el.clientHeight,
      })),
    );
    assert.ok(cards.every((x) => x.font === (size === "default" ? 12 : 16)));
    assert.ok(
      cards.every((x) => x.scroll <= x.client + 2),
      `clipped card ${size}`,
    );
    await p
      .locator(".canvas-wrap")
      .screenshot({ path: `${output}/canvas-${size}.png` });
    await p
      .locator(".accounts-panel")
      .screenshot({ path: `${output}/accounts-${size}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual App synthetic canvas/account panel, normal/enlarged type, comfortable density, card clipping",
  );
} finally {
  await b.close();
}
