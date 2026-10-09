import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleDesktopUpdateCheck } from '../../server/desktop-update-routes.mjs';
import { trayClients, sseClients } from '../../server/sse-clients.mjs';
import { isAuthorizedMutation } from '../../server/request-gates.mjs';
import { createServer } from 'node:http';
import { openTrayStream } from '../../../desktop/deck-link.mjs';
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); trayClients.clear(); sseClients.clear(); vi.useRealTimers(); });
function response() { return { status: 0, body: '', writeHead(code: number) { this.status = code; }, end(body: string) { this.body = body; } }; }
describe('native update check relay', () => {
  it('refuses a disconnected desktop app', () => {
    const res = response(); handleDesktopUpdateCheck({}, res); expect(res.status).toBe(409); expect(res.body).toContain('app_disconnected');
  });
  it('sends only to the tray, throttles repeated checks and remains a guarded mutation', () => {
    vi.useFakeTimers(); vi.setSystemTime(1900000000000);
    const app = { write: vi.fn(() => true), destroyed: false, writableEnded: false };
    const browser = { write: vi.fn(() => true) };
    trayClients.add(app); sseClients.add(browser);
    const res = response(); handleDesktopUpdateCheck({}, res); handleDesktopUpdateCheck({}, res);
    expect(res.status).toBe(202); expect(app.write).toHaveBeenCalledTimes(1); expect(app.write.mock.calls[0][0]).toContain('event: desktop-update-check'); expect(browser.write).not.toHaveBeenCalled();
    expect(isAuthorizedMutation({ method: 'POST', headers: { host: '127.0.0.1:4317' } })).toBe(false);
  });
  it('delivers the new SSE event to the Electron callback', async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: desktop-update-check\ndata: {}\n\n'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No updater callback')), 3000);
      const stream = openTrayStream({ port: (server.address() as any).port, token: 'test-token' }, { checkUpdate: () => { clearTimeout(timeout); resolve(); } });
      cleanup.push(() => stream.close());
    });
  });
});
