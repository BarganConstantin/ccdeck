import { toolAudit } from './tool-audit.mjs';
import { readBody, send } from './http-io.mjs';
const calendarDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function auditQuery(params) {
  const provider = params.get('provider') ?? 'all';
  const days = Number(params.get('days') ?? 7);
  const operation = params.get('operation') ?? undefined;
  const since = params.get('since'), until = params.get('until');
  const history = params.get('history');
  let timeZone = params.get('timeZone') ?? 'UTC';
  if (history !== null && history !== '1' || history && !operation || timeZone.length > 80) return null;
  try { timeZone = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone; } catch { return null; }
  if (!['all', 'claude', 'codex'].includes(provider) || ![1, 7, 30, 60, 90].includes(days)
      || operation && operation.length > 150 || !!since !== !!until) return null;
  if (since && (!calendarDate(since) || !calendarDate(until) || since > until || Date.parse(until) - Date.parse(since) >= 90 * 86400000)) return null;
  return { provider, days, operation, ...(history ? { history: true, timeZone } : {}), ...(since ? { since: Date.parse(since), until: Date.parse(until) + 86400000 - 1 } : {}) };
}
export async function handleToolAudit(req, res) {
  const audit = toolAudit();
  if (!audit) return send(res, 503, { ok: false, reason: 'unavailable' });
  if (req.method === 'GET') {
    if (new URL(req.url, 'http://localhost').pathname.endsWith('/storage')) return send(res, 200, await audit.status());
    const query = auditQuery(new URL(req.url, 'http://localhost').searchParams);
    if (!query) return send(res, 400, { ok: false, reason: 'bad_range' });
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancel);
    let report;
    try { report = await audit.report(query, controller.signal); }
    catch (e) { if (controller.signal.aborted) return; throw e; }
    finally { res.off('close', cancel); }
    return send(res, report.ok ? 200 : 409, report);
  }
  let body; try { body = JSON.parse(await readBody(req, res, 2048)); } catch { return send(res, 400, { ok: false, reason: 'bad_body' }); }
  if (body?.action === 'clear' && body.confirm === true) return send(res, 200, await audit.clear());
  if (body?.action === 'retention' && [30, 60, 90].includes(body.days)) return send(res, 200, await audit.configure(body.days));
  return send(res, 400, { ok: false, reason: 'bad_action' });
}
