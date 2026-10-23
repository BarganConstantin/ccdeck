// Uses an existing external Playwright installation, with no project dependency.
// Integration requests use fixtures: no real credentials or connections change.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright module.");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const base = process.argv[2] || "http://127.0.0.1:5186";
const output = process.env.SETTINGS_ARTIFACTS || "/tmp/ccdeck-settings-iteration2";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
const results = [];
const providers = ["github", "gitlab", "jira"].map(kind => ({ kind, label: { github: "GitHub", gitlab: "GitLab", jira: "Jira" }[kind], available: true }));
const connection = (kind, id, name) => ({
  id, kind, name, baseUrl: `https://${kind}.example.com`, tokenSaved: true,
  account: { id: "reviewer", name: "Review Developer", login: "reviewer", avatarUrl: "" },
  meta: { checkedAt: "2026-10-23T08:00:00Z", ...(kind === "jira" ? { deployment: "server", deploymentType: "DataCenter", serverVersion: "9.0" } : {}) },
  allowedOrigins: [], createdAt: "2026-10-23T08:00:00Z", updatedAt: "2026-10-23T08:00:00Z",
});
try {
  for (const [width, height, theme] of [[1440, 1000, "rider-black"], [1440, 1000, "light"], [900, 760, "rider-black"], [390, 844, "light"], [320, 740, "rider-black"]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript(theme => {
      localStorage.setItem("agent-dag.theme", theme);
      localStorage.setItem("agent-dag.tourSeen", "1");
      localStorage.setItem("agent-dag.releaseNotesSeen", "3.46.0");
    }, theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let saved = [connection("gitlab", "gitlab", "Work projects"), connection("jira", "jira", "Engineering")];
    let refuse = false, testFails = false, failList = false, mutations = 0;
    const payloads = [];
    let prefs = { recoverCodexSessions: true, recoverClaudeSessions: true, continueStopped: false };
    await page.route("**/api/prefs", route => {
      if (route.request().method() === "POST") prefs = { ...prefs, ...route.request().postDataJSON() };
      return route.fulfill({ json: { ok: true, prefs } });
    });
    await page.route("**/api/integrations**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
      if (method === "GET" && path === "/api/integrations") return route.fulfill(failList
        ? { status: 503, json: { error: { kind: "unavailable", message: "Could not read saved connections. Try again." } } }
        : { json: { connections: saved, providers } });
      if (method !== "GET") mutations++;
      await new Promise(resolve => setTimeout(resolve, 180));
      if (refuse) return route.fulfill({ status: 400, json: { error: { kind: "invalid", message: "Enter a valid personal access token.", field: "token" } } });
      if (path.endsWith("/test")) {
        if (testFails) return route.fulfill({ status: 401, json: { error: { kind: "auth", message: "The token was refused. Edit the connection to replace it." } } });
        const next = saved.find(c => path.includes(`/${c.id}/`));
        next.meta.checkedAt = new Date().toISOString();
        return route.fulfill({ json: { connection: next } });
      }
      if (method === "POST") {
        const body = req.postDataJSON(); payloads.push(body);
        const next = connection(body.kind, `review-${saved.length + 1}`, body.name || `Review ${body.kind}`);
        if (body.input.baseUrl) next.baseUrl = body.input.baseUrl;
        saved.push(next);
        return route.fulfill({ json: { connection: next } });
      }
      const id = path.split("/").at(-1);
      if (method === "PATCH") {
        const body = req.postDataJSON(); payloads.push(body);
        const next = saved.find(c => c.id === id); next.name = body.name || next.name;
        return route.fulfill({ json: { connection: next, validated: Boolean(body.input.token) } });
      }
      if (method === "DELETE") { saved = saved.filter(c => c.id !== id); return route.fulfill({ json: { ok: true } }); }
      return route.fulfill({ json: { ok: true, items: [] } });
    });
    const nav = page.getByRole("tablist", { name: "Settings sections" });
    const tab = label => page.getByRole("tab", { name: label, exact: true });
    const shot = async name => {
      await page.locator("[data-jumped]").waitFor({ state: "detached" });
      await page.locator(".settings-modal").screenshot({ path: `${output}/after-${name}-${width}-${theme}.png` });
    };
    const noOverflow = async () => {
      const overflow = await page.locator(".settings-modal").evaluate(root => [...root.querySelectorAll(".settings-pane, .settings-list, .ig-form, .ig-conn-head, .ig-leave-confirm")].filter(el => el.checkVisibility()).some(el => el.scrollWidth > el.clientWidth + 1));
      assert.equal(overflow, false, "Content must fit the Settings pane");
      const bounds = await page.locator(".settings-modal").boundingBox();
      const viewport = page.viewportSize();
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, "Modal must remain within the viewport");
    };
    const accessibility = async name => {
      if (!process.env.AXE_SCRIPT) return;
      await page.addScriptTag({ path: process.env.AXE_SCRIPT });
      const report = await page.evaluate(() => window.axe.run(document.querySelector(".settings-modal"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
      await writeFile(`${output}/axe-${name}-${width}-${theme}.json`, JSON.stringify(report.violations, null, 2));
      assert.deepEqual(report.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })), []);
    };
    const discard = async () => {
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      await page.locator(".ig-config-view").waitFor({ state: "detached" });
    };
    const checkFocus = async label => page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label, label);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await shot("general"); await noOverflow(); await accessibility("general");
    const detail = page.locator('.settings-row-details').filter({ hasText: "missing ending" });
    await detail.locator("summary").click();
    assert.equal(await detail.getAttribute("open"), "");
    assert.match(await detail.innerText(), /does not confirm the process is still running/);
    await detail.locator("summary").click();
    const recovery = page.getByRole("switch", { name: "Restore unfinished Codex sessions", exact: true });
    await page.locator('[data-setting="codex-session-recovery"] .settings-row-name').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Restore unfinished Codex sessions"]')?.getAttribute("aria-checked") === "false");
    await recovery.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Restore unfinished Codex sessions"]')?.getAttribute("aria-checked") === "true");
    assert.equal(await nav.getAttribute("aria-orientation"), width <= 640 ? "horizontal" : "vertical");
    const labels = await nav.getByRole("tab").allTextContents();
    assert.deepEqual(labels, ["General", "Appearance", "Text & density", "Keyboard", "Notifications", "Sounds", "Integrations", "Data", "Radar", "About"]);
    const frame = await page.locator(".settings-modal").boundingBox();
    for (const label of labels) { await tab(label).click(); await noOverflow(); assert.equal((await page.locator(".settings-modal").boundingBox()).height, frame.height); }
    await tab("Integrations").click();
    assert.deepEqual(await page.locator(".ig-provider h3").allTextContents(), ["GitHub", "GitLab", "Jira"]);
    assert.equal(await page.getByText(/Not connected/).count(), 1);
    assert.equal(await page.getByText(/Last verified/).count(), 2);
    const selectedTab = tab("Integrations");
    assert.equal(await selectedTab.evaluate(el => getComputedStyle(el).borderTopWidth), "0px");
    await selectedTab.hover();
    assert.equal(await selectedTab.evaluate(el => getComputedStyle(el).borderTopWidth), "0px");
    const head = page.locator(".ig-conn-head").first();
    const textBox = await head.locator(".ig-conn-text").boundingBox();
    const actionsBox = await head.locator(".ig-conn-actions").boundingBox();
    if (width > 640) assert.ok(actionsBox.x >= textBox.x + textBox.width, "Desktop actions must use the right side of the connection row");
    else assert.ok(actionsBox.y >= textBox.y + textBox.height, "Narrow layouts must keep actions below the account text");
    await shot("overview"); await accessibility("overview");

    // Empty form returns with one Escape; a draft requires an explicit choice.
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    let form = page.getByRole("form", { name: "Connect GitHub", exact: true });
    assert.equal(await page.locator(".ig-overview").isVisible(), false);
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).evaluate(el => el === document.activeElement), true);
    await shot("github"); await accessibility("github");
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await tab("General").click();
    await page.getByRole("button", { name: "Keep editing", exact: true }).waitFor();
    assert.equal(await tab("Integrations").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator(".ig-config-view form").isVisible(), false);
    await shot("unsaved"); await accessibility("unsaved");
    await page.keyboard.press("Escape");
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "review-fixture");
    // The close button is guarded too.
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    refuse = true;
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await form.getByRole("alert").waitFor();
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "");
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).getAttribute("aria-invalid"), "true");
    await shot("field-error"); await accessibility("field-error");
    refuse = false;
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    const before = mutations;
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    assert.equal(await form.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Edit Review github", exact: true }).waitFor();
    await checkFocus("Edit Review github");
    assert.equal(mutations, before + 1);

    await page.getByRole("button", { name: "Add another GitLab connection", exact: true }).click();
    form = page.getByRole("form", { name: "Connect GitLab", exact: true });
    await form.getByLabel("Self-managed", { exact: true }).focus(); await page.keyboard.press("Space");
    const longHost = "https://source-control.engineering-and-platform-development.example.com";
    await form.getByLabel("GitLab URL", { exact: true }).fill(longHost);
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await form.getByLabel("Name", { exact: false }).fill("Platform engineering and developer productivity services");
    await shot("gitlab"); await noOverflow(); await accessibility("gitlab");
    const help = form.locator(".ig-token-help summary"); await help.focus(); await help.press("Enter");
    assert.equal(await form.locator(".ig-token-help").getAttribute("open"), "");
    await help.press("Enter");
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: /Edit Platform engineering/ }).waitFor();
    assert.equal(saved.filter(c => c.kind === "gitlab").length, 2);
    await noOverflow(); await shot("long-connection");

    await page.getByRole("button", { name: "Edit Work projects", exact: true }).click();
    form = page.getByRole("form", { name: "Edit Work projects", exact: true });
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "");
    await form.getByLabel("Name", { exact: false }).fill("Work sources");
    await shot("edit"); await accessibility("edit");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Edit Work sources", exact: true }).waitFor();
    assert.equal(payloads.at(-1).input.token, "");
    await checkFocus("Edit Work sources");

    await page.getByRole("button", { name: "Add another Jira connection", exact: true }).click();
    form = page.getByRole("form", { name: "Connect Jira", exact: true });
    await shot("jira-server");
    await form.getByLabel("Jira Cloud", { exact: true }).focus(); await page.keyboard.press("Space");
    await form.getByLabel("Site URL", { exact: true }).fill("review-team.atlassian.net");
    await form.getByLabel("Atlassian account email", { exact: true }).fill("reviewer@example.com");
    await shot("jira"); await accessibility("jira"); await noOverflow();
    await form.getByRole("button", { name: "Cancel", exact: true }).click(); await discard();
    await checkFocus("Add another Jira connection");

    testFails = true;
    await page.getByRole("button", { name: "Test Work sources", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "The token was refused" }).waitFor();
    await shot("connection-error"); await accessibility("connection-error");
    testFails = false;
    await page.getByRole("button", { name: "Test Work sources", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Verified as" }).waitFor();
    await page.getByRole("button", { name: "Disconnect Work sources", exact: true }).click();
    assert.equal(saved.length, 4);
    await page.waitForTimeout(450); // Existing protection against accidental double-clicks.
    await page.getByRole("button", { name: "Confirm disconnecting Work sources", exact: true }).click();
    await page.getByRole("button", { name: "Edit Work sources", exact: true }).waitFor({ state: "detached" });
    assert.equal(saved.length, 3); await checkFocus("Add another GitLab connection");

    const search = page.getByRole("combobox", { name: "Search settings" });
    for (const label of ["GitHub", "GitLab", "Jira"]) {
      await search.fill(label); await search.press("ArrowDown"); await search.press("ArrowUp"); await search.press("Enter");
      assert.equal(await tab("Integrations").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator(".ig-overview").isVisible(), true);
    }
    // Search keeps a draft mounted; choosing a destination asks before discarding it.
    await page.getByRole("button", { name: "Add another Jira connection", exact: true }).click();
    form = page.getByRole("form", { name: "Connect Jira", exact: true });
    await form.getByLabel("Jira URL", { exact: true }).fill("https://jira.example.com");
    await page.keyboard.press("Control+f"); await search.fill("GitLab"); await search.press("Escape");
    assert.equal(await form.getByLabel("Jira URL", { exact: true }).inputValue(), "https://jira.example.com");
    await page.keyboard.press("Escape"); await discard();
    await page.getByRole("button", { name: "Add another Jira connection", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.locator(".ig-config-view").waitFor({ state: "detached" });

    await page.getByRole("button", { name: "Add another Jira connection", exact: true }).click();
    form = page.getByRole("form", { name: "Connect Jira", exact: true });
    await form.getByLabel("Jira URL", { exact: true }).fill("https://jira.example.com");
    await tab("General").click(); await discard();
    await page.waitForFunction(() => document.activeElement?.id === "settings-tab-general");
    await tab("Integrations").click();
    await page.getByRole("button", { name: "Add another Jira connection", exact: true }).click();
    await page.getByRole("form", { name: "Connect Jira", exact: true }).getByLabel("Jira URL", { exact: true }).fill("https://jira.example.com");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Settings", exact: true }).click(); await tab("Integrations").click();
    await tab("Integrations").focus(); await page.keyboard.press("Home");
    assert.equal(await tab("General").getAttribute("aria-selected"), "true");
    await page.keyboard.press("End"); assert.equal(await tab("About").getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowRight"); assert.equal(await tab("General").getAttribute("aria-selected"), "true");
    await tab("Integrations").click();
    for (let i = 0; i < 25; i++) { await page.keyboard.press("Tab"); assert.equal(await page.locator(".settings-modal").evaluate(el => el.contains(document.activeElement)), true); }
    // A failed list read retains the known connections and offers a real retry.
    failList = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByRole("alert").filter({ hasText: "Could not read saved connections" }).waitFor();
    await page.locator(".settings-pane").evaluate(el => { el.scrollTop = 0; });
    await shot("list-error");
    failList = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Could not read saved connections" }).waitFor({ state: "detached" });
    // A provider becoming unavailable leaves its saved connection removable.
    providers.find(p => p.kind === "jira").available = false;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByText("Jira is not available on this deck.", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit Engineering", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Disconnect Engineering", exact: true }).isVisible(), true);
    await noOverflow(); await shot("unavailable");
    providers.find(p => p.kind === "jira").available = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByRole("button", { name: "Edit Engineering", exact: true }).waitFor();
    // The app's largest text setting must preserve wrapping and usable controls.
    await tab("Text & density").click(); await page.getByRole("radio", { name: /Largest/ }).click();
    await tab("Integrations").click(); await noOverflow(); await shot("large-text");
    await tab("Text & density").click(); await page.getByRole("radio", { name: /^Default/ }).first().click(); await tab("Integrations").click();
    if (width === 1440 && theme === "rider-black") {
      // Desktop browser zoom reduces the effective CSS viewport. Exercise the
      // equivalent layout at half width/height; this does not claim native zoom UI testing.
      await page.setViewportSize({ width: width / 2, height: height / 2 });
      await noOverflow(); await shot("zoom-equivalent");
      await page.setViewportSize({ width, height });
      await tab("Appearance").click();
      const themes = await page.locator("[data-theme-choice]").evaluateAll(nodes => nodes.map(node => node.dataset.themeChoice));
      for (const id of themes) {
        await tab("Appearance").click(); await page.locator(`[data-theme-choice="${id}"]`).click();
        await page.waitForFunction(id => document.documentElement.dataset.theme === id, id);
        await tab("Integrations").click(); await noOverflow(); await accessibility(`theme-${id}`);
      }
      results.push({ themeCatalog: themes, accessibility: process.env.AXE_SCRIPT ? "pass" : "not run" });
    }
    await page.keyboard.press("Escape"); await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
    results.push({ width, height, theme, focusedForms: "pass", unsavedDrafts: "pass", management: "pass", keyboard: "pass", overflow: "none", accessibility: process.env.AXE_SCRIPT ? "pass" : "not run", mutations, errors });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
} finally {
  await writeFile(`${output}/browser-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
