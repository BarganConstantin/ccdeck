// Uses an existing external Playwright installation, with no project dependency.
// Integration requests use fixtures: no real credentials or connections change.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright module.");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const base = process.argv[2] || "http://127.0.0.1:5186";
const output = process.env.SETTINGS_ARTIFACTS || "/tmp/ccdeck-settings-iteration5/after";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
const results = [];
const providers = ["github", "gitlab", "jira"].map(kind => ({ kind, label: { github: "GitHub", gitlab: "GitLab", jira: "Jira" }[kind], available: true }));
const connection = (kind, id, name) => ({
  id, kind, name, baseUrl: `https://${kind}.example.com`, tokenSaved: true,
  account: { id: "reviewer", name: "Review Developer", login: "reviewer", avatarUrl: "" },
  meta: { checkedAt: "2026-10-23T08:00:00Z", ...(kind === "jira" ? { deployment: "server", deploymentType: "DataCenter", serverVersion: "9.0" } : kind === "gitlab" ? { serverVersion: "17.5.1" } : {}) },
  allowedOrigins: [], createdAt: "2026-10-23T08:00:00Z", updatedAt: "2026-10-23T08:00:00Z",
});
try {
  for (const [width, height, theme] of [[1440, 1000, "rider-black"], [1440, 1000, "light"], [900, 760, "rider-black"], [900, 540, "rider-black"], [390, 844, "light"], [320, 740, "rider-black"]]) {
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
    let refuse = false, testFails = false, failList = false, deleteFails = false, mutations = 0;
    let requestDelay = 180;
    const calls = { test: 0, delete: 0 };
    const longName = "Platform engineering and developer productivity services";
    const longAccount = "Review Developer for infrastructure reliability and cross-platform developer productivity services";
    const payloads = [];
    let prefs = { recoverCodexSessions: true, recoverClaudeSessions: true, continueStopped: false };
    // Register first: the specific fixture routes below take precedence.
    // Any incidental mutation elsewhere on the deck stays inside this context.
    await page.route("**/api/**", route => route.request().method() === "GET"
      ? route.fallback() : route.fulfill({ status: 403, json: { error: { kind: "permission", message: "Outside the Settings fixture scope." } } }));
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
      if (path.endsWith("/test")) calls.test++;
      if (method === "DELETE") calls.delete++;
      await new Promise(resolve => setTimeout(resolve, requestDelay));
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
        if (body.name === longName) next.account.name = longAccount;
        saved.push(next);
        return route.fulfill({ json: { connection: next } });
      }
      const id = path.split("/").at(-1);
      if (method === "PATCH") {
        const body = req.postDataJSON(); payloads.push(body);
        const next = saved.find(c => c.id === id); next.name = body.name || next.name;
        return route.fulfill({ json: { connection: next, validated: Boolean(body.input.token) } });
      }
      if (method === "DELETE") {
        if (deleteFails) return route.fulfill({ status: 503, json: { error: { kind: "unavailable", message: "Could not remove this connection. Try disconnecting again." } } });
        saved = saved.filter(c => c.id !== id); return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { ok: true, items: [] } });
    });
    const nav = page.getByRole("tablist", { name: "Settings sections" });
    const tab = label => page.getByRole("tab", { name: label, exact: true });
    const shot = async name => {
      await page.locator("[data-jumped]").waitFor({ state: "detached" });
      await page.locator(".settings-modal").screenshot({ path: `${output}/after-${name}-${width}x${height}-${theme}.png` });
    };
    const noOverflow = async () => {
      const overflow = await page.locator(".settings-modal").evaluate(root => [...root.querySelectorAll(".settings-pane, .settings-list, .ig-form, .ig-summary-row, .ig-detail-facts, .ig-leave-confirm")].filter(el => el.checkVisibility()).some(el => el.scrollWidth > el.clientWidth + 1));
      assert.equal(overflow, false, "Content must fit the Settings pane");
      const bounds = await page.locator(".settings-modal").boundingBox();
      const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      assert.ok(bounds.x >= -1 && bounds.x + bounds.width <= viewport.width + 1, "Modal must remain within the viewport");
    };
    const accessibility = async name => {
      if (!process.env.AXE_SCRIPT) return;
      await page.addScriptTag({ path: process.env.AXE_SCRIPT });
      const { tags, report } = await page.evaluate(async () => {
        const tags = ["wcag2a", "wcag2aa", "wcag21aa"];
        if (window.axe.getRules().some(rule => rule.tags.includes("wcag22aa"))) tags.push("wcag22aa");
        return { tags, report: await window.axe.run(document.querySelector(".settings-modal"), { runOnly: { type: "tag", values: tags } }) };
      });
      await writeFile(`${output}/axe-${name}-${width}x${height}-${theme}.json`, JSON.stringify({ tags, engine: report.testEngine, violations: report.violations }, null, 2));
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
    const toolbarAdd = kind => page.locator(".ig-manage-navigation").getByRole("button", { name: `Add ${providerLabels[kind]} connection`, exact: true });
    const overviewAdd = kind => page.getByRole("button", { name: `Add connection to ${providerLabels[kind]}`, exact: true });
    const disconnect = () => page.getByRole("button", { name: "Disconnect Work sources", exact: true });
    const confirmDisconnect = () => page.getByRole("button", { name: "Confirm disconnecting Work sources", exact: true });
    const cancelDisconnect = () => page.getByRole("button", { name: "Cancel disconnect", exact: true });
    const fact = label => page.locator(".ig-detail-facts > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd");
    const managementLayout = async name => {
      const heading = page.getByRole("heading", { name, exact: true, level: 2 });
      await heading.waitFor();
      assert.equal(await heading.getAttribute("id"), "ig-managed-title");
      assert.equal(await page.locator(".settings-pane-head").isVisible(), false, "Only the connection title should head Manage");
      assert.equal(await page.locator(".ig-connection-details .ig-add-another").count(), 0);
      assert.equal(await page.locator(".ig-connection-details").getByRole("button", { name: /^Add / }).count(), 0);
      const layout = await page.locator(".ig-detail-facts").evaluate(el => ({ columns: getComputedStyle(el).gridTemplateColumns.split(/\s+/).length }));
      assert.equal(layout.columns, width > 640 ? 2 : 1, "Metadata must use two desktop columns and one narrow column");
      const radii = await page.locator(".ig-manage-view .btn").evaluateAll(nodes => nodes.filter(el => el.checkVisibility()).map(el => ({ text: el.textContent, radius: getComputedStyle(el).borderTopLeftRadius, expected: getComputedStyle(el).getPropertyValue("--r-ctl").trim() })));
      for (const control of radii) {
        assert.ok(control.expected, "Shared control radius token must exist");
        assert.equal(control.radius, control.expected, `${control.text} must use --r-ctl`);
      }
      await noOverflow();
    };
    const keyboardFocusVisible = async () => {
      const focus = await page.evaluate(() => {
        const el = document.activeElement, box = el.getBoundingClientRect(), style = getComputedStyle(el);
        const pane = el.closest(".settings-pane")?.getBoundingClientRect();
        return { name: el.getAttribute("aria-label") || el.textContent, width: box.width, height: box.height,
          visible: box.top >= Math.max(0, pane?.top ?? 0) - 1 && box.bottom <= Math.min(innerHeight, pane?.bottom ?? innerHeight) + 1,
          hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button") === el,
          ring: el.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 };
      });
      assert.ok(focus.width >= 24 && focus.height >= 24, `${focus.name}: target must be at least 24px`);
      assert.ok(focus.visible && focus.hit && focus.ring, `${focus.name}: keyboard focus must be visible and unobscured`);
    };
    // Task A — stable Settings shell, compact overview, direct provider Add.
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
    assert.equal(await page.locator(".settings-pane-head").isVisible(), true);
    assert.equal(await page.getByRole("heading", { name: "Integrations", exact: true, level: 2 }).isVisible(), true);
    for (const kind of ["gitlab", "jira"]) {
      assert.equal(await overviewAdd(kind).innerText(), "Add connection");
      assert.equal(await overviewAdd(kind).isEnabled(), true);
    }
    const providerBounds = await page.locator(".ig-providers").boundingBox();
    const securityBounds = await page.locator(".ig-access").boundingBox();
    assert.ok(securityBounds.y >= providerBounds.y + providerBounds.height, "Security help belongs below the full provider list");
    await shot("overview"); await accessibility("overview");
    // Direct Add is provider-level, and a clean cancel returns to its overview trigger.
    await overviewAdd("gitlab").click();
    await page.getByRole("form", { name: "Connect GitLab", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".ig-config-view").waitFor({ state: "detached" });
    assert.equal(await page.locator(".ig-overview").isVisible(), true);
    assert.equal(await page.locator(".settings-pane-head").isVisible(), true);
    await checkFocus("Add connection to GitLab");

    // Task B — focused Manage title, shared geometry and factual metadata.
    await manage("gitlab", "Work projects").click();
    const details = page.locator(".ig-connection-details");
    await managementLayout("Work projects");
    assert.equal(await page.locator(".ig-overview").isVisible(), false);
    assert.equal(await page.getByRole("heading", { name: "Work projects", exact: true }).evaluate(el => el === document.activeElement), true);
    assert.match(await details.innerText(), /Review Developer.*reviewer/);
    assert.equal(await details.getByRole("button", { name: "Edit connection", exact: true }).evaluate(el => el.classList.contains("primary")), false);
    assert.equal(await details.locator(":scope > .ig-manage-actions").getByRole("button").allTextContents().then(labels => labels.join(",")), "Test connection,Edit connection");
    assert.equal(await details.getByRole("button", { name: "Disconnect Work projects", exact: true }).isEnabled(), true);
    assert.equal(await details.getByRole("button", { name: "Disconnect Work projects", exact: true }).evaluate(el => el.classList.contains("danger")), true);
    assert.equal(await toolbarAdd("gitlab").isVisible(), true);
    assert.equal(await fact("Host").innerText(), "https://gitlab.example.com");
    assert.equal(await fact("Credentials").innerText(), "Stored locally");
    assert.match(await fact("Server").innerText(), /GitLab.*17\.5\.1/);
    await shot("manage-gitlab"); await accessibility("manage-gitlab");
    await back();
    await checkFocus("Manage GitLab: Work projects (reviewer)");
    await manage("jira", "Engineering").click();
    await managementLayout("Engineering");
    await shot("manage-jira"); await accessibility("manage-jira");
    assert.match(await details.innerText(), /Jira Data Center 9.0/);
    await page.keyboard.press("Escape");
    await checkFocus("Manage Jira: Engineering (reviewer)");

    // Task C — empty Connect, validation, unsaved inputs, and creation.
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
    await manage("github", "Review github").click();
    await details.getByRole("status").filter({ hasText: "Connection saved and tested as Review Developer." }).waitFor();
    await back();

    // Task D — toolbar Add, multiple connections, long names and Edit.
    await manage("gitlab", "Work projects").click();
    await toolbarAdd("gitlab").click();
    form = page.getByRole("form", { name: "Connect GitLab", exact: true });
    await form.getByLabel("Self-managed", { exact: true }).focus(); await page.keyboard.press("Space");
    await form.getByLabel("GitLab URL", { exact: true }).fill("https://source-control.engineering-and-platform-development.example.com");
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await form.getByLabel("Name", { exact: false }).fill(longName);
    await shot("gitlab"); await noOverflow(); await accessibility("gitlab");
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await manage("gitlab", longName).waitFor();
    assert.equal(saved.filter(c => c.kind === "gitlab").length, 2);
    await shot("multiple"); await noOverflow();
    await manage("gitlab", longName).click();
    await managementLayout(longName);
    assert.match(await fact("Account").innerText(), new RegExp(`${longAccount}.*reviewer`));
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
    // A newly supplied token reports validation; name-only Save must not pretend to test.
    await page.getByRole("button", { name: "Edit connection", exact: true }).click();
    form = page.getByRole("form", { name: "Edit Work sources", exact: true });
    await form.getByLabel("Personal access token", { exact: true }).fill("replacement-review-fixture");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("status").filter({ hasText: /Saved\. Connection test passed as Review Developer/ }).waitFor();
    assert.equal(payloads.at(-1).input.token, "replacement-review-fixture");
    await managementLayout("Work sources");

    // Task E — Test feedback, delayed duplicate suppression and retained busy focus.
    testFails = true;
    await page.getByRole("button", { name: "Test connection", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "The token was refused" }).waitFor();
    await shot("connection-error"); await accessibility("connection-error");
    testFails = false;
    requestDelay = 800;
    const testsBefore = calls.test;
    const testButton = details.locator(".ig-manage-actions button").first();
    await testButton.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('.ig-manage-actions button[aria-busy="true"]'));
    assert.equal(await testButton.evaluate(el => el === document.activeElement), true, "Testing must retain keyboard focus");
    await testButton.evaluate(el => { el.click(); el.click(); });
    await page.getByRole("status").filter({ hasText: /Connection test passed\. Signed in as Review Developer/ }).waitFor();
    assert.equal(calls.test, testsBefore + 1, "Repeated testing while busy must issue one request");
    assert.equal(await testButton.evaluate(el => el === document.activeElement), true);
    requestDelay = 180;

    // Task F — disconnect guard, reading time, focus/window cancellation and retry.
    const deletesBefore = calls.delete;
    await disconnect().dblclick();
    assert.equal(calls.delete, deletesBefore, "A double click must only arm, never DELETE");
    assert.match(await details.innerText(), /Press Confirm disconnect to delete this connection and its saved token, or Cancel to keep it\./);
    await cancelDisconnect().click();
    await checkFocus("Disconnect Work sources");
    assert.equal(await confirmDisconnect().count(), 0);
    for (const key of ["Enter", "Space"]) {
      await disconnect().focus(); await page.keyboard.press(key);
      await confirmDisconnect().waitFor();
      assert.equal(calls.delete, deletesBefore, `${key} must first arm the connection`);
      await cancelDisconnect().click(); await checkFocus("Disconnect Work sources");
    }
    await disconnect().click();
    await cancelDisconnect().focus();
    await page.waitForTimeout(4_150);
    assert.equal(await confirmDisconnect().isVisible(), true, "An engaged confirmation must survive reading for more than four seconds");
    assert.equal(await cancelDisconnect().evaluate(el => el === document.activeElement), true, "Reading must retain focus on Cancel");
    assert.equal(calls.delete, deletesBefore, "Reading a confirmation must never DELETE");
    await testButton.focus();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Cancel disconnect"]'));
    assert.equal(await confirmDisconnect().count(), 0, "Moving focus outside the action group must cancel confirmation");
    assert.equal(await testButton.evaluate(el => el === document.activeElement), true, "Cancellation must preserve the newly focused control");
    await disconnect().click();
    await cancelDisconnect().focus();
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.waitForFunction(() => !document.querySelector('[aria-label="Cancel disconnect"]'));
    assert.equal(await confirmDisconnect().count(), 0, "Window blur must cancel confirmation");
    await checkFocus("Disconnect Work sources");
    assert.equal(calls.delete, deletesBefore);
    await disconnect().click();
    await page.getByRole("button", { name: "Edit connection", exact: true }).click();
    await page.getByRole("form", { name: "Edit Work sources", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".ig-config-view").waitFor({ state: "detached" });
    assert.equal(await disconnect().isVisible(), true, "Returning from Edit must clear the old armed state");
    assert.equal(await confirmDisconnect().count(), 0);
    await disconnect().click(); await toolbarAdd("gitlab").click();
    await page.getByRole("form", { name: "Connect GitLab", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".ig-config-view").waitFor({ state: "detached" });
    assert.equal(await disconnect().isVisible(), true, "Returning from Add must clear the old armed state");
    assert.equal(await confirmDisconnect().count(), 0);
    // Testing is also a context change for the destructive confirmation.
    await disconnect().click(); await testButton.click();
    await page.waitForFunction(() => !document.querySelector('.ig-manage-actions button[aria-busy="true"]'));
    assert.equal(await disconnect().isVisible(), true);
    assert.equal(await confirmDisconnect().count(), 0);

    await disconnect().click();
    assert.equal(saved.length, 4);
    await shot("disconnect-confirm"); await accessibility("disconnect-confirm");
    deleteFails = true;
    await page.waitForTimeout(450);
    await confirmDisconnect().focus(); await page.keyboard.press("Space");
    const remove = details.locator(".ig-disconnect-section");
    await remove.getByRole("alert").filter({ hasText: "Could not remove this connection. Try disconnecting again." }).waitFor();
    assert.equal(await details.isVisible(), true, "Delete failure must retain Manage");
    assert.equal(saved.length, 4, "Delete failure must preserve the fixture connection");
    assert.equal(calls.delete, deletesBefore + 1);
    await checkFocus("Disconnect Work sources");
    await shot("disconnect-error"); await accessibility("disconnect-error");
    deleteFails = false; requestDelay = 800;
    await disconnect().click(); await page.waitForTimeout(450);
    await confirmDisconnect().focus(); await page.keyboard.press("Enter");
    const deletingButton = remove.locator('button[aria-busy="true"]');
    await deletingButton.waitFor();
    assert.equal(await deletingButton.evaluate(el => el === document.activeElement), true, "Disconnecting must retain keyboard focus");
    await deletingButton.evaluate(el => { el.click(); el.click(); });
    await page.locator(".ig-manage-view").waitFor({ state: "detached" });
    assert.equal(calls.delete, deletesBefore + 2, "Repeated retry clicks must issue only one DELETE");
    assert.equal(saved.length, 3);
    await checkFocus(`Manage GitLab: ${longName} (reviewer)`);
    requestDelay = 180;

    // Task G — Jira variants, search, leave guards, unavailable providers and adaptation.
    await manage("jira", "Engineering").click();
    await toolbarAdd("jira").click();
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
    assert.equal(await toolbarAdd("jira").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Test connection", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Disconnect Engineering", exact: true }).isVisible(), true);
    await noOverflow(); await shot("unavailable");
    await back();
    providers.find(p => p.kind === "jira").available = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator("#ig-provider-jira").waitFor();
    await tab("Text & density").click(); await page.getByRole("radio", { name: /Largest/ }).click();
    await tab("Integrations").click(); await noOverflow(); await shot("large-text");
    await tab("Text & density").click(); await page.getByRole("radio", { name: /^Default/ }).first().click(); await tab("Integrations").click();
    await manage("jira", "Engineering").click();
    if (width <= 390 || height <= 540) {
      // Walk buttons using the keyboard so native scroll-into-view and the focus ring are tested.
      const buttons = page.locator(".ig-manage-view button:visible");
      for (let i = 0; i < await buttons.count(); i++) {
        await buttons.nth(i).focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
        await keyboardFocusVisible();
      }
      await shot("keyboard-short-narrow");
    }
    await back();
    let zoomTechnique = "not run in this case";
    if (width === 1440 && theme === "rider-black") {
      // Browser zoom at 200% halves its CSS viewport. Exercise that reflow without
      // changing a user's browser preference; this is not a physical text-size measurement.
      zoomTechnique = "200% browser-zoom reflow equivalent: CSS viewport halved to 720x500; browser zoom preference unchanged";
      try {
        await page.setViewportSize({ width: width / 2, height: height / 2 });
        await noOverflow(); await shot("zoom-200-overview"); await accessibility("zoom-200-overview");
        await manage("gitlab", longName).click();
        await noOverflow();
        assert.equal(await page.getByRole("heading", { name: longName, level: 2, exact: true }).isVisible(), true);
        await page.getByRole("button", { name: "Edit connection", exact: true }).focus();
        await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab"); await keyboardFocusVisible();
        await shot("zoom-200-long-manage"); await accessibility("zoom-200-long-manage");
        await back();
      } finally { await page.setViewportSize({ width, height }); }
    }
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
    results.push({ width, height, theme, tasks: "A–G pass", overview: "pass", manage: "pass", multipleConnections: "pass", focusedForms: "pass", unsavedDrafts: "pass", management: "pass", disconnect: "double-click guard, confirmation survives reading; focus/window cancellation, explicit Cancel/focus, Edit/Add/Test reset, keyboard, 503 and delayed retry pass", duplicateRequests: { test: "pass", delete: "pass", calls }, keyboard: "pass", focusTargets: width <= 390 || height <= 540 ? ">=24px, visible and unobscured" : "not separately measured", zoomTechnique, overflow: "none", accessibility: process.env.AXE_SCRIPT ? "pass" : "not run", mutations, errors });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
} finally {
  await writeFile(`${output}/browser-results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
