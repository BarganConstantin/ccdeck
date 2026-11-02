import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
// @ts-expect-error server ES module
import { createInteractiveCodexSession, codexInteractiveInvocation } from '../../server/codex-interactive-engine.mjs';
// @ts-expect-error server ES module
import { transferCodexThread } from '../../server/codex-engine-adapter.mjs';
const ID = '12345678-1234-1234-1234-123456789abc';
const roots: string[] = [], sessions: { close(): Promise<void> }[] = [];
const clients: WebSocket[] = [];
afterEach(async () => { for (const ws of clients.splice(0)) ws.terminate(); for (const s of sessions.splice(0)) await s.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function waitFor<T>(get: () => T, timeout = 6000): Promise<NonNullable<T>> {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = get(); if (value) return value as NonNullable<T>; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for a protocol event');
}
async function fixture({ error = 'usageLimitExceeded', quota = 10, approval = false, pauseQuota = Promise.resolve(), inherit = false, trustOnly = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ccdeck-interactive-')); roots.push(root);
  const source = join(root, 'source'), target = join(root, 'target'); await mkdir(source); await mkdir(target);
  if (inherit) await writeFile(join(target, 'config.toml'), 'model="inherited-model"\n');
  if (trustOnly) await writeFile(join(source, 'config.toml'), '[projects."/workspace"]\ntrust_level="trusted"\n');
  const a = createHash('sha256').update(await realpath(source)).digest('hex').slice(0, 20), b = 'b'.repeat(20);
  const manual = { current: null as null | { id: string; revision: number } };
  const script = join(root, 'server.cjs');
  await writeFile(script, `
const fs=require('fs'),path=require('path'),rl=require('readline').createInterface({input:process.stdin});
const home=process.env.CODEX_HOME, id=${JSON.stringify(ID)}, source=${JSON.stringify(source)}, root=${JSON.stringify(root)};
const day=path.join(home,'sessions','2026','11','02'), file=path.join(day,'rollout-2026-11-02T12-00-00-'+id+'.jsonl');
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
fs.appendFileSync(path.join(root,'processes'),home+'\\n');
rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{userAgent:'test'}});
 else if(m.method==='config/read')send({id:m.id,result:{layers:[{config:${inherit}?home===source?{}:{model:'inherited-model'}:{}}]}});
 else if(m.method==='thread/start'){if(m.params.ephemeral){send({id:m.id,result:{thread:{id:'87654321-1234-1234-1234-123456789abc',cwd:root}}});return;}fs.mkdirSync(day,{recursive:true});fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,cwd:root}})+'\\n');send({id:m.id,result:{thread:{id,cwd:root}}});}
 else if(m.method==='thread/resume'){fs.appendFileSync(path.join(root,'resumes'),JSON.stringify(m.params)+'\\n');if(m.params.threadId!==id||!fs.existsSync(file))send({id:m.id,error:{code:-1,message:'wrong thread'}});else send({id:m.id,result:{thread:{id,cwd:root}}});}
 else if(m.method==='turn/start'){
  fs.appendFileSync(path.join(root,'turns'),JSON.stringify({home,params:m.params})+'\\n');
  send({id:m.id,result:{turn:{id:'turn',status:'inProgress'}}});send({method:'turn/started',params:{threadId:id,turn:{id:'turn'}}});
  if(home===source){
   if(${JSON.stringify(error)}==='tool-running'){
    send({method:'item/started',params:{threadId:id,item:{id:'live-tool',type:'dynamicToolCall'}}});
    setTimeout(()=>{fs.writeFileSync(path.join(root,'tool-done'),'yes');send({method:'item/completed',params:{threadId:id,item:{id:'live-tool',type:'dynamicToolCall',status:'completed'}}});},150);
    return;
   }
   if(${JSON.stringify(error)}==='running')return;
   send({method:'item/agentMessage/delta',params:{threadId:id,delta:'usageLimitExceeded is just text'}});
   send({method:'turn/completed',params:{threadId:id,turn:{id:'turn',status:'failed',error:{message:'quota',codexErrorInfo:${JSON.stringify(error)}}}}});
  }else{
   if(${approval})send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:id}});
   else send({method:'turn/completed',params:{threadId:id,turn:{id:'turn',status:'completed'}}});
  }
 }else if(m.method==='turn/interrupt'){if(${JSON.stringify(error)}==='tool-running'&&!fs.existsSync(path.join(root,'tool-done')))fs.writeFileSync(path.join(root,'premature-interrupt'),'yes');send({id:m.id,result:{}});send({method:'turn/completed',params:{threadId:id,turn:{id:'turn',status:'interrupted'}}});}
 else if(m.id==='approval'&&!m.method){fs.writeFileSync(path.join(root,'approval'),JSON.stringify(m));send({method:'turn/completed',params:{threadId:id,turn:{id:'turn',status:'completed'}}});}
 else if(m.id!==undefined)send({id:m.id,result:{}});
});
rl.on('close',()=>{fs.appendFileSync(path.join(root,'exits'),home+'\\n');});
`);
  const adapter = {
    settings: vi.fn(async () => ({ enabled: true, threshold: 90, heldOut: [] })),
    accounts: async () => [{ id: a, signedIn: true, available: true }, { id: b, signedIn: true, available: true }],
    quota: async () => { await pauseQuota; return { ok: true, windows: [{ usedPercent: quota, seconds: 18000, resetAt: Date.now() / 1000 + 3600 }] }; },
    prepare: vi.fn(async ({ from, id, threadId }: { from: { home: string }; id: string; threadId: string }) => {
      expect(await readFile(join(root, 'exits'), 'utf8')).toContain(from.home);
      const home = id === a ? source : target;
      await transferCodexThread(from.home, home, threadId, { moveSource: true });
      return { id, home, threadId };
    }),
    close: async () => {},
  };
  const states: any[] = [];
  const session = await createInteractiveCodexSession(join(root, 'registry.json'), process.execPath, [], source, { adapter, backendArgs: [script], onState: (state: unknown) => states.push(state), readSelection: async () => ({ originalHome: inherit ? target : source, runningSelection: manual.current }), manualPollMs: 20 }); sessions.push(session);
  const events: any[] = [];
  const ws = new WebSocket(session.url, { headers: { authorization: `Bearer ${session.token}` } }); clients.push(ws);
  ws.on('message', data => events.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const call = async (method: string, params: unknown) => { const id = Math.random().toString(); ws.send(JSON.stringify({ id, method, params })); return waitFor(() => events.find(e => e.id === id)); };
  await call('initialize', { clientInfo: { name: 'test', version: '1' }, capabilities: { experimentalApi: true } });
  ws.send(JSON.stringify({ method: 'initialized', params: {} }));
  await call('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'gpt-5.4' });
  return { root, source, target, session, events, ws, call, adapter, states, manual, a, b };
}
describe('interactive Codex engine', () => {
  it('keeps one TUI connection while changing the owned backend and continuing the exact thread once', async () => {
    const f = await fixture();
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'task' }], effort: 'high', approvalPolicy: 'on-request' });
    await waitFor(() => f.events.find(e => e.method === 'turn/completed' && e.params.turn.status === 'completed'));
    const turns = (await readFile(join(f.root, 'turns'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    expect(turns.map(t => t.home)).toEqual([f.source, f.target]);
    expect(turns[1].params).toMatchObject({ threadId: ID, effort: 'high', approvalPolicy: 'on-request' });
    expect(turns[1].params.clientUserMessageId).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.ws.readyState).toBe(WebSocket.OPEN);
    expect(f.adapter.prepare).toHaveBeenCalledOnce();
  });
  it.each(['rateLimitExceeded', 'unauthorized', 'other'])('does not rotate for %s or for assistant text', async error => {
    const f = await fixture({ error });
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'task' }] });
    await waitFor(() => f.events.find(e => e.method === 'turn/completed'));
    await f.call('account/read', {});
    expect(f.adapter.prepare).not.toHaveBeenCalled();
  });
  it('relays native approval requests and the human response after a switch', async () => {
    const f = await fixture({ approval: true });
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'task' }] });
    const approval = await waitFor(() => f.events.find(e => e.method === 'item/commandExecution/requestApproval'));
    f.ws.send(JSON.stringify({ id: approval.id, result: { decision: 'decline' } }));
    await waitFor(() => f.events.find(e => e.method === 'turn/completed' && e.params.turn.status === 'completed'));
    expect(JSON.parse(await readFile(join(f.root, 'approval'), 'utf8')).result.decision).toBe('decline');
  });
  it('restores an idle usable connection when no account has room and does not submit Continue', async () => {
    const f = await fixture({ quota: 99 });
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'task' }] });
    expect((await f.session.done).reason).toBe('no_account_with_room');
    expect(f.adapter.prepare).not.toHaveBeenCalled();
    expect((await f.call('account/read', {})).result).toEqual({});
    expect((await readFile(join(f.root, 'turns'), 'utf8')).trim().split('\n')).toHaveLength(1);
    // A manual retry after the bounded engine stopped must keep a live backend.
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'manual retry' }] });
    expect((await f.call('account/read', {})).result).toEqual({});
  });
  it('parses only locally supervised invocations and preserves backend configuration overrides', () => {
    expect(codexInteractiveInvocation([])).toMatchObject({ threadId: null });
    expect(codexInteractiveInvocation(['-c', 'model_reasoning_effort="high"', 'resume', ID]).backendArgs).toContain('model_reasoning_effort="high"');
    for (const args of [['exec', '--json'], ['resume'], ['resume', '--last'], ['--remote', 'ws://elsewhere'], ['--ephemeral'], ['-p', 'profile'], ['--help']]) expect(codexInteractiveInvocation(args)).toBeNull();
  });
});

