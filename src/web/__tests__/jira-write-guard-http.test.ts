// HTTP-level test: the Jira transport is entirely synthetic.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIntegrations } from '../../server/integrations/routes.mjs';
import { createJiraWriteGuard } from '../../server/integrations/jira-write-guard.mjs';

describe('Jira HTTP write guard', () => {
  it('blocks concurrent and lost comments until the matching operation is acknowledged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jira-guard-'));
    const guard = createJiraWriteGuard({ dir: () => dir });
    const conn = { id: 'synthetic-connection', kind: 'jira', baseUrl: 'https://jira.example.com', allowedOrigins: ['https://jira.example.com'], meta: { deployment: 'server' }, account: {} };
    const store = { get: async (id: string) => id === conn.id ? conn : null, secret: async () => ({ auth: 'bearer', token: 'synthetic-secret-token' }) };
    let release!: () => void;
    let started!: () => void;
    const sent = new Promise<void>(resolve => { started = resolve; });
    const stalled = new Promise<void>(resolve => { release = resolve; });
    let writes = 0;
    let nextStatus = 0;
    const fetchImpl = async () => { writes++; if (nextStatus) return new Response(null, { status: nextStatus }); started(); await stalled; throw new Error('synthetic network loss'); };
    const server = createServer((req, res) => { handleIntegrations(req, res, new URL(req.url!, 'http://localhost'), { store, fetchImpl, jiraWriteGuard: guard }).catch(() => { res.writeHead(500); res.end(); }); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/integrations/jira/${conn.id}`;
    const post = (path: string, body: object) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const first = post('/issue/MOCK-1/comment', { text: 'private comment content' });
      await sent;
      const conflict = await post('/issue/MOCK-1/comment', { text: 'different text' });
      expect(conflict.status).toBe(409);
      const { operation } = await conflict.json();
      expect(operation.state).toBe('pending');
      expect((await post('/write-guard/acknowledge', { operationId: operation.operationId })).status).toBe(409);
      const files = await readdir(dir);
      const saved = await readFile(join(dir, files.find(n => n.endsWith('.json'))!), 'utf8');
      expect(saved).not.toContain('private comment content');
      expect(saved).not.toContain('synthetic-secret-token');
      release();
      expect((await first).status).not.toBe(200);
      const state = await (await fetch(base + '/write-guard')).json();
      expect(state.operations[0].state).toBe('uncertain');
      expect(writes).toBe(1);
      expect((await post('/write-guard/acknowledge', { operationId: operation.operationId })).status).toBe(200);
      expect((await (await fetch(base + '/write-guard')).json()).operations).toEqual([]);
      nextStatus = 408;
      expect((await post('/issue/MOCK-1/comment', { text: 'another comment' })).status).not.toBe(200);
      const timedOut = await post('/issue/MOCK-1/comment', { text: 'another comment' });
      expect(timedOut.status).toBe(409);
      const timeoutOperation = (await timedOut.json()).operation;
      expect(timeoutOperation.state).toBe('uncertain');
      expect((await post('/write-guard/acknowledge', { operationId: timeoutOperation.operationId })).status).toBe(200);
      nextStatus = 201;
      expect((await post('/issue/MOCK-1/comment', { text: 'confirmed comment' })).status).toBe(200);
      expect((await (await fetch(base + '/write-guard')).json()).operations).toEqual([]);
    } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
  });
});
