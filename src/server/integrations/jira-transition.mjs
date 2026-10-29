// A bounded Jira workflow transition. Never accept a URL or arbitrary fields.
import { errorFromFetchFailure, errorFromStatus, integrationError } from './errors.mjs';
import { isSafeTarget, originOf } from './proxy.mjs';

const keyPattern = /^[A-Z][A-Z0-9_]{0,40}-[1-9]\d{0,11}$/;
const idPattern = /^[0-9]{1,12}$/;
export async function jiraTransitions(read, rest, key) {
  if (!keyPattern.test(key)) throw integrationError('invalid', 'Not an issue key.');
  const result = await read.json(`${rest}/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`);
  if (!Array.isArray(result?.transitions)) throw integrationError('upstream', 'Jira did not return its available transitions.');
  return result.transitions.slice(0, 100).filter(t => typeof t.id === 'string' && idPattern.test(t.id) && typeof t.name === 'string' && t.name.trim())
    .map(t => ({ id: t.id, name: t.name.slice(0, 120), to: typeof t.to?.name === 'string' ? t.to.name.slice(0, 120) : '',
      requiresScreen: t.hasScreen === true || Object.values(t.fields ?? {}).some(f => f?.required === true) }));
}
export function createJiraTransition({ secret, origins, sign, authCheck, fetchImpl = globalThis.fetch, reader, rest, invalidate }) {
  return async (key, body, signal) => {
    if (!keyPattern.test(key) || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.transitionId !== 'string' || !idPattern.test(body.transitionId)) throw integrationError('invalid', 'Choose a valid transition.');
    const choices = await jiraTransitions(reader(signal), rest, key);
    const choice = choices.find(t => t.id === body.transitionId);
    if (!choice || choice.requiresScreen) throw integrationError('invalid', 'This transition is unavailable or requires additional fields in Jira.');
    const url = `${rest}/issue/${encodeURIComponent(key)}/transitions`;
    if (!isSafeTarget(url) || !origins().includes(originOf(url))) throw integrationError('permission', 'This Jira write is outside the connection’s token origins.');
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, 15000); timer.unref?.();
    let res;
    try {
      try { res = await fetchImpl(url, { method: 'POST', redirect: 'manual', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'ccdeck', ...sign(secret) }, body: JSON.stringify({ transition: { id: choice.id } }), signal: controller.signal }); }
      catch (err) { throw errorFromFetchFailure(err, 'Jira'); }
      if (res.status >= 300 && res.status < 400) throw integrationError('upstream', 'Jira redirected the transition. Refresh the issue before trying again.');
      const refused = authCheck(res.headers, secret);
      if (refused) throw integrationError('expired', refused, { status: 401 });
      if (res.status !== 204) {
        if (!res.ok) throw errorFromStatus(res.status, res.headers, { label: 'Jira' });
        throw integrationError('upstream', 'Jira did not confirm the transition. Refresh the issue.');
      }
      return { status: 200, body: { ok: true, issueKey: key } };
    } finally {
      invalidate(); clearTimeout(timer); signal?.removeEventListener('abort', stop); await res?.body?.cancel().catch(() => {});
    }
  };
}
