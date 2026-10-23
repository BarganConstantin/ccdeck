// Focused form QA. All integration/prefs traffic is fixture-only; no real writes.
// PLAYWRIGHT_MODULE and optional PLAYWRIGHT_EXECUTABLE/AXE_SCRIPT use existing installs.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an existing Playwright installation.');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const base = process.argv[2] || 'http://127.0.0.1:5186';
const output = process.env.SETTINGS_ARTIFACTS || '/tmp/ccdeck-integrations-consistency/variants';
await mkdir(output, { recursive: true });
const labels = { github: 'GitHub', gitlab: 'GitLab', jira: 'Jira' };
const providers = Object.entries(labels).map(([kind, label]) => ({ kind, label, available: true }));
const connection = (kind, id, name, baseUrl, meta = {}) => ({
  id, kind, name, baseUrl, tokenSaved: true,
  account: { id: 'reviewer', name: 'Review Developer', login: 'reviewer', avatarUrl: '' },
  meta: { checkedAt: '2026-10-23T08:00:00Z', ...meta }, allowedOrigins: [],
  createdAt: '2026-10-23T08:00:00Z', updatedAt: '2026-10-23T08:00:00Z',
});
const variants = [
  { id: 'github', kind: 'github' },
  { id: 'gitlab-cloud', kind: 'gitlab', choice: 'GitLab.com', where: 'cloud' },
  { id: 'gitlab-self', kind: 'gitlab', choice: 'Self-managed', where: 'self', url: 'https://gitlab.example.com/team' },
  { id: 'jira-cloud', kind: 'jira', choice: 'Jira Cloud', deployment: 'cloud', url: 'https://review.atlassian.net' },
  { id: 'jira-server', kind: 'jira', choice: 'Jira Server / Data Center', deployment: 'server', url: 'https://jira.example.com/jira' },
];
// A bounded sample, not every variant at every viewport.
const cases = [
  ...variants.map(variant => ({ variant, width: 1440, height: 1000, theme: 'rider-black' })),
  { variant: variants[0], width: 1440, height: 1000, theme: 'light' },
  { variant: variants[3], width: 390, height: 844, theme: 'light' },
  { variant: variants[2], width: 320, height: 740, theme: 'rider-black' },
  { variant: variants[4], width: 900, height: 540, theme: 'rider-black' },
];
const resume = process.env.SETTINGS_RESUME_CASES?.split(',');
const results = resume ? JSON.parse(await readFile(`${output}/results.json`, 'utf8')).results.filter(r => r.status === 'passed' && !resume.includes(r.case)) : [];
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
try {
  for (const { variant: v, width, height, theme } of cases) {
    const result = { case: `${v.id}-${width}x${height}-${theme}`, checks: [], axe: [], screenshots: [], blockedOutsideWrites: [], fixtureWrites: 0 };
    if (resume && !resume.includes(result.case)) continue;
    results.push(result);
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      await context.addInitScript(theme => {
        localStorage.setItem('agent-dag.theme', theme);
        localStorage.setItem('agent-dag.tourSeen', '1');
        localStorage.setItem('agent-dag.releaseNotesSeen', '3.46.0');
      }, theme);
      const page = await context.newPage();
      page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(5000);
      const pageErrors = [];
      page.on('pageerror', () => pageErrors.push('pageerror'));
      let saved = [], mode = 'missing', writes = 0, latest;
      const fixtureErrors = [];
      // Never let credentials or unexpected write operations leave this context.
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(base).origin) return route.abort();
        if (!['GET', 'HEAD'].includes(request.method())) {
          result.blockedOutsideWrites.push({ path: url.pathname, method: request.method() });
          return route.fulfill({ status: 403, json: { error: 'Outside form fixture scope' } });
        }
        return route.fallback();
      });
      await page.route('**/api/prefs', route => route.fulfill({ json: { ok: true, prefs: { recoverCodexSessions: true, recoverClaudeSessions: true, continueStopped: false } } }));
      await page.route('**/api/integrations**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (request.method() === 'GET') return route.fulfill({ json: { connections: saved, providers } });
        if (!['POST', 'PATCH'].includes(request.method()) || !/^\/api\/integrations\/connections(?:\/[^/]+)?$/.test(path)) {
          return route.fulfill({ status: 403, json: { error: 'Outside form fixture scope' } });
        }
        writes++; result.fixtureWrites++;
        try {
          const body = request.postDataJSON(), input = body.input || {};
          const field = mode === 'email-missing' ? 'email' : 'token';
          if (mode !== 'success' && mode !== 'blank-edit') {
            // This intentionally simulates server rejection; it does not test provider validation.
            assert.ok(field === 'email' ? !input.email : mode === 'missing' ? !input.token : Boolean(input.token), 'Expected credential shape');
            return await route.fulfill({ status: 400, json: { error: { kind: 'invalid', field, message: field === 'email' ? 'Enter your Atlassian account email.' : mode === 'missing' ? 'Enter a token.' : 'Enter a valid token.' } } });
          }
          assert.ok(body.name === `QA ${v.id}` || body.name === 'QA edited', 'Expected connection name');
          if (mode === 'blank-edit') {
            assert.ok(input.token === '' && !Object.hasOwn(input, 'email'), 'Blank edit sends no replacement credentials');
            assert.ok(input.deployment === 'server', 'Blank edit retains deployment');
            latest = { ...saved[0], name: body.name };
          } else {
            assert.ok(Boolean(input.token), 'New credentials present');
            if (request.method() === 'POST') assert.ok(body.kind === v.kind, 'Expected provider');
            if (v.kind === 'gitlab') assert.ok(input.where === v.where, 'Expected GitLab deployment');
            if (v.url && request.method() === 'POST') assert.ok(input.baseUrl === v.url, 'Expected URL');
            if (v.kind === 'github' || v.where === 'cloud') assert.ok(!Object.hasOwn(input, 'baseUrl'), 'Hidden URL is omitted');
            if (v.kind === 'jira') {
              const deployment = request.method() === 'PATCH' ? 'cloud' : v.deployment;
              assert.ok(input.deployment === deployment, 'Expected Jira deployment');
              if (deployment === 'cloud') assert.ok(Boolean(input.email), 'Cloud email present');
              else assert.ok(!Object.hasOwn(input, 'email'), 'Server omits Cloud credentials');
            }
            const kind = v.kind, deployment = request.method() === 'PATCH' ? 'cloud' : v.deployment;
            const meta = kind === 'jira' ? { deployment, deploymentType: deployment === 'cloud' ? 'Cloud' : 'DataCenter', serverVersion: '9.0' } : {};
            latest = connection(kind, 'fixture-saved', body.name, input.baseUrl || (kind === 'github' ? 'https://github.com' : 'https://gitlab.com'), meta);
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
          saved = [latest];
          return await route.fulfill({ json: { connection: latest, validated: mode !== 'blank-edit' } });
        } catch {
          fixtureErrors.push('Fixture payload assertion failed');
          return route.fulfill({ status: 400, json: { error: { kind: 'invalid', field: 'token', message: 'Fixture payload assertion failed.' } } });
        }
      });
      await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 5000 });
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('tab', { name: 'Integrations', exact: true }).click();
      await page.getByRole('button', { name: `Connect ${labels[v.kind]}`, exact: true }).click();
      const form = page.locator('.ig-form');
      const token = form.locator('input[type="password"]');
      const email = form.locator('input[type="email"]');
      const name = form.getByLabel('Name', { exact: false });
      const submit = form.locator('button[type="submit"]');
      if (v.choice) {
        const choice = form.getByRole('radio', { name: v.choice, exact: true });
        await choice.locator('..').click();
        assert.equal(await choice.isChecked(), true);
      }
      if (v.url) await form.locator('input[type="url"]').fill(v.url);
      if (await email.count()) await email.fill('qa@example.com');
      await name.fill(`QA ${v.id}`);
      assert.equal(await form.getByRole('heading', { level: 2, name: `Connect ${labels[v.kind]}`, exact: true }).count(), 1);
      assert.equal(await page.locator('.settings-pane-head').isVisible(), false);
      const capture = async (state, axe = false) => {
        await page.locator('[data-jumped]').waitFor({ state: 'detached' });
        const filename = `${result.case}-${state}.png`;
        await page.locator('.settings-modal').screenshot({ path: `${output}/${filename}` });
        result.screenshots.push(filename);
        const overflow = await page.locator('.settings-modal').evaluate(root => [...root.querySelectorAll('.settings-pane,.ig-form,.ig-config-view')].filter(e => e.checkVisibility()).some(e => e.scrollWidth > e.clientWidth + 1));
        assert.equal(overflow, false, 'No horizontal form overflow');
        if (axe && process.env.AXE_SCRIPT) {
          await page.addScriptTag({ path: process.env.AXE_SCRIPT });
          const report = await page.locator('.settings-modal').evaluate(async root => {
            const r = await window.axe.run(root, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
            const summarize = values => values.map(v => ({ id: v.id, impact: v.impact, count: v.nodes.length, targets: v.nodes.map(n => n.target), nodes: v.nodes.map(n => ({ target: n.target, failureSummary: n.failureSummary?.replace(/fixture-(?:invalid|new|replacement)-token|qa@example\.com/g, '[fixture credential]') })) }));
            return { violations: summarize(r.violations), incomplete: summarize(r.incomplete) };
          });
          result.axe.push({ state, ...report });
          assert.equal(report.violations.length, 0, 'No automated WCAG violations');
        }
      };
      await capture('connect', true);
      const rejected = async (expectedField, message) => {
        const prior = writes;
        await submit.click();
        await form.getByRole('alert').filter({ hasText: message }).waitFor();
        assert.equal(writes, prior + 1, 'One request per rejection');
        const field = expectedField === 'email' ? email : token;
        assert.equal(await field.getAttribute('aria-invalid'), 'true');
        assert.equal(await field.evaluate(e => e === document.activeElement), true, 'Refused field receives focus');
        const errorId = await form.getByRole('alert').getAttribute('id');
        assert.ok((await field.getAttribute('aria-describedby')).split(/\s+/).includes(errorId), 'Error described by field');
        assert.ok(await token.inputValue() === '', 'Typed token cleared');
        if (await email.count()) assert.ok(await email.inputValue() === '', 'Secret email cleared');
        assert.ok(await name.inputValue() === `QA ${v.id}`, 'Name retained');
        if (v.url) assert.ok(await form.locator('input[type="url"]').inputValue() === v.url, 'URL retained');
      };
      await rejected('token', 'Enter a token.');
      mode = 'invalid';
      await token.fill('fixture-invalid-token');
      if (await email.count()) await email.fill('qa@example.com');
      await rejected('token', 'Enter a valid token.');
      await capture('error');
      if (v.deployment === 'cloud') {
        mode = 'email-missing'; await token.fill('fixture-new-token');
        await rejected('email', 'Enter your Atlassian account email.');
      }
      mode = 'success';
      await token.fill('fixture-new-token');
      if (await email.count()) await email.fill('qa@example.com');
      const keyboardSubmit = async () => {
        const prior = writes;
        await token.press('Enter');
        await page.getByRole('button', { name: 'Checking…', exact: true }).waitFor();
        assert.equal(await submit.evaluate(e => e === document.activeElement), true, 'Keyboard submission keeps focus on Checking');
        assert.equal(await submit.getAttribute('aria-busy'), 'true');
        assert.equal(await submit.evaluate(e => e.disabled), false, 'Checking remains focusable');
        assert.equal(await token.isDisabled(), true);
        assert.equal(await submit.evaluate(e => { const r = e.getBoundingClientRect(), pane = e.closest('.settings-pane').getBoundingClientRect(); return r.top >= pane.top && r.bottom <= pane.bottom; }), true, 'Checking stays visible in pane');
        await submit.press('Enter'); await submit.press('Enter');
        await page.locator('.ig-config-view').waitFor({ state: 'detached' });
        assert.equal(writes, prior + 1, 'Busy Enter cannot duplicate submission');
      };
      await keyboardSubmit();
      assert.equal(fixtureErrors.length, 0, 'Fixture payload assertions pass');
      assert.equal(saved.length, 1);
      result.checks.push('provider heading/identity', 'missing and invalid field alerts', 'secret clearing and URL/name retention', '2-second busy keyboard focus/visibility', 'duplicate request guard', 'create payload/deployment');
      // One focused Edit case; management/disconnect coverage belongs to the full verifier.
      if (v.id === 'jira-server' && width === 1440) {
        await page.getByRole('button', { name: 'Manage Jira', exact: true }).click();
        await page.getByRole('button', { name: 'Edit connection', exact: true }).click();
        assert.equal(await token.getAttribute('aria-required'), null);
        assert.ok(await token.inputValue() === '', 'Saved secret never shown');
        assert.equal(await form.getByText('Jira connection', { exact: true }).count(), 1);
        await capture('edit', true);
        mode = 'blank-edit'; await name.fill('QA edited'); await submit.click();
        await page.locator('.ig-config-view').waitFor({ state: 'detached' });
        assert.equal(latest.tokenSaved, true);
        await page.getByRole('button', { name: 'Edit connection', exact: true }).click();
        await form.getByRole('radio', { name: 'Jira Cloud', exact: true }).locator('..').click();
        assert.equal(await token.getAttribute('aria-required'), 'true');
        assert.equal(await email.getAttribute('aria-required'), 'true');
        assert.equal(await token.getAttribute('placeholder'), 'Paste the API token');
        await name.fill(`QA ${v.id}`); mode = 'missing';
        // Deployment changes cannot reuse the saved server credential.
        await rejected('token', 'Enter a token.');
        mode = 'success'; await token.fill('fixture-replacement-token'); await email.fill('qa@example.com');
        await form.locator('input[type="url"]').fill('https://review.atlassian.net');
        await keyboardSubmit();
        assert.equal(latest.meta.deployment, 'cloud');
        assert.equal(fixtureErrors.length, 0);
        result.checks.push('blank edit retains saved credential flag', 'changed deployment requires fresh credentials', 'replacement credentials payload');
      }
      assert.equal(pageErrors.length, 0, 'No page errors');
      result.status = 'passed';
      console.log(`${result.case}: passed`);
    } catch (error) {
      result.status = 'failed';
      // Do not serialize assertion objects, HTML, request bodies, or credential values.
      result.failure = error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'Browser operation failed or timed out.';
      result.location = error.stack?.split('\n').find(line => line.includes('verify-integration-form-variants.mjs:'))?.trim();
      console.error(`${result.case}: ${result.failure}`);
      throw new Error(`${result.case}: ${result.failure}`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${output}/results.json`, JSON.stringify({ nativeBrowser: 'unavailable; isolated Playwright', persistence: 'fixture only; real API/provider/storage untested', results }, null, 2));
}
