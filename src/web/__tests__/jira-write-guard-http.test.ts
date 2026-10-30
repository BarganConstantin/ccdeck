// HTTP-level test: the Jira transport is entirely synthetic.
import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIntegrations } from '../../server/integrations/routes.mjs';
import { createJiraWriteGuard } from '../../server/integrations/jira-write-guard.mjs';

describe('Jira HTTP write guard', () => {
  it('retains an uncertain reservation when a proxy returns 403 after applying a comment', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jira-guard-proxy-'));
    const guard = createJiraWriteGuard({ dir: () => dir });
    const conn = { id: 'synthetic-connection', kind: 'jira', baseUrl: 'https://jira.example.com', allowedOrigins: ['https://jira.example.com'], meta: { deployment: 'server' }, account: {} };
    const store = { get: async () => conn, secret: async () => ({ auth: 'bearer', token: 'synthetic-token' }) };
    let saved = 0;
    const fetchImpl = async () => { saved++; return new Response(null, { status: 403 }); };
    const server = createServer((req, res) => {
      handleIntegrations(req, res, new URL(req.url!, 'http://localhost'), { store, fetchImpl, jiraWriteGuard: guard }).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}/api/integrations/jira/${conn.id}`;
    const post = () => fetch(base + '/issue/MOCK-1/comment', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'comment' }) });
    try {
      const first = await post();
      expect(first.status).toBe(403);
      const result = await first.json();
      expect(result.operation.state).toBe('uncertain');
      const retry = await post();
      expect(retry.status).toBe(409);
      expect((await retry.json()).operation.operationId).toBe(result.operation.operationId);
      expect(saved).toBe(1);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
  });
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
    let dropResponse = false;
    const fetchImpl = async (_url: string, options: RequestInit = {}) => {
      if (!options.method || options.method === 'GET') return new Response(JSON.stringify({ transitions: [{ id: '11', name: 'Start', to: { name: 'Started' } }] }), { headers: { 'content-type': 'application/json' } });
      writes++; if (nextStatus) return new Response(null, { status: nextStatus }); started(); await stalled; throw new Error('synthetic network loss');
    };
    const server = createServer((req, res) => {
      if (dropResponse && req.url?.endsWith('/comment')) {
        dropResponse = false;
        res.end = (() => { res.destroy(); return res; }) as typeof res.end;
      }
      handleIntegrations(req, res, new URL(req.url!, 'http://localhost'), { store, fetchImpl, jiraWriteGuard: guard }).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
    });
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
      const firstResult = await first;
      expect(firstResult.status).not.toBe(200);
      const firstError = await firstResult.json();
      expect(firstError.error).toBeDefined();
      expect(firstError.operation).toMatchObject({ operationId: operation.operationId, connectionId: conn.id, kind: 'comment', issueKey: 'MOCK-1', state: 'uncertain' });
      const state = await (await fetch(base + '/write-guard')).json();
      expect(state.operations[0].state).toBe('uncertain');
      expect(writes).toBe(1);
      expect((await post('/write-guard/acknowledge', { operationId: operation.operationId })).status).toBe(200);
      expect((await (await fetch(base + '/write-guard')).json()).operations).toEqual([]);
      nextStatus = 408;
      const timeoutResult = await post('/issue/MOCK-1/comment', { text: 'another comment' });
      expect(timeoutResult.status).not.toBe(200);
      const timeoutError = await timeoutResult.json();
      expect(timeoutError.operation.state).toBe('uncertain');
      const timedOut = await post('/issue/MOCK-1/comment', { text: 'another comment' });
      expect(timedOut.status).toBe(409);
      const timeoutOperation = (await timedOut.json()).operation;
      expect(timeoutError.operation.operationId).toBe(timeoutOperation.operationId);
      expect(timeoutOperation.state).toBe('uncertain');
      expect((await post('/write-guard/acknowledge', { operationId: timeoutOperation.operationId })).status).toBe(200);
      for (const status of [400, 401, 403, 404, 409, 429]) {
        nextStatus = status;
        for (const [path, body] of [['/issue/MOCK-1/comment', { text: 'rejected comment' }], ['/issue/MOCK-1/transitions', { transitionId: '11' }]] as const) {
          const response = await post(path, body);
          expect(response.status).not.toBe(200);
          const operation = (await response.json()).operation;
          expect(operation.state).toBe('uncertain');
          expect((await post(path, body)).status).toBe(409);
          expect((await post('/write-guard/acknowledge', { operationId: operation.operationId })).status).toBe(200);
        }
      }
      nextStatus = 201;
      const success = await post('/issue/MOCK-1/comment', { text: 'confirmed comment' });
      expect(success.status).toBe(200);
      const confirmedId = (await success.json()).operationId;
      expect((await (await fetch(base + '/write-guard')).json()).operations[0]).toMatchObject({ operationId: confirmedId, state: 'confirmed' });
      expect((await post('/issue/MOCK-1/comment', { text: 'confirmed comment' })).status).toBe(409);
      expect((await post('/write-guard/acknowledge', { operationId: confirmedId })).status).toBe(200);
      expect((await (await fetch(base + '/write-guard')).json()).operations).toEqual([]);
      dropResponse = true;
      await expect(post('/issue/MOCK-1/comment', { text: 'response lost' })).rejects.toThrow();
      const lost = (await (await fetch(base + '/write-guard')).json()).operations[0];
      expect(lost.state).toBe('confirmed');
      expect((await post('/issue/MOCK-1/comment', { text: 'response lost' })).status).toBe(409);
      expect((await post('/write-guard/acknowledge', { operationId: lost.operationId })).status).toBe(200);
    } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
  });
});