describe('handoff races', () => {
  it('holds one unsent same-thread follow-up instead of also adding Continue', async () => {
    let release!: () => void;
    const pauseQuota = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ pauseQuota });
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'task' }] });
    await waitFor(() => f.states.find(s => s.state === 'switching'));
    const queued = f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'user follow-up' }] });
    await waitFor(() => f.states.find(s => s.state === 'follow-up-held'));
    release();
    expect((await queued).error).toBeUndefined();
    await waitFor(() => f.events.find(e => e.method === 'turn/completed' && e.params.turn.status === 'completed'));
    const turns = (await readFile(join(f.root, 'turns'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    expect(turns).toHaveLength(2);
    expect(turns[1].params.input[0].text).toBe('user follow-up');
  });
  it('honors interrupt during a handoff without submitting the queued message', async () => {
    let release!: () => void;
    const pauseQuota = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ pauseQuota });
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'task' }] });
    await waitFor(() => f.states.find(s => s.state === 'switching'));
    const queued = f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'queued' }] });
    await waitFor(() => f.states.find(s => s.state === 'follow-up-held'));
    await f.call('turn/interrupt', { threadId: ID });
    expect((await queued).error).toBeDefined(); release();
    await waitFor(() => f.states.find(s => s.state === 'resumed'));
    expect((await f.call('account/read', {})).error).toBeUndefined();
    expect((await readFile(join(f.root, 'turns'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});

describe('manual account selection', () => {
  it.each([false, true])('keeps original CLI settings on an isolated account with trust-only config=%s', async trustOnly => {
    const f = await fixture({ inherit: true, trustOnly });
    expect(f.session.tuiHome).toBe(f.target);
    f.manual.current = { id: f.b, revision: 1 };
    await waitFor(() => f.states.find(s => s.state === 'resumed'));
    const resumed = JSON.parse((await readFile(join(f.root, 'resumes'), 'utf8')).trim());
    expect(resumed).toMatchObject({ threadId: ID, excludeTurns: true, config: { model: 'inherited-model' } });
    if (trustOnly) expect(await readFile(join(f.source, 'config.toml'), 'utf8')).toBe('[projects."/workspace"]\ntrust_level="trusted"\n');
    else await expect(readFile(join(f.source, 'config.toml'))).rejects.toThrow();
  });
  it('waits for a live dynamic tool before interrupting and transferring its conversation', async () => {
    const f = await fixture({ error: 'tool-running' });
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'task with tool' }] });
    await waitFor(() => f.events.find(e => e.method === 'item/started'));
    f.manual.current = { id: f.b, revision: 1 };
    await waitFor(() => f.states.find(s => s.state === 'resumed'));
    expect(await readFile(join(f.root, 'tool-done'), 'utf8')).toBe('yes');
    await expect(readFile(join(f.root, 'premature-interrupt'))).rejects.toThrow();
  });
  it('moves an idle conversation even with Auto-switch off, without sending a message, and can switch back', async () => {
    const f = await fixture();
    f.adapter.settings.mockResolvedValue({ enabled: false, threshold: 90, heldOut: [] });
    // The native TUI creates an ephemeral title-generation thread after a reply.
    await f.call('thread/start', { ephemeral: true });
    f.manual.current = { id: f.b, revision: 1 };
    await waitFor(() => f.states.find(s => s.state === 'resumed' && s.accountId === f.b));
    await expect(readFile(join(f.root, 'turns'), 'utf8')).rejects.toThrow();
    f.manual.current = { id: f.a, revision: 2 };
    await waitFor(() => f.states.find(s => s.state === 'resumed' && s.accountId === f.a));
    f.manual.current = { id: f.b, revision: 3 };
    await waitFor(() => f.adapter.prepare.mock.calls.length === 3 && f.states.filter(s => s.state === 'resumed' && s.accountId === f.b).length === 2);
    expect(f.adapter.prepare).toHaveBeenCalledTimes(3);
    expect((await f.call('account/read', {})).error).toBeUndefined();
  });
  it('interrupts an active turn, drains its backend and continues once on the manually selected account', async () => {
    const f = await fixture({ error: 'running' });
    f.adapter.settings.mockResolvedValue({ enabled: false, threshold: 90, heldOut: [] });
    await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'ongoing task' }] });
    await waitFor(() => f.events.find(e => e.method === 'turn/started'));
    f.manual.current = { id: f.b, revision: 1 };
    await waitFor(() => f.events.find(e => e.method === 'turn/completed' && e.params.turn.status === 'completed'));
    const turns = (await readFile(join(f.root, 'turns'), 'utf8')).trim().split('\n').map(s => JSON.parse(s));
    expect(turns.map(t => t.home)).toEqual([f.source, f.target]);
    expect(turns[1].params.threadId).toBe(ID);
    expect(turns[1].params.input[0].text).toContain('Continue the previous task');
  });
});
it('holds native metadata requests once during handoff instead of producing TUI warnings', async () => {
  let release!: () => void;
  const pauseQuota = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ pauseQuota });
  await f.call('turn/start', { threadId: ID, input: [{ type: 'text', text: 'task' }] });
  await waitFor(() => f.states.find(s => s.state === 'switching'));
  const reading = f.call('account/read', {});
  release();
  expect((await reading).error).toBeUndefined();
  expect(f.states.filter(s => s.state === 'resumed')).toHaveLength(1);
});
