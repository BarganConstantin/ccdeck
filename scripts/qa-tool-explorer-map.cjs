// Isolated fixtures only. External Playwright harness; no journal writes.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { make, base, row } = require('./qa-tool-explorer.cjs');
const out = path.resolve(__dirname, '../.impeccable/review/tool-explorer-v3');
fs.mkdirSync(out, { recursive: true });
const sizes = [[1440,900],[1280,950],[1024,768],[800,600],[390,844],[320,568]];
async function open(page, width) {
  if (width <= 640) { await page.getByRole('button', { name: /^More:/ }).click(); await page.getByRole('menuitem', { name: 'Tool activity', exact: true }).click(); }
  else await page.getByRole('button', { name: 'Tool activity', exact: true }).click();
  await page.locator('.ta-map-svg').waitFor();
  await page.waitForTimeout(250);
}
async function run() {
  const browser = await chromium.launch({ ...(process.env.CCDECK_QA_BROWSER ? { executablePath: process.env.CCDECK_QA_BROWSER } : {}), headless: true });
  try {
    for (const [width, height] of sizes) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let mode = 'normal';
      await page.addInitScript(() => {
        for (const [key,value] of Object.entries({ usagePanelOpen:'0', machinePanelOpen:'0', accountsPanelOpen:'0', sessionListOpen:'0', tourSeen:'1', releaseNotesSeen:'3.40.2', theme:'rider-black' })) localStorage.setItem('agent-dag.'+key,value);
        window.EventSource = class extends EventTarget { constructor() { super(); setTimeout(() => { this.dispatchEvent(new Event('open')); this.dispatchEvent(new Event('replay-end')); },100); } close() {} };
      });
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url()); let json = { ok:true };
        if (url.pathname === '/api/tool-audit') {
          const provider = url.searchParams.get('provider');
          json = make(url.searchParams.get('operation'), mode, 'all');
          if (mode === 'dense') json.rows = [...base, ...Array.from({ length:200 }, (_,i) => row(`operation_${i}`, 2, 200))];
          if (mode === 'missing') json.rows = json.rows.map(row => ({ ...row, medianMs:null, p95Ms:null, measured:0 }));
          if (provider !== 'all') {
            json.rows = json.rows.map(row => ({ ...row, calls:row.providers[provider], providers:{ claude:0, codex:0, [provider]:row.providers[provider] } }));
            json.providers[provider === 'claude' ? 'codex' : 'claude'] = { calls:0, measured:0, failed:0 };
          }
          if (json.details) { const selected = json.rows.find(row => row.operation === json.details.operation); json.details.total = selected.calls; for (const key of ['recent','slowest']) json.details[key] = json.details[key].map(call => ({...call, durationMs:selected.maxMs, timingSource:provider === 'claude' ? 'claude-hook-receipt' : 'codex-rollout-source', shared:selected.shared>0})); }
        } else if (url.pathname === '/api/health') json = { ok:true, providers:{ claude:true, codex:true } };
        else if (url.pathname.includes('quota') || url.pathname === '/api/ccusage') json = { ok:false };
        await route.fulfill({ json });
      });
      await page.goto(process.env.CCDECK_QA_URL || 'http://127.0.0.1:4545', { waitUntil:'domcontentloaded' });
      await open(page,width);
      const capture = async name => { await page.mouse.move(0,0); await page.screenshot({ path:`${out}/${name}-${width}-${height}.png` }); };
      const geometry = await page.locator('.ta-modal').evaluate(element => ({ width:element.scrollWidth-element.clientWidth, box:element.getBoundingClientRect().toJSON() }));
      assert(geometry.width < 2 && geometry.box.x >= 0 && geometry.box.right <= width+1 && geometry.box.bottom <= height+1);
      assert.equal(await page.locator('.ta-inspector').count(),0);
      await capture('overview');
      const rg = page.locator("[data-map-members*= '\"rg\"']");
      await rg.hover();if(!(await rg.getAttribute('data-map-operation')))await page.locator('.ta-map-member').filter({has:page.getByText('rg',{exact:true})}).hover();
      await page.getByRole('region',{name:'Map point details'}).waitFor();
      assert.equal(await page.locator('[data-operation="rg"]').getAttribute('data-hovered'),'true');
      const tooltip = await page.locator('.ta-map-tooltip').boundingBox();
      assert(tooltip.x >= 0 && tooltip.x+tooltip.width <= width+1 && tooltip.y >= 0 && tooltip.y+tooltip.height <= height+1);
      await page.screenshot({ path:`${out}/hover-${width}-${height}.png` });
      await page.getByRole('button',{name:'Dismiss point details',exact:true}).click();
      await rg.focus(); await page.keyboard.press('Enter');if(!(await rg.getAttribute('data-map-operation'))){await page.locator('.ta-map-member').filter({has:page.getByText('rg',{exact:true})}).focus();await page.keyboard.press('Enter');}
      await page.locator('.ta-inspector h3').waitFor();
      await page.waitForFunction(() => document.activeElement.id === 'tool-operation-heading');
      assert.equal(await page.locator('.ta-inspector h3').textContent(),'rg');
      assert((await page.locator('[data-map-members][data-active]').count()) > 0);
      await capture('selected');
      await page.getByRole('button',{name:'Refresh tool report',exact:true}).click();
      await page.locator('.ta-inspector h3').waitFor(); assert.equal(await page.locator('.ta-inspector h3').textContent(),'rg');
      await page.getByRole('button',{name:'Close operation details',exact:true}).click();
      await page.waitForFunction(() => document.activeElement.classList.contains('ta-map-node') || document.activeElement.dataset.operation === 'rg');
      await page.getByLabel('Map interval',{exact:true}).selectOption('p95Ms');
      assert.equal(await page.locator('[data-map-operation="npm run build"]').count(),0);
      assert((await page.locator('.ta-map-excluded summary').textContent()).includes('not plotted'));
      await capture('p95-map');
      await page.getByLabel('Map interval',{exact:true}).selectOption('medianMs');
      await page.getByLabel('Y scale',{exact:true}).selectOption('log');
      assert((await page.locator('.ta-map-svg').getAttribute('aria-label')).includes('zero included'));
      assert.equal(await page.locator('[data-map-operation="Read"]').count(),1);
      await capture('log-map');
      await page.getByLabel('Find an operation',{exact:true}).fill('git');
      assert((await page.locator('[data-map-members][data-dim]').count())>0);
      await capture('search');
      await page.getByLabel('Find an operation',{exact:true}).fill('nothing matches');
      assert((await page.locator('.ta-map-legend').textContent()).includes('0 search matches'));
      await page.getByLabel('Find an operation',{exact:true}).fill('');
      await page.getByLabel('Provider',{exact:true}).selectOption('claude');
      await page.waitForFunction(() => !document.querySelector('.ta-map-scope')?.textContent.includes('Mixed'));
      await capture('provider');
      await page.getByLabel('Provider',{exact:true}).selectOption('all');
      await page.waitForFunction(() => document.querySelector('.ta-map-scope')?.textContent.includes('Mixed'));
      if (width <= 600) await page.getByRole('button',{name:'Operations',exact:true}).click();
      for (const [metric, name] of [['totalMs','cumulative'],['p95Ms','p95-ranking'],['failed','failures']]) {
        await page.getByLabel('Rank by',{exact:true}).selectOption(metric);
        await capture(name);
        if (metric === 'p95Ms') assert.equal(await page.locator('.ta-rank-track[data-dot]').count(),10);
      }
      await page.getByRole('button',{name:'git status',exact:true}).hover();
      assert((await page.locator('[data-map-members][data-active]').count())>0);
      await page.keyboard.press('Escape');
      if (width === 1280 || width === 320) {
        for (const state of ['few','dense','missing']) {
          mode = state; await open(page,width).catch(async error => { if(state !== 'missing') throw error; await page.getByText('No eligible measured intervals',{exact:true}).waitFor(); });
          await capture(state);
          if(state === 'dense') {
            const cluster = page.locator("[data-map-members*= '\"operation_0\"']").first();
            await cluster.focus(); await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.activeElement.classList.contains('ta-map-member'));
            assert((await page.locator('.ta-map-member').count())>=200);
            await page.locator('.ta-map-member').nth(120).click();
            await page.locator('.ta-inspector h3').waitFor();
            assert((await page.locator('.ta-inspector h3').textContent()).startsWith('operation_'));
            await capture('dense-selected');
          }
          await page.keyboard.press('Escape');
        }
      }
      assert.deepEqual(errors,[]); await page.close(); console.log('PASS MAP',width,height,'axes/hover/selection/refresh/search/provider/dots/responsive');
    }
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error.stack); process.exitCode=1; });
