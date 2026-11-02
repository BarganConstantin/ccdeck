import { afterEach, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
// @ts-expect-error server ES module
import { startEngineRpc } from '../../server/codex-engine-rpc.mjs';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('relays a large native plugin catalog without quadratic partial-frame scanning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-rpc-large-')); roots.push(root);
  const script = join(root, 'server.cjs');
  await writeFile(script, `require('readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);console.log(JSON.stringify({id:m.id,result:{icon:'x'.repeat(18*1024*1024),name:'猫'}}));});`);
  const rpc = startEngineRpc(process.execPath, [script], root, { deadlineMs: 4000 });
  try {
    const result = await rpc.request('plugin/list', {});
    expect(result.icon).toHaveLength(18 * 1024 * 1024);
    expect(result.name).toBe('猫');
  } finally { await rpc.stop(); }
});
it('does not retry a timed-out submission or forward its late internal reply to the TUI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-rpc-')); roots.push(root);
  const script = join(root, 'server.cjs'), counter = join(root, 'count');
  await writeFile(script, `const fs=require('fs');require('readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);fs.appendFileSync(${JSON.stringify(counter)},'request\\n');setTimeout(()=>console.log(JSON.stringify({id:m.id,result:{ok:true}})),150);});`);
  const messages: unknown[] = [];
  const rpc = startEngineRpc(process.execPath, [script], root, { deadlineMs: 80, onMessage: (m: unknown) => messages.push(m) });
  try {
    await expect(rpc.request('turn/start', {})).rejects.toThrow('not retried');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(await readFile(counter, 'utf8')).toBe('request\n');
    expect(messages).toEqual([]);
  } finally { await rpc.stop(); }
});
it.skipIf(process.platform === 'win32')('isolates the owned backend from terminal Ctrl+C', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-rpc-signal-')); roots.push(root);
  const server = join(root, 'server.cjs'), driver = join(root, 'driver.mjs');
  await writeFile(server, `require('readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);console.log(JSON.stringify({id:m.id,result:{ok:true}}));});`);
  const module = new URL('../../server/codex-engine-rpc.mjs', import.meta.url).href;
  await writeFile(driver, `import {startEngineRpc} from ${JSON.stringify(module)};
const rpc=startEngineRpc(process.execPath,[${JSON.stringify(server)}],${JSON.stringify(root)});
try { await rpc.request('ping',{});process.on('SIGINT',()=>{});process.kill(-process.pid,'SIGINT');await new Promise(r=>setTimeout(r,30));const r=await rpc.request('ping',{});console.log(JSON.stringify(r)); } finally { await rpc.stop(); }`);
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [driver], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(err)); });
  });
  expect(JSON.parse(stdout)).toEqual({ ok: true });
});
