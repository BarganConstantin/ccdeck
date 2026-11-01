// Removing a Codex account while its sign-in is still waiting.
//
// The sign-in's process writes its login into the home it was started for. A
// Remove moves that home away, so the process has to be stopped first or the
// login lands in a folder nobody lists. The other actions leave a sign-in alone.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';

const order: string[] = [];
vi.mock('../../server/codex-login.mjs', () => ({
  cancelCodexLogin: (id: string) => { order.push(`cancel:${id}`); return { ok: true, state: 'cancelled' }; },
}));
vi.mock('../../server/codex-selection.mjs', () => ({
  removeCodexProfile: async ({ id }: { id: string }) => { order.push(`remove:${id}`); return { id, revision: 4, status: 'removed' }; },
  selectCodexProfile: async ({ id }: { id: string }) => { order.push(`select:${id}`); return { id, revision: 5 }; },
  addCodexProfile: async () => ({ id: 'c'.repeat(20), revision: 6 }),
  renameCodexProfile: async () => ({ id: 'c'.repeat(20), revision: 7 }),
}));
vi.mock('../../server/codex-profiles.mjs', () => ({ replaceCodexLogin: async () => ({ id: 'c'.repeat(20), revision: 8 }) }));
const { handleCodexProfileMutation } = await import('../../server/account-routes.mjs');

let server: Server, base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const action = new URL(req.url ?? '/', 'http://x').pathname.slice(1);
    void handleCodexProfileMutation(req, res, action);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

const post = (action: string, body: unknown) =>
  fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ID = 'b'.repeat(20);

describe('Remove, with a sign-in waiting on that account', () => {
  it('stops the sign-in before the home is moved away', async () => {
    order.length = 0;
    expect((await post('remove', { id: ID, expectedRevision: 3 })).status).toBe(200);
    expect(order).toEqual([`cancel:${ID}`, `remove:${ID}`]);
  });

  it('leaves a sign-in alone for every other action', async () => {
    order.length = 0;
    await post('select', { id: ID, expectedRevision: 3 });
    expect(order).toEqual([`select:${ID}`]);
  });

  it('cancels nothing for a request with no id of its own', async () => {
    order.length = 0;
    await post('remove', { expectedRevision: 3 });
    expect(order).toEqual([`remove:undefined`]);
  });
});
