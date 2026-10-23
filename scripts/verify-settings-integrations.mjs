// Uses an existing external Playwright installation, with no project dependency.
// Integration requests use fixtures: no real credentials or connections change.
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const modulePath = process.env.PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("Set PLAYWRIGHT_MODULE to an existing Playwright module.");
const { chromium } = await import(modulePath.startsWith("/") ? pathToFileURL(modulePath).href : modulePath);
const base = process.argv[2] || "http://127.0.0.1:5186";
const output = process.env.SETTINGS_ARTIFACTS || "/tmp/ccdeck-integrations-composition/after";
await mkdir(output, { recursive: true });
// Copy image evidence only; never consume another assessment or its detector output.
const before = process.env.SETTINGS_BEFORE_ARTIFACTS || "/tmp/ccdeck-integrations-composition/before";
const copiedBefore = [];
for (const dimensions of ["1440x1000-rider-black", "390x844-light"]) {
  for (const view of ["overview", "overview-multiple", "general-buttons", "github"]) {
    const name = `before-${view}-${dimensions}.png`;
    await copyFile(`${before}/${name}`, `${output}/${name}`);
    copiedBefore.push(name);
  }
}
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
const finalStyleOnly = process.env.SETTINGS_FINAL_STYLE_ONLY === "1";
const evidenceOnly = finalStyleOnly || process.env.SETTINGS_EVIDENCE_ONLY === "1";
const resumeCases = !evidenceOnly && process.env.SETTINGS_RESUME_CASES?.split(",");
const results = resumeCases ? JSON.parse(await readFile(`${output}/browser-results.json`, "utf8")) : [];
const styleFailures = [];
const providers = ["github", "gitlab", "jira"].map(kind => ({ kind, label: { github: "GitHub", gitlab: "GitLab", jira: "Jira" }[kind], available: true }));
const connection = (kind, id, name) => ({
  id, kind, name, baseUrl: `https://${kind}.example.com`, tokenSaved: true,
  account: { id: "reviewer", name: "Review Developer", login: "reviewer", avatarUrl: "" },
  meta: { checkedAt: "2026-10-23T08:00:00Z", ...(kind === "jira" ? { deployment: "server", deploymentType: "DataCenter", serverVersion: "9.0" } : kind === "gitlab" ? { serverVersion: "17.5.1" } : {}) },
  allowedOrigins: [], createdAt: "2026-10-23T08:00:00Z", updatedAt: "2026-10-23T08:00:00Z",
});
try {
  const cases = finalStyleOnly ? [[1440, 1000, "rider-black"], [1440, 1000, "light"]] : evidenceOnly
    ? [[900, 540, "rider-black"], [1440, 1000, "rider-black"], [1440, 1000, "light"], [390, 844, "light"], [320, 740, "rider-black"]]
    : [[1440, 1000, "rider-black"], [1440, 1000, "light"], [900, 760, "rider-black"], [900, 540, "rider-black"], [390, 844, "light"], [320, 740, "rider-black"]];
  for (const [width, height, theme] of cases) {
    if (resumeCases && !resumeCases.includes(`${width}x${height}-${theme}`)) continue;
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    await context.addInitScript(theme => {
      localStorage.setItem("agent-dag.theme", theme);
      localStorage.setItem("agent-dag.tourSeen", "1");
      localStorage.setItem("agent-dag.releaseNotesSeen", "3.46.0");
    }, theme);
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(5_000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let saved = [connection("gitlab", "gitlab", "Work projects"), connection("jira", "jira", "Engineering")];
    let refuse = false, testFails = false, failList = false, deleteFails = false, mutations = 0;
    let requestDelay = 180;
    const calls = { form: 0, test: 0, delete: 0 };
    const formChecks = [];
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
      if ((method === "POST" && path === "/api/integrations/connections") || method === "PATCH") calls.form++;
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
      const overflow = await page.locator(".settings-modal").evaluate(root => [...root.querySelectorAll(".settings-pane, .settings-list, .ig-form, .ig-summary-row, .ig-provider-view, .ig-detail-facts, .ig-leave-confirm")].filter(el => el.checkVisibility()).some(el => el.scrollWidth > el.clientWidth + 1));
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
      const incomplete = report.incomplete.map(rule => ({ id: rule.id, help: rule.help,
        nodes: rule.nodes.map(node => ({ target: node.target,
          any: node.any.map(check => ({ id: check.id, message: check.message })),
          all: node.all.map(check => ({ id: check.id, message: check.message })) })) }));
      await writeFile(`${output}/axe-${name}-${width}x${height}-${theme}.json`, JSON.stringify({ tags, engine: report.testEngine, violations: report.violations, incomplete }, null, 2));
      assert.deepEqual(report.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target) })), []);
    };
    const discard = async () => {
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      await page.locator(".ig-config-view").waitFor({ state: "detached" });
    };
    const checkFocus = async label => page.waitForFunction(label => document.activeElement?.getAttribute("aria-label") === label, label);
    const providerLabels = { github: "GitHub", gitlab: "GitLab", jira: "Jira" };
    const formLayout = async (name, kind, entering = true) => {
      const form = page.getByRole("form", { name, exact: true });
      await form.waitFor();
      assert.equal(await page.locator('.ig-settings[data-view="form"]').isVisible(), true);
      assert.equal(await page.locator(".settings-pane-head").isVisible(), false, "Forms must hide the generic pane heading and description");
      assert.equal(await page.locator(".settings-pane-head .ig-total").isVisible(), false, "Global connection count belongs only to overview");
      const heading = form.getByRole("heading", { name, exact: true, level: 2 });
      assert.equal(await heading.isVisible(), true);
      assert.equal(await page.locator('.settings-pane h2:visible').count(), 1, "One contextual h2 must head the form subpage");
      assert.equal(await form.getAttribute("aria-labelledby"), await heading.getAttribute("id"), "Form accessible name must remain the task title");
      const glyph = form.locator('.ig-managed-header > .ig-provider-glyph');
      assert.equal(await glyph.isVisible(), true);
      assert.equal(await glyph.getAttribute("aria-hidden"), "true", "Provider glyph must be decorative");
      assert.equal(await glyph.locator("svg").count(), 1);
      const identity = form.locator('.ig-managed-identity');
      if (name.startsWith("Edit ")) assert.equal(await identity.locator("p").innerText(), `${providerLabels[kind]} connection`);
      else assert.equal(await identity.locator("p").count(), 0, "Connect needs no extra introduction");
      if (entering) {
        const label = name.startsWith("Edit ") || kind !== "jira" ? "Personal access token" : "Jira URL";
        await page.waitForFunction(id => document.activeElement?.id === id, await form.getByLabel(label, { exact: true }).getAttribute("id"));
      }
      await noOverflow();
      formChecks.push({ name, provider: providerLabels[kind], enteringFocusChecked: entering, status: "pass" });
      return form;
    };
    // Provider entry points are distinct from the fully named collection rows.
    const providerManage = kind => page.locator(".ig-overview").getByRole("button", { name: `Manage ${providerLabels[kind]}`, exact: true });
    const manage = (kind, name) => page.locator(".ig-provider-view").getByRole("button", { name: `Manage ${providerLabels[kind]}: ${name} (reviewer)`, exact: true });
    const collection = page.locator('.ig-provider-view:visible');
    const collectionBack = kind => page.getByRole("button", { name: `Back to ${providerLabels[kind]} connections`, exact: true });
    const enterCollectionWithScroll = async kind => {
      const beforeClick = await page.locator(".settings-pane").evaluate(el => el.scrollTop);
      await providerManage(kind).evaluate(el => el.addEventListener("click", () => {
        window.__settingsFixtureOverviewScroll = el.closest(".settings-pane").scrollTop;
      }, { once: true, capture: true }));
      await providerManage(kind).click();
      return { beforeClick, atClick: await page.evaluate(() => window.__settingsFixtureOverviewScroll) };
    };
    const openConnection = async (kind, name) => {
      await providerManage(kind).click();
      if (saved.filter(c => c.kind === kind).length > 1) {
        await collection.waitFor();
        await manage(kind, name).click();
      }
      await page.locator('.ig-settings[data-view="connection"]').waitFor();
    };
    const back = async () => {
      const toCollection = page.getByRole("button", { name: /^Back to .+ connections$/ });
      if (await toCollection.isVisible()) await toCollection.click();
      await page.getByRole("button", { name: "All integrations", exact: true }).click();
      await page.locator('.ig-settings[data-view="overview"]').waitFor();
    };
    const toolbarAdd = kind => page.locator(".ig-provider-view:visible, .ig-manage-view:visible").getByRole("button", { name: `Add ${providerLabels[kind]} connection`, exact: true });
    const cancelAdd = async (kind, origin) => {
      await toolbarAdd(kind).click();
      const form = await formLayout(`Connect ${providerLabels[kind]}`, kind);
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.locator(".ig-config-view").waitFor({ state: "detached" });
      await page.locator(`.ig-settings[data-view="${origin}"]`).waitFor();
      assert.equal(await toolbarAdd(kind).evaluate(el => el === document.activeElement), true, "Cancel Add must restore its origin toolbar focus");
    };
    const collectionLayout = async kind => {
      await page.locator('.ig-settings[data-view="provider"]').waitFor();
      const heading = collection.getByRole("heading", { name: `${providerLabels[kind]} connections`, exact: true, level: 2 });
      await heading.waitFor();
      assert.equal(await page.locator(".settings-pane-head").isVisible(), false, "Provider collection must hide the overview heading and count");
      assert.equal(await page.locator(".ig-overview").isVisible(), false);
      assert.equal(await collection.getByRole("button", { name: "All integrations", exact: true }).isVisible(), true);
      assert.equal(await toolbarAdd(kind).isVisible(), true);
      for (const conn of saved.filter(c => c.kind === kind)) assert.equal(await manage(kind, conn.name).isVisible(), true);
      await noOverflow();
    };
    const controlGeometry = locator => locator.evaluate(el => {
      const style = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, radius: style.borderTopLeftRadius,
        paddingStart: style.paddingInlineStart, paddingEnd: style.paddingInlineEnd };
    });
    const overviewContract = async () => {
      await page.locator('.ig-settings[data-view="overview"]').waitFor();
      await page.mouse.move(0, 0);
      assert.deepEqual(await page.locator(".ig-provider h3").allTextContents(), ["GitHub", "GitLab", "Jira"]);
      assert.equal(await page.locator('.ig-overview').getByRole('button', { name: /Add/i }).count(), 0, "Add belongs only inside management");
      for (const kind of ["github", "gitlab", "jira"]) {
        const row = page.locator(`#ig-provider-${kind}`), button = row.getByRole("button");
        assert.equal(await button.count(), 1, `${kind}: exactly one provider action`);
        const label = `${saved.some(c => c.kind === kind) ? "Manage" : "Connect"} ${providerLabels[kind]}`;
        assert.equal(await button.getAttribute("aria-label"), label);
        const geometry = await row.evaluate(el => {
          const button = el.querySelector("button"), glyph = el.querySelector(".ig-provider-glyph"), text = el.querySelector(".ig-summary-text");
          const b = button.getBoundingClientRect(), g = glyph?.getBoundingClientRect(), t = text?.getBoundingClientRect();
          return { glyph: Boolean(glyph?.querySelector("svg")), stack: Boolean(text?.querySelector("h3")),
            centered: t && Math.abs(b.y + b.height / 2 - t.y - t.height / 2) <= 2 };
        });
        assert.ok(geometry.glyph && geometry.stack && geometry.centered, `${kind}: glyph and text stack must exist, with the action centered on the text stack (${JSON.stringify(geometry)})`);
        assert.equal(await button.evaluate(el => el.classList.contains("primary")), label.startsWith("Connect"));
        if (label.startsWith("Manage")) {
          assert.equal(await button.evaluate(el => el.matches('.btn.ig-manage')), true);
          const neutral = await button.evaluate(async el => {
            await Promise.all(el.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
            const probe = document.createElement("span"); probe.style.backgroundColor = "var(--ctl-fill)"; el.append(probe);
            const expected = getComputedStyle(probe).backgroundColor; probe.remove();
            return { expected, actual: getComputedStyle(el).backgroundColor };
          });
          // Keep the final gate strict while collecting all flow evidence in one pass.
          if (neutral.actual !== neutral.expected) styleFailures.push({ width, height, theme, label, ...neutral });
        }
        assert.deepEqual(await controlGeometry(button), { height: 30, radius: "6px", paddingStart: "12px", paddingEnd: "12px" });
      }
      const actionWidths = await page.locator('.ig-provider > button').evaluateAll(nodes => nodes.map(el => ({ label: el.getAttribute("aria-label"), width: el.getBoundingClientRect().width })));
      assert.ok(actionWidths.length === 3 && Math.max(...actionWidths.map(b => b.width)) - Math.min(...actionWidths.map(b => b.width)) <= 0.5,
        `Provider actions must share the intrinsic column width: ${JSON.stringify(actionWidths)}`);
      assert.equal(await page.locator('.settings-pane-head .ig-total').count(), 1);
      assert.equal(await page.locator('.settings-pane-head .ig-total').isVisible(), true);
      assert.equal(await page.locator('.ig-overview-info .ig-total').count(), 0, "Count must be detached from security help");
      assert.equal((await page.locator('.settings-pane-head .ig-total').innerText()).trim(), `${saved.length} saved connection${saved.length === 1 ? "" : "s"}`);
      await noOverflow();
    };
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
    if (finalStyleOnly) {
      // Read-only computed proof for the final corrected CSS. No gallery or flows rerun.
      const samples = [];
      const sample = async (locator, state, fillToken, borderToken) => {
        const computed = await locator.evaluate(async (el, tokens) => {
          await Promise.all(el.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
          const style = getComputedStyle(el);
          const resolve = (property, token) => {
            const probe = document.createElement("span"); probe.style[property] = `var(${token})`; el.append(probe);
            const value = getComputedStyle(probe)[property]; probe.remove(); return value;
          };
          return { label: el.getAttribute("aria-label") || el.textContent.trim(), classes: el.className,
            fill: style.backgroundColor, expectedFill: resolve("backgroundColor", tokens.fill),
            border: style.borderTopColor, expectedBorder: resolve("color", tokens.border),
            width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
            radius: style.borderTopLeftRadius, padding: [style.paddingInlineStart, style.paddingInlineEnd], fontWeight: style.fontWeight,
            runningAnimations: el.getAnimations().filter(a => a.playState === "running" || a.playState === "pending").length,
            focused: el === document.activeElement, focusVisible: el.matches(":focus-visible"), outline: style.outlineStyle };
        }, { fill: fillToken, border: borderToken });
        assert.equal(computed.runningAnimations, 0, `${state}: sample must be settled`);
        assert.equal(computed.fill, computed.expectedFill, `${state}: correct settled fill`);
        assert.equal(computed.border, computed.expectedBorder, `${state}: correct settled border`);
        assert.equal(computed.height, 30); assert.equal(computed.radius, "6px");
        assert.deepEqual(computed.padding, ["12px", "12px"]);
        samples.push({ state, ...computed }); return computed;
      };
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Settings", exact: true }).click(); await tab("Integrations").click();
      await page.getByRole("heading", { name: "Integrations", exact: true, level: 2 }).click(); await page.mouse.move(0, 0);
      await overviewContract();
      const connect = page.getByRole("button", { name: "Connect GitHub", exact: true });
      const rest = await sample(connect, "Connect GitHub rest", "--accent-dim", "--accent");
      await sample(providerManage("gitlab"), "Manage GitLab rest", "--ctl-fill", "--ctl-edge");
      await sample(providerManage("jira"), "Manage Jira rest", "--ctl-fill", "--ctl-edge");
      await connect.hover();
      const hover = await sample(connect, "Connect GitHub hover", "--accent-dim", "--text");
      assert.notEqual(hover.border, rest.border); assert.equal(hover.fill, rest.fill);
      await providerManage("gitlab").hover(); await sample(providerManage("gitlab"), "Manage GitLab hover", "--ctl-fill", "--text");
      await page.mouse.move(0, 0); await providerManage("gitlab").focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
      await keyboardFocusVisible();
      const focus = await sample(providerManage("gitlab"), "Manage GitLab keyboard focus", "--ctl-fill", "--ctl-edge");
      assert.ok(focus.focused && focus.focusVisible && focus.outline !== "none");
      // Fixture-only GET refresh reproduces primary -> neutral without submitting a form.
      saved.push(connection("github", "github-settled-proof", "Read-only fixture GitHub"));
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await providerManage("github").waitFor(); await overviewContract();
      await sample(providerManage("github"), "Manage GitHub after Connect-to-Manage transition settled", "--ctl-fill", "--ctl-edge");
      assert.equal(mutations, 0); assert.deepEqual(errors, []);
      results.push({ width, height, theme, status: "pass", samples, styleFailures: styleFailures.filter(f => f.width === width && f.theme === theme), mutations, errors });
      console.log(JSON.stringify({ phase: "final settled desktop styles", theme, status: "pass", samples: samples.length, mutations }));
      await context.close(); continue;
    }
    if (evidenceOnly) {
      // One bounded refresh after the final CSS batch; do not repeat all mutations.
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "Open Browser Watch", exact: true }).scrollIntoViewIfNeeded();
      await shot("general-buttons"); await tab("Integrations").click();
      await overviewContract();
      await page.getByRole("heading", { name: "Integrations", exact: true, level: 2 }).click();
      await page.mouse.move(0, 0);
      assert.equal(await page.locator('.ig-provider > button').evaluateAll(nodes => nodes.some(el => el === document.activeElement)), false);
      await shot("overview-rest"); await shot("overview");
      const connect = page.getByRole("button", { name: "Connect GitHub", exact: true });
      const geometry = await controlGeometry(connect);
      const rest = await connect.evaluate(el => ({ border: getComputedStyle(el).borderTopColor, fill: getComputedStyle(el).backgroundColor }));
      await connect.hover();
      await page.waitForFunction(previous => {
        const el = document.querySelector('[aria-label="Connect GitHub"]');
        return getComputedStyle(el).borderTopColor !== previous;
      }, rest.border);
      await shot("connect-hover");
      const hovered = await connect.evaluate(el => ({ border: getComputedStyle(el).borderTopColor, fill: getComputedStyle(el).backgroundColor }));
      assert.notEqual(hovered.border, rest.border, "Primary Connect hover must visibly change its border");
      assert.equal(hovered.fill, rest.fill, "Primary Connect hover keeps its accent wash");
      await providerManage("gitlab").hover(); await shot("manage-hover");
      await providerManage("gitlab").focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
      await keyboardFocusVisible(); await checkFocus("Manage GitLab"); await shot("manage-keyboard-focus");
      await connect.click();
      const connectForm = await formLayout("Connect GitHub", "github");
      assert.deepEqual(await controlGeometry(connectForm.getByRole("button", { name: "Connect", exact: true })), geometry);
      await shot("github"); await connectForm.getByRole("button", { name: "Cancel", exact: true }).click();
      await openConnection("gitlab", "Work projects"); await managementLayout("Work projects");
      await shot("gitlab-manage-add"); await shot("manage-gitlab"); await back();
      const extra = connection("gitlab", "gitlab-photo-extra", longName);
      extra.baseUrl = "https://source-control.engineering-and-platform-development.example.com";
      extra.account.name = longAccount; saved.push(extra, connection("github", "github-photo", "Review github"));
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.locator("#ig-provider-gitlab").getByText("2 saved connections", { exact: true }).waitFor();
      await overviewContract(); await shot("multiple-overview");
      const scroll = await enterCollectionWithScroll("gitlab");
      await collectionLayout("gitlab"); await shot("multiple-collection");
      await cancelAdd("gitlab", "provider"); await back(); await checkFocus("Manage GitLab");
      const restored = await page.locator(".settings-pane").evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
      scroll.afterBack = restored.top; scroll.maxAfterBack = restored.max;
      console.log(JSON.stringify({ phase: "collection-scroll", width, height, theme, ...scroll }));
      assert.ok(Math.abs(scroll.afterBack - Math.min(scroll.atClick, scroll.maxAfterBack)) <= 1, `Collection Back must preserve click-time overview scroll within the remaining content bounds: ${JSON.stringify(scroll)}`);
      await providerManage("gitlab").click(); await manage("gitlab", longName).click(); await managementLayout(longName); await shot("long-manage");
      const themeCatalogScreenshots = [];
      if (width === 1440 && theme === "rider-black") {
        await back(); await tab("Appearance").click();
        const ids = await page.locator("[data-theme-choice]").evaluateAll(nodes => nodes.map(node => node.dataset.themeChoice));
        for (const id of ids) {
          await tab("Appearance").click(); await page.locator(`[data-theme-choice="${id}"]`).click();
          await page.waitForFunction(id => document.documentElement.dataset.theme === id, id);
          await tab("Integrations").click();
          await page.getByRole("heading", { name: "Integrations", exact: true, level: 2 }).click();
          await page.mouse.move(0, 0); await noOverflow(); await shot(`overview-theme-${id}`);
          themeCatalogScreenshots.push(id);
        }
      }
      assert.deepEqual(errors, []);
      results.push({ evidenceOnly: true, themeCatalogScreenshots, width, height, theme, overview: "one action/provider; equal intrinsic widths; primary/neutral geometry checked", connectHover: { rest, hovered }, nativeBrowser: "unavailable this turn (parent-reported timeout)", styleFailures: styleFailures.filter(f => f.width === width && f.height === height && f.theme === theme), mutations });
      console.log(JSON.stringify(results.at(-1))); await context.close(); continue;
    }
    // Task A — stable shell and exactly one contextual action per provider.
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Open Browser Watch", exact: true }).scrollIntoViewIfNeeded();
    await shot("general-buttons");
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
    await page.getByRole("heading", { name: "Integrations", exact: true, level: 2 }).click(); await page.mouse.move(0, 0);
    await shot("overview-rest"); await shot("overview");
    await overviewContract();
    const overviewConnectGeometry = await controlGeometry(page.getByRole("button", { name: "Connect GitHub", exact: true }));
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).hover();
    await shot("connect-hover");
    await providerManage("gitlab").hover(); await shot("manage-hover");
    // Enter keyboard modality through actual traversal, not a synthetic CSS class.
    await providerManage("gitlab").focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    await keyboardFocusVisible(); await checkFocus("Manage GitLab"); await shot("manage-keyboard-focus");
    await page.mouse.move(0, 0);
    const providerBounds = await page.locator(".ig-providers").boundingBox();
    const securityBounds = await page.locator(".ig-access").boundingBox();
    assert.ok(securityBounds.y >= providerBounds.y + providerBounds.height, "Security help belongs below the full provider list");
    await accessibility("overview");
    // Task B — focused Manage title, shared geometry and factual metadata.
    await openConnection("gitlab", "Work projects");
    const details = page.locator(".ig-connection-details");
    await managementLayout("Work projects");
    assert.equal(await collection.count(), 0, "One saved connection must open details without a chooser");
    assert.equal(await page.getByRole("button", { name: "All integrations", exact: true }).isVisible(), true);
    await shot("gitlab-manage-add");
    assert.equal(await page.locator(".ig-overview").isVisible(), false);
    assert.equal(await page.getByRole("heading", { name: "Work projects", exact: true }).evaluate(el => el === document.activeElement), true);
    await cancelAdd("gitlab", "connection");
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
    await checkFocus("Manage GitLab");
    await openConnection("jira", "Engineering");
    await managementLayout("Engineering");
    await shot("manage-jira"); await accessibility("manage-jira");
    assert.match(await details.innerText(), /Jira Data Center 9.0/);
    await page.keyboard.press("Escape");
    await checkFocus("Manage Jira");

    // Task C — empty Connect, validation, unsaved inputs, and creation.
    await page.getByRole("button", { name: "Connect GitHub", exact: true }).click();
    let form = await formLayout("Connect GitHub", "github");
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).evaluate(el => el === document.activeElement), true);
    assert.equal(await form.getByRole("button", { name: "Connect", exact: true }).evaluate(el => el.matches('.btn.primary')), true);
    assert.deepEqual(await controlGeometry(form.getByRole("button", { name: "Connect", exact: true })), overviewConnectGeometry, "Overview Connect must share form control geometry");
    await shot("github"); await accessibility("github");
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await tab("General").click();
    await page.getByRole("button", { name: "Keep editing", exact: true }).waitFor();
    assert.equal(await tab("Integrations").getAttribute("aria-selected"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await form.getByLabel("Personal access token", { exact: true }).inputValue(), "review-fixture");
    refuse = true;
    requestDelay = 2_000;
    const formsBefore = calls.form;
    const tokenInput = form.getByLabel("Personal access token", { exact: true });
    await tokenInput.focus(); await tokenInput.press("Enter");
    const checking = form.getByRole("button", { name: "Checking…", exact: true });
    await checking.waitFor();
    assert.equal(await checking.evaluate(el => el.disabled), false, "Busy submit must remain natively enabled to retain focus");
    assert.equal(await checking.getAttribute("aria-disabled"), "true");
    assert.equal(await checking.getAttribute("aria-busy"), "true");
    assert.equal(await checking.evaluate(el => el === document.activeElement), true, "Enter from the token field must transfer focus to Checking");
    await keyboardFocusVisible();
    assert.equal(await tokenInput.isDisabled(), true);
    assert.equal(await tokenInput.inputValue(), "", "Submitted secret must be cleared immediately");
    await page.keyboard.press("Enter");
    await checking.evaluate(el => { el.click(); el.click(); el.form.requestSubmit(el); });
    await form.getByRole("alert").waitFor();
    assert.equal(calls.form, formsBefore + 1, "Repeated submit while busy must issue exactly one form request");
    assert.equal(await tokenInput.inputValue(), "");
    assert.equal(await tokenInput.evaluate(el => el === document.activeElement), true, "Field refusal must restore focus to the token input");
    assert.equal((await form.getByRole("alert").innerText()).includes("review-fixture"), false, "Feedback must never echo the submitted token");
    await formLayout("Connect GitHub", "github", false);
    await shot("field-error"); await accessibility("field-error");
    refuse = false; requestDelay = 180;
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    assert.equal(await form.getByRole("button", { name: "Cancel", exact: true }).isDisabled(), true);
    await providerManage("github").waitFor();
    await checkFocus("Manage GitHub");
    await openConnection("github", "Review github");
    await details.getByRole("status").filter({ hasText: "Connection saved and tested as Review Developer." }).waitFor();
    await back();

    // Task D — toolbar Add, multiple connections, long names and Edit.
    await openConnection("gitlab", "Work projects");
    await toolbarAdd("gitlab").click();
    form = await formLayout("Connect GitLab", "gitlab");
    await form.getByLabel("Self-managed", { exact: true }).focus(); await page.keyboard.press("Space");
    await form.getByLabel("GitLab URL", { exact: true }).fill("https://source-control.engineering-and-platform-development.example.com");
    await form.getByLabel("Personal access token", { exact: true }).fill("review-fixture");
    await form.getByLabel("Name", { exact: false }).fill(longName);
    await shot("gitlab"); await noOverflow(); await accessibility("gitlab");
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await providerManage("gitlab").waitFor();
    await checkFocus("Manage GitLab");
    assert.equal(saved.filter(c => c.kind === "gitlab").length, 2);
    await overviewContract(); await shot("multiple-overview");
    const overviewScroll = await enterCollectionWithScroll("gitlab");
    await collectionLayout("gitlab");
    assert.equal(await collection.getByRole("heading", { name: "GitLab connections", exact: true }).evaluate(el => el === document.activeElement), true);
    await shot("multiple-collection"); await accessibility("multiple-collection");
    await cancelAdd("gitlab", "provider");
    await back(); await checkFocus("Manage GitLab");
    // Entering management clears the transient success notice; the shorter
    // overview may legitimately clamp the saved scroll to its new maximum.
    const restoredScroll = await page.locator(".settings-pane").evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    assert.ok(Math.abs(restoredScroll.top - Math.min(overviewScroll.atClick, restoredScroll.max)) <= 1,
      `Collection Back preserves click-time overview scroll within content bounds: ${JSON.stringify({ ...overviewScroll, restoredScroll })}`);
    await providerManage("gitlab").click(); await manage("gitlab", longName).click();
    await managementLayout(longName);
    assert.match(await fact("Account").innerText(), new RegExp(`${longAccount}.*reviewer`));
    await noOverflow(); await shot("long-manage"); await accessibility("long-manage");
    await collectionBack("gitlab").click(); await collectionLayout("gitlab");
    await checkFocus(`Manage GitLab: ${longName} (reviewer)`);
    await manage("gitlab", "Work projects").click();
    await page.getByRole("button", { name: "Edit connection", exact: true }).click();
    form = await formLayout("Edit Work projects", "gitlab");
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
    form = await formLayout("Edit Work sources", "gitlab");
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
    await formLayout("Edit Work sources", "gitlab");
    await page.getByRole("form", { name: "Edit Work sources", exact: true }).getByRole("button", { name: "Cancel", exact: true }).click();
    await page.locator(".ig-config-view").waitFor({ state: "detached" });
    assert.equal(await disconnect().isVisible(), true, "Returning from Edit must clear the old armed state");
    assert.equal(await confirmDisconnect().count(), 0);
    await disconnect().click(); await toolbarAdd("gitlab").click();
    await formLayout("Connect GitLab", "gitlab");
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
    await collection.waitFor();
    await page.locator('.ig-settings[data-view="provider"]').waitFor();
    assert.equal(await manage("gitlab", longName).isVisible(), true);
    await checkFocus(`Manage GitLab: ${longName} (reviewer)`);
    assert.equal(await collection.getByRole("button", { name: /^Manage GitLab:/ }).count(), 1);
    await shot("multiple-after-delete");
    await back(); await checkFocus("Manage GitLab");
    requestDelay = 180;

    // Task G — Jira variants, search, leave guards, unavailable providers and adaptation.
    await openConnection("jira", "Engineering");
    await toolbarAdd("jira").click();
    form = await formLayout("Connect Jira", "jira");
    await shot("jira-server");
    await form.getByLabel("Jira Cloud", { exact: true }).focus(); await page.keyboard.press("Space");
    await form.getByLabel("Site URL", { exact: true }).fill("review-team.atlassian.net");
    await form.getByLabel("Atlassian account email", { exact: true }).fill("reviewer@example.com");
    await formLayout("Connect Jira", "jira", false);
    await shot("jira"); await accessibility("jira");
    await form.getByRole("button", { name: "Cancel", exact: true }).click(); await discard();
    assert.equal(await page.locator(".ig-manage-view").isVisible(), true);
    await page.getByRole("button", { name: "Edit connection", exact: true }).click();
    await formLayout("Edit Engineering", "jira");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".ig-manage-view").isVisible(), true);
    await page.keyboard.press("Escape");
    await checkFocus("Manage Jira");
    const search = page.getByRole("combobox", { name: "Search settings" });
    for (const label of ["GitHub", "GitLab", "Jira"]) {
      await search.fill(label); await search.press("ArrowDown"); await search.press("ArrowUp"); await search.press("Enter");
      assert.equal(await page.locator(".ig-overview").isVisible(), true);
    }
    await openConnection("jira", "Engineering");
    await page.keyboard.press("Control+f"); await search.fill("GitLab"); await search.press("Enter");
    assert.equal(await page.locator(".ig-overview").isVisible(), true);
    await openConnection("jira", "Engineering");
    await page.getByRole("button", { name: "Edit connection", exact: true }).click();
    await formLayout("Edit Engineering", "jira");
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
    await openConnection("jira", "Engineering");
    assert.equal(await page.getByRole("button", { name: "Edit connection", exact: true }).count(), 0);
    assert.equal(await toolbarAdd("jira").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Test connection", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Disconnect Engineering", exact: true }).isVisible(), true);
    await noOverflow(); await shot("unavailable");
    await back();
    // Known unavailable providers keep one overview entry and safe collection access.
    saved.push(connection("jira", "jira-unavailable-extra", "Archived Jira"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator("#ig-provider-jira").getByText("2 saved connections", { exact: true }).waitFor();
    assert.equal(await page.locator("#ig-provider-jira").getByRole("button").count(), 1);
    await providerManage("jira").click(); await collection.waitFor();
    assert.equal(await toolbarAdd("jira").count(), 0);
    await manage("jira", "Archived Jira").click();
    assert.equal(await details.getByRole("button", { name: "Test connection", exact: true }).count(), 0);
    assert.equal(await details.getByRole("button", { name: "Edit connection", exact: true }).count(), 0);
    assert.equal(await toolbarAdd("jira").count(), 0);
    await back();
    saved = saved.filter(c => c.id !== "jira-unavailable-extra");
    providers.find(p => p.kind === "jira").available = true;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await page.locator("#ig-provider-jira").waitFor();
    await tab("Text & density").click(); await page.getByRole("radio", { name: /Largest/ }).click();
    await tab("Integrations").click(); await noOverflow(); await shot("large-text");
    await tab("Text & density").click(); await page.getByRole("radio", { name: /^Default/ }).first().click(); await tab("Integrations").click();
    await openConnection("jira", "Engineering");
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
        await openConnection("gitlab", longName);
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
        await openConnection("jira", "Engineering"); await accessibility(`manage-theme-${id}`); await back();
      }
      results.push({ themeCatalog: themes, accessibility: process.env.AXE_SCRIPT ? "zero violations; incomplete checks recorded for manual review" : "not run" });
    }
    // Removal after entering a collection must preserve that context until empty.
    saved.push(connection("gitlab", "gitlab-final-extra", "Temporary GitLab"));
    // Direct fixture edits need a fresh client snapshot; visibility refresh may
    // share an in-flight read that captured the previous fixture collection.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await tab("Integrations").click();
    await page.locator("#ig-provider-gitlab").getByText("2 saved connections", { exact: true }).waitFor();
    await providerManage("gitlab").click(); await collectionLayout("gitlab");
    for (const name of ["Temporary GitLab", longName]) {
      await manage("gitlab", name).click();
      await details.getByRole("button", { name: `Disconnect ${name}`, exact: true }).click();
      await page.waitForTimeout(450);
      await details.getByRole("button", { name: `Confirm disconnecting ${name}`, exact: true }).press("Enter");
      await page.locator(".ig-manage-view").waitFor({ state: "detached" });
      if (name === "Temporary GitLab") {
        await collection.waitFor(); await checkFocus(`Manage GitLab: ${longName} (reviewer)`);
      } else {
        await checkFocus("Connect GitLab");
        assert.equal(await page.locator('.ig-settings[data-view="overview"]').isVisible(), true);
      }
    }
    await openConnection("github", "Review github");
    await details.getByRole("button", { name: "Disconnect Review github", exact: true }).click();
    await page.waitForTimeout(450);
    await details.getByRole("button", { name: "Confirm disconnecting Review github", exact: true }).press("Space");
    await checkFocus("Connect GitHub"); await overviewContract();
    // Unknown, stranded kinds retain their full per-connection fallback name.
    saved.push(connection("legacy", "legacy-review", "Legacy tracker"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const legacy = page.getByRole("button", { name: "Manage legacy: Legacy tracker (reviewer)", exact: true });
    await legacy.click();
    assert.equal(await details.getByRole("button", { name: "Disconnect Legacy tracker", exact: true }).isVisible(), true);
    assert.equal(await details.getByRole("button", { name: /Test connection|Edit connection|Add / }).count(), 0);
    await back();
    await page.keyboard.press("Escape"); await page.locator(".settings-modal").waitFor({ state: "detached" });
    assert.equal(await page.getByRole("button", { name: "Settings", exact: true }).evaluate(el => el === document.activeElement), true);
    assert.deepEqual(errors, []);
    results.push({ newFormQA: { status: "pass", forms: formChecks, keyboardSubmit: "Enter from token: focused native-enabled Checking action, aria-disabled/busy, visible focus, immediate secret clearing, one request despite duplicate submits, error focus returns to token, feedback omits token" }, copiedBefore, styleFailures: styleFailures.filter(f => f.width === width && f.height === height && f.theme === theme), width, height, theme, tasks: "A–G pass", overview: "pass", manage: "pass", multipleConnections: "one provider entry, explicit collection, context Add/Cancel/Back and deletion focus pass", focusedForms: "pass", unsavedDrafts: "pass", management: "pass", disconnect: "double-click guard, confirmation survives reading; focus/window cancellation, explicit Cancel/focus, Edit/Add/Test reset, keyboard, 503 and delayed retry pass", duplicateRequests: { test: "pass", delete: "pass", calls }, keyboard: "pass", focusTargets: width <= 390 || height <= 540 ? ">=24px, visible and unobscured" : "not separately measured", zoomTechnique, overflow: "none", accessibility: process.env.AXE_SCRIPT ? "zero violations; incomplete checks recorded for manual review" : "not run", mutations, errors });
    console.log(JSON.stringify(results.at(-1)));
    await context.close();
  }
  assert.deepEqual(styleFailures, [], "Manage resting backgrounds must resolve to --ctl-fill; see per-case evidence");
} finally {
  const report = finalStyleOnly ? {
    phase: "FINAL corrected CSS: settled read-only desktop computed styles",
    capturedAt: new Date().toISOString(), status: results.length === 2 && styleFailures.length === 0 ? "pass" : "partial or failed",
    method: "Await target finite animations; verify zero running animations before computed-style comparison. Fixture GET refresh only; no screenshots or functional flows rerun.",
    historicalReports: {
      "browser-results.json": "HISTORY: combined six functional passes; first dark case retains pre-cascade-fix transparent-background samples. Unchanged by this verification.",
      "evidence-refresh-results.json": "HISTORY: gallery refresh sampled intermediate primary-to-neutral interpolation frames before settled-helper correction. Unchanged by this verification."
    }, cases: results, styleFailures
  } : results;
  await writeFile(`${output}/${finalStyleOnly ? "final-style-evidence" : evidenceOnly ? "evidence-refresh-results" : "browser-results"}.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
