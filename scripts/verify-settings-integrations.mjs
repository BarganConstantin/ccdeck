// Browser regression checks using an external Playwright installation.
// All integration requests are intercepted; no real connection is changed.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright module.");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const base = process.argv[2] || "http://127.0.0.1:5186";
const output = process.env.SETTINGS_ARTIFACTS || "/tmp/ccdeck-settings-review";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
const results = [];
const providers = ["github", "gitlab", "jira"].map(kind => ({ kind, label: { github: "GitHub", gitlab: "GitLab", jira: "Jira" }[kind], available: true }));
const connection = (kind, id, name) => ({
  id, kind, name, baseUrl: `https://${kind}.example.com`, tokenSaved: true,
  account: { id: "reviewer", name: "Review Developer", login: "reviewer", avatarUrl: "" },
  meta: { checkedAt: "2026-10-23T08:00:00Z" }, allowedOrigins: [], createdAt: "2026-10-23T08:00:00Z", updatedAt: "2026-10-23T08:00:00Z",
});
try {
  for (const [width, height, theme] of [[1440, 1000, "rider-black"], [1440, 1000, "light"], [390, 844, "light"], [320, 740, "rider-black"]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript(theme => {
      localStorage.setItem("agent-dag.theme", theme);
      localStorage.setItem("agent-dag.tourSeen", "1");
      localStorage.setItem("agent-dag.releaseNotesSeen", "3.46.0");
    }, theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let saved = [], refuse = false, testFails = false, mutations = 0;
    await page.route("**/api/integrations**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname;
      const method = req.method();
      if (method === "GET" && path === "/api/integrations") return route.fulfill({ json: { connections: saved, providers } });
      if (method !== "GET") mutations++;
      // Exercise a request in flight so a second submission cannot sneak through.
      await new Promise(resolve => setTimeout(resolve, 180));
      if (refuse) return route.fulfill({ status: 400, json: { error: { kind: "invalid", message: "Enter a valid personal access token.", field: "token" } } });
      if (path.endsWith("/test")) {
        if (testFails) return route.fulfill({ status: 401, json: { error: { kind: "auth", message: "The token was refused. Edit the connection to replace it." } } });
        return route.fulfill({ json: { connection: saved.find(c => path.includes(`/${c.id}/`)) } });
      }
      if (method === "POST") {
        const body = req.postDataJSON();
        const next = connection(body.kind, `review-${saved.length + 1}`, body.name || `Review ${body.kind}`);
        saved.push(next);
        return route.fulfill({ json: { connection: next } });
      }
      const id = path.split("/").at(-1);
      if (method === "PATCH") {
        const body = req.postDataJSON();
        const next = saved.find(c => c.id === id);
        next.name = body.name || next.name;
        return route.fulfill({ json: { connection: next, validated: Boolean(body.input.token) } });
      }
      if (method === "DELETE") { saved = saved.filter(c => c.id !== id); return route.fulfill({ json: { ok: true } }); }
      return route.fulfill({ json: { ok: true, items: [] } });
    });
    const shot = async name => {
      await page.locator("[data-jumped]").waitFor({ state: "detached" });
      if (["connected", "disconnected"].includes(name)) await page.locator(".settings-pane").evaluate(el => { el.scrollTop = 0; });
      await page.locator(".settings-modal").screenshot({ path: `${output}/after-${name}-${width}-${theme}.png` });
    };
    const accessibility = async () => {
      if (!process.env.AXE_SCRIPT) return;
      await page.addScriptTag({ path: process.env.AXE_SCRIPT });
      const report = await page.evaluate(() => window.axe.run(document.querySelector(".settings-modal"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }));
      await writeFile(`${output}/axe-${width}-${theme}.json`, JSON.stringify(report.violations, null, 2));
      assert.deepEqual(report.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })), []);
    };
    const noOverflow = async () => {
      const overflow = await page.locator(".settings-modal").evaluate(root => [...root.querySelectorAll(".settings-pane, .settings-list, .ig-form, .ig-conn-head")].filter(el => el.checkVisibility()).some(el => el.scrollWidth > el.clientWidth + 1));
      assert.equal(overflow, false, "Settings content must fit its pane");
    };
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await shot("general");
    const nav = page.getByRole("tablist", { name: "Settings sections" });
    assert.equal(await nav.getAttribute("aria-orientation"), width <= 640 ? "horizontal" : "vertical");
    const navLabels = await nav.getByRole("tab").allTextContents();
    assert.deepEqual(navLabels, ["General", "Appearance", "Text & density", "Keyboard", "Notifications", "Sounds", "Integrations", "Data", "Radar", "About"]);
    // Walk every Settings section, preserving frame size and one selected tab.
    const original = await page.locator(".settings-modal").boundingBox();
    for (const label of navLabels) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      assert.equal(await nav.locator('[aria-selected="true"]').count(), 1);
      assert.equal((await page.locator(".settings-modal").boundingBox()).height, original.height);
      await noOverflow();
    }
    await page.getByRole("tab", { name: "Integrations", exact: true }).click();
    assert.deepEqual(await page.locator(".ig-provider h3").allTextContents(), ["GitHub", "GitLab", "Jira"]);
    assert.equal(await page.getByText("Not connected", { exact: true }).count(), 3);
    await shot("disconnected");
    await accessibility();
    for (const label of ["GitHub", "GitLab", "Jira"]) {
      const trigger = page.getByRole("button", { name: `Connect ${label}`, exact: true });
      await trigger.click();
      const form = page.getByRole("form", { name: `Connect ${label}`, exact: true });
      await form.waitFor();
      if (label === "GitHub") assert.equal(await form.getByLabel("Personal access token", { exact: true }).evaluate(el => el === document.activeElement), true);
      if (label === "GitLab") { await form.getByLabel("Self-managed", { exact: true }).focus(); await page.keyboard.press("Space"); await form.getByLabel("GitLab URL", { exact: true }).fill("https://gitlab.example.com"); }
      if (label === "Jira") { await form.getByLabel("Jira Cloud", { exact: true }).focus(); await page.keyboard.press("Space"); await form.getByLabel("Atlassian account email", { exact: true }).fill("reviewer@example.com"); }
      await noOverflow();
      await accessibility();
      await shot(`form-${label.toLowerCase()}`);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true, "Cancel returns focus to its provider");
    }
    const search = page.getByRole("combobox", { name: "Search settings" });
    for (const label of ["GitHub", "GitLab", "Jira"]) {
      await search.fill(label);
      await search.press("ArrowDown"); await search.press("ArrowUp"); await search.press("Enter");
      assert.equal(await page.getByRole("tab", { name: "Integrations", exact: true }).getAttribute("aria-selected"), "true");
      assert.equal(await page.getByRole("button", { name: `Connect ${label}`, exact: true }).evaluate(el => el === document.activeElement), true);
    }
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    let form = page.getByRole("form", { name: "Connect GitHub", exact: true });
    refuse = true;
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await form.getByRole("alert").waitFor();
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "");
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).getAttribute("aria-invalid"), "true");
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).evaluate(el => el === document.activeElement), true);
    await shot("field-error");
    await accessibility();
    refuse = false;
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    const countBefore = mutations;
    const submit = form.getByRole("button", { name: "Connect", exact: true });
    await submit.click();
    assert.equal(await form.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "Edit Review github", exact: true }).waitFor();
    assert.equal(mutations, countBefore + 1);
    assert.equal(await page.getByRole("button", { name: "Edit Review github", exact: true }).evaluate(el => el === document.activeElement), true);
    await page.getByRole("button", { name: "Add another GitHub connection", exact: true }).click();
    form = page.getByRole("form", { name: "Connect GitHub", exact: true });
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await form.getByLabel("Name", { exact: false }).fill("Work GitHub");
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Edit Work GitHub", exact: true }).waitFor();
    assert.equal(saved.length, 2);
    await shot("connected");
    await page.getByRole("button", { name: "Edit Work GitHub", exact: true }).click();
    form = page.getByRole("form", { name: "Edit Work GitHub", exact: true });
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "");
    await form.getByLabel("Name", { exact: false }).fill("Personal GitHub");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Edit Personal GitHub", exact: true }).waitFor();
    assert.equal(saved[1].name, "Personal GitHub");
    testFails = true;
    await page.getByRole("button", { name: "Test Personal GitHub", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "The token was refused" }).waitFor();
    await shot("connection-error");
    testFails = false;
    await page.getByRole("button", { name: "Test Personal GitHub", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Working:" }).waitFor();
    const disconnect = page.getByRole("button", { name: "Disconnect Personal GitHub", exact: true });
    await disconnect.click();
    assert.equal(saved.length, 2);
    await page.waitForTimeout(450); // The existing confirmation guard rejects double clicks within 400 ms.
    await page.getByRole("button", { name: "Confirm disconnecting Personal GitHub", exact: true }).click();
    await page.getByRole("button", { name: "Edit Personal GitHub", exact: true }).waitFor({ state: "detached" });
    assert.equal(saved.length, 1);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Add another GitHub connection");
    await noOverflow();
    // Arrows, Home/End, the modal trap, and Escape/search dismissal.
    const tab = page.getByRole("tab", { name: "Integrations", exact: true });
    await tab.focus(); await tab.press("Home");
    assert.equal(await page.getByRole("tab", { name: "General", exact: true }).getAttribute("aria-selected"), "true");
    await page.keyboard.press("End");
    assert.equal(await page.getByRole("tab", { name: "About", exact: true }).getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: "General", exact: true }).getAttribute("aria-selected"), "true");
    await page.keyboard.press("Control+f"); assert.equal(await search.evaluate(el => el === document.activeElement), true);
    await search.fill("GitHub"); await search.press("Escape");
    assert.equal(await search.inputValue(), "");
    for (let i = 0; i < 20; i++) { await page.keyboard.press("Tab"); assert.equal(await page.locator(".settings-modal").evaluate(el => el.contains(document.activeElement)), true); }
    await page.keyboard.press("Escape");
    await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).evaluate(el => el === document.activeElement), true);
    if (width === 1440 && theme === "rider-black") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Appearance", exact: true }).click();
      const themes = await page.locator("[data-theme-choice]").evaluateAll(nodes => nodes.map(node => node.dataset.themeChoice));
      for (const id of themes) {
        await page.getByRole("tab", { name: "Appearance", exact: true }).click();
        await page.locator(`[data-theme-choice="${id}"]`).click();
        await page.waitForFunction(id => document.documentElement.dataset.theme === id, id);
        await page.getByRole("tab", { name: "Integrations", exact: true }).click();
        await noOverflow();
        await accessibility();
        await page.locator(".settings-modal").screenshot({ path: `${output}/theme-${id}.png` });
      }
      results.push({ themeCatalog: themes, overviewAccessibility: process.env.AXE_SCRIPT ? "pass" : "not run", overflow: "none" });
    }
    assert.deepEqual(errors, []);
    results.push({ width, theme, mutations, navigation: "pass", forms: "pass", management: "pass", keyboard: "pass", overflow: "none", accessibility: process.env.AXE_SCRIPT ? "pass" : "not run", errors });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
} finally {
  await writeFile(`${output}/browser-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
