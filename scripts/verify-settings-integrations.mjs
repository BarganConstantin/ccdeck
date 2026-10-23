// Uses an existing external Playwright installation, with no project dependency.
// Integration requests use fixtures: no real credentials or connections change.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright module.");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const base = process.argv[2] || "http://127.0.0.1:5186";
const output = process.env.SETTINGS_ARTIFACTS || "/tmp/ccdeck-settings-iteration4";
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
      const overflow = await page.locator(".settings-modal").evaluate(root => [...root.querySelectorAll(".settings-pane, .settings-list, .ig-form, .ig-summary-row, .ig-detail-facts, .ig-leave-confirm")].filter(el => el.checkVisibility()).some(el => el.scrollWidth > el.clientWidth + 1));
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
    const providerLabels = { github: "GitHub", gitlab: "GitLab", jira: "Jira" };
    const manage = (kind, name) => page.getByRole("button", { name: `Manage ${providerLabels[kind]}: ${name} (reviewer)`, exact: true });
    const back = () => page.getByRole("button", { name: "All integrations", exact: true }).click();
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const frame = await page.locator(".settings-modal").boundingBox();
    const labels = await nav.getByRole("tab").allTextContents();
    assert.deepEqual(labels, ["General", "Appearance", "Text & density", "Keyboard", "Notifications", "Sounds", "Integrations", "Data", "Radar", "About"]);
    for (const label of labels) { await tab(label).click(); await noOverflow(); assert.equal((await page.locator(".settings-modal").boundingBox()).height, frame.height); }
    await tab("Integrations").click();
    assert.deepEqual(await page.locator(".ig-provider h3").allTextContents(), ["GitHub", "GitLab", "Jira"]);
    assert.equal(await page.getByRole("button", { name: "Test connection", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Edit connection", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: /^Disconnect / }).count(), 0);
    assert.equal(await page.getByText("Not connected", { exact: true }).count(), 1);
    const providerBounds = await page.locator(".ig-providers").boundingBox();
    const securityBounds = await page.locator(".ig-access").boundingBox();
    assert.ok(securityBounds.y >= providerBounds.y + providerBounds.height, "Security help belongs below the full provider list");
    await shot("overview"); await accessibility("overview");
    await manage("gitlab", "Work projects").click();
    const details = page.locator(".ig-connection-details");
    await page.getByRole("heading", { name: "Work projects", exact: true }).waitFor();
    assert.equal(await page.locator(".ig-overview").isVisible(), false);
    assert.equal(await page.getByRole("heading", { name: "Work projects", exact: true }).evaluate(el => el === document.activeElement), true);
    assert.match(await details.innerText(), /Review Developer.*reviewer/);
    assert.equal(await details.getByRole("button", { name: "Edit connection", exact: true }).evaluate(el => el.classList.contains("primary")), false);
    assert.equal(await details.locator(".ig-manage-actions").getByRole("button").allTextContents().then(labels => labels.join(",")), "Test connection,Edit connection");
    assert.equal(await details.getByRole("button", { name: "Disconnect Work projects", exact: true }).isEnabled(), true);
    assert.equal(await details.locator(".ig-add-another").getByRole("button").count(), 1);
    await shot("manage-gitlab"); await accessibility("manage-gitlab");
    await back();
    await checkFocus("Manage GitLab: Work projects (reviewer)");
    await manage("jira", "Engineering").click();
    await shot("manage-jira"); await accessibility("manage-jira");
    assert.match(await details.innerText(), /Jira Data Center 9.0/);
    await page.keyboard.press("Escape");
    await checkFocus("Manage Jira: Engineering (reviewer)");

    // Empty Connect, validation, unsaved inputs, and creation.
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    let form = page.getByRole("form", { name: "Connect GitHub", exact: true });
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).evaluate(el => el === document.activeElement), true);
    await shot("github"); await accessibility("github");
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await tab("General").click();
    await page.getByRole("button", { name: "Keep editing", exact: true }).waitFor();
    assert.equal(await tab("Integrations").getAttribute("aria-selected"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "review-fixture");
    refuse = true;
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await form.getByRole("alert").waitFor();
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "");
    await shot("field-error"); await accessibility("field-error");
    refuse = false;
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    assert.equal(await form.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
    await manage("github", "Review github").waitFor();
    await checkFocus("Manage GitHub: Review github (reviewer)");

    // Adding another connection starts from Manage, with no provider picker.
    await manage("gitlab", "Work projects").click();
    await page.getByRole("button", { name: "Add another GitLab connection", exact: true }).click();
    form = page.getByRole("form", { name: "Connect GitLab", exact: true });
    await form.getByLabel("Self-managed", { exact: true }).focus(); await page.keyboard.press("Space");
    await form.getByLabel("GitLab URL", { exact: true }).fill("https://source-control.engineering-and-platform-development.example.com");
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await form.getByLabel("Name", { exact: false }).fill("Platform engineering and developer productivity services");
    await shot("gitlab"); await noOverflow(); await accessibility("gitlab");
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await manage("gitlab", "Platform engineering and developer productivity services").waitFor();
    assert.equal(saved.filter(c => c.kind === "gitlab").length, 2);
    await shot("multiple"); await noOverflow();
    await manage("gitlab", "Platform engineering and developer productivity services").click();
    await noOverflow(); await shot("long-manage"); await accessibility("long-manage");
    await back();
    await manage("gitlab", "Work projects").click();
    await page.getByRole("button", { name: "Edit connection", exact: true }).click();
    form = page.getByRole("form", { name: "Edit Work projects", exact: true });
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "");
    await form.getByLabel("Name", { exact: false }).fill("Work sources");
    await shot("edit"); await accessibility("edit");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Test connection", exact: true }).waitFor();
    assert.equal(await page.locator(".ig-manage-view").isVisible(), true);
    assert.equal(payloads.at(-1).input.token, "");
    assert.equal(await page.getByRole("button", { name: "Edit connection", exact: true }).evaluate(el => el === document.activeElement), true);
    testFails = true;
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "The token was refused" }).waitFor();
    await shot("connection-error"); await accessibility("connection-error");
    testFails = false;
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Verified as" }).waitFor();
    await page.getByRole("button", { name: "Disconnect Work sources", exact: true }).click();
    assert.equal(saved.length, 4);
    await shot("disconnect-confirm"); await accessibility("disconnect-confirm");
    await page.waitForTimeout(450);
    await page.getByRole("button", { name: "Confirm disconnecting Work sources", exact: true }).click();
    await page.locator(".ig-manage-view").waitFor({ state: "detached" });
    assert.equal(saved.length, 3);
    await checkFocus("Manage GitLab: Platform engineering and developer productivity services (reviewer)");

    // Jira configurations, back from Add/Edit, and preservation of a draft.
    await manage("jira", "Engineering").click();
    await page.getByRole("button", { name: "Add another Jira connection", exact: true }).click();
    form = page.getByRole("form", { name: "Connect Jira", exact: true });
    await shot("jira-server");
    await form.getByLabel("Jira Cloud", { exact: true }).focus(); await page.keyboard.press("Space");
    await form.getByLabel("Site URL", { exact: true }).fill("review-team.atlassian.net");
    await form.getByLabel("Atlassian account email", { exact: true }).fill("reviewer@example.com");
    await shot("jira"); await accessibility("jira");
    await form.getByRole("button", { name: "Cancel", exact: true }).click(); await discard();
    assert.equal(await page.locator(".ig-manage-view").isVisible(), true);
    await page.getByRole("button", { name: "Edit connection", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".ig-manage-view").isVisible(), true);
    await page.keyboard.press("Escape");
    await checkFocus("Manage Jira: Engineering (reviewer)");
    const search = page.getByRole("combobox", { name: "Search settings" });
    for (const label of ["GitHub", "GitLab", "Jira"]) {
      await search.fill(label); await search.press("ArrowDown"); await search.press("ArrowUp"); await search.press("Enter");
      assert.equal(await page.locator(".ig-overview").isVisible(), true);
    }
    await manage("jira", "Engineering").click();
    await page.keyboard.press("Control+f"); await search.fill("GitLab"); await search.press("Enter");
    assert.equal(await page.locator(".ig-overview").isVisible(), true);
    await manage("jira", "Engineering").click();
    await page.getByRole("button", { name: "Edit connection", exact: true }).click();
    await page.getByRole("form").getByLabel("Name", { exact: false }).fill("Unsaved name");
    await tab("General").click();
    await page.getByRole("button", { name: "Keep editing", exact: true }).waitFor();
    await accessibility("unsaved");
    await page.getByRole("button", { name: "Discard changes", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === "settings-tab-general");
    await tab("Integrations").click();
    for (let i = 0; i < 25; i++) { await page.keyboard.press("Tab"); assert.equal(await page.locator(".settings-modal").evaluate(el => el.contains(document.activeElement)), true); }
    failList = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByRole("alert").filter({ hasText: "Could not read saved connections" }).waitFor();
    failList = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Could not read saved connections" }).waitFor({ state: "detached" });
    providers.find(p => p.kind === "jira").available = false;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.getByText("Jira is not available on this deck.", { exact: false }).waitFor();
    await manage("jira", "Engineering").click();
    assert.equal(await page.getByRole("button", { name: "Edit connection", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Disconnect Engineering", exact: true }).isVisible(), true);
    await noOverflow(); await shot("unavailable");
    await back();
    providers.find(p => p.kind === "jira").available = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator("#ig-provider-jira").waitFor();
    await tab("Text & density").click(); await page.getByRole("radio", { name: /Largest/ }).click();
    await tab("Integrations").click(); await noOverflow(); await shot("large-text");
    await tab("Text & density").click(); await page.getByRole("radio", { name: /^Default/ }).first().click(); await tab("Integrations").click();
    if (width === 1440 && theme === "rider-black") {
      await tab("Appearance").click();
      const themes = await page.locator("[data-theme-choice]").evaluateAll(nodes => nodes.map(node => node.dataset.themeChoice));
      for (const id of themes) {
        await tab("Appearance").click(); await page.locator(`[data-theme-choice="${id}"]`).click();
        await page.waitForFunction(id => document.documentElement.dataset.theme === id, id);
        await tab("Integrations").click(); await noOverflow(); await accessibility(`theme-${id}`);
        await manage("jira", "Engineering").click(); await accessibility(`manage-theme-${id}`); await back();
      }
      results.push({ themeCatalog: themes, accessibility: process.env.AXE_SCRIPT ? "pass" : "not run" });
    }
    await page.keyboard.press("Escape"); await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
    results.push({ width, height, theme, overview: "pass", manage: "pass", multipleConnections: "pass", focusedForms: "pass", unsavedDrafts: "pass", management: "pass", keyboard: "pass", overflow: "none", accessibility: process.env.AXE_SCRIPT ? "pass" : "not run", mutations, errors });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
} finally {
  await writeFile(`${output}/browser-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
