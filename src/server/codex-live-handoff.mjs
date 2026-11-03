// Quiesce model responses before native auth invalidates their network permits.
// Never answer approvals, widen permissions, or resume a naturally finished turn.
import { randomUUID } from 'node:crypto';
import { liveError } from './codex-live-rpc.mjs';

const passive = new Set(['userMessage', 'hookPrompt', 'agentMessage', 'functionCallOutput', 'plan', 'reasoning']);
const terminal = new Set(['completed', 'failed', 'declined']);
const tool = item => !passive.has(item.type);
const completed = item => item.status !== 'inProgress' && (terminal.has(item.status)
  || Number.isFinite(item.completedAtMs) && item.completedAtMs > 0);
function ancestors(thread, known) {
  const seen = new Set([thread.id]), parents = [];
  for (let id = thread.parentThreadId; id; id = known.get(id)?.parentThreadId) {
    if (seen.has(id) || !known.has(id)) throw liveError('native_activity_unknown');
    seen.add(id); parents.push(id);
  }
  return parents;
}
// Waiting for a known descendant has no side effect. Spawn/input/close and
// every real tool must finish before we pause any member of the family.
const childWait = (item, thread, known) => item.type === 'collabAgentToolCall'
  && item.tool === 'wait' && item.status === 'inProgress' && item.senderThreadId === thread.id
  && Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length > 0
  && item.receiverThreadIds.every(id => known.has(id) && ancestors(known.get(id), known).includes(thread.id));
const safe = (turn, thread, known) => turn?.itemsView === 'full' && Array.isArray(turn?.items)
  && turn.items.some(i => i.type === 'userMessage')
  && turn.items.every(i => passive.has(i.type) || completed(i) || childWait(i, thread, known));
const inputIds = turn => turn.items.filter(i => i.type === 'userMessage').map(i => i.id);
const sameInputs = (a, b) => JSON.stringify(inputIds(a)) === JSON.stringify(inputIds(b));

async function latest(rpc, threadId) {
  const page = await rpc.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
  if (!Array.isArray(page?.data)) throw liveError('native_activity_unknown');
  return page.data[0] ?? null;
}
async function liveLatest(rpc, thread) {
  if (thread.historyMode !== 'paginated') return latest(rpc, thread.id);
  // Stored paginated history omits tool-start events. Native resume composes a
  // live snapshot in its listener before subscribing this connection. Request
  // one full turn, apply no settings, ignore replayed requests, then detach.
  try {
    const result = await rpc.request('thread/resume', { threadId: thread.id, excludeTurns: true,
      initialTurnsPage: { limit: 1, sortDirection: 'desc', itemsView: 'full' } });
    const page = result?.initialTurnsPage;
    if (!Array.isArray(page?.data)) throw liveError('native_activity_unknown');
    return page.data[0] ?? null;
  } finally {
    await rpc.request('thread/unsubscribe', { threadId: thread.id }).catch(() => {});
  }
}
async function snapshot(rpc) {
  const page = await rpc.request('thread/loaded/list', { limit: 65 });
  if (!Array.isArray(page?.data) || page.data.length > 64 || page.nextCursor) throw liveError('native_activity_unknown');
  const threads = [], known = new Map();
  for (const id of page.data) {
    if (typeof id !== 'string') throw liveError('native_activity_unknown');
    const result = await rpc.request('thread/read', { threadId: id, includeTurns: false });
    const t = result?.thread;
    if (!t || t.id !== id || !['idle', 'systemError', 'active', 'notLoaded'].includes(t.status?.type)) throw liveError('native_activity_unknown');
    known.set(id, t);
    // Ephemeral native jobs have no stored turn-history API. Never interrupt
    // them or attempt to reconstruct their history; wait until twice idle.
    if (t.ephemeral === true) {
      if (t.status.type === 'idle') {
        const again = (await rpc.request('thread/read', { threadId: id, includeTurns: false }))?.thread;
        if (again?.id !== id) throw liveError('native_activity_unknown');
        if (again.ephemeral === true && again.status?.type === 'idle') continue;
      }
      threads.push({ id, active: false, turn: null }); continue;
    }
    let turn;
    try { turn = t.status.type === 'active' ? await liveLatest(rpc, t) : await latest(rpc, id); }
    catch (error) {
      // A newly opened blank native conversation has no stored turn page yet.
      // Only this exact native error and a second idle observation establish
      // that it has no work to hand off. Other rejected reads still fail closed.
      if (t.status.type !== 'idle' || error.code !== 'native_thread_not_materialized') throw error;
      const again = (await rpc.request('thread/read', { threadId: id, includeTurns: false }))?.thread;
      if (again?.id !== id) throw liveError('native_activity_unknown');
      if (again.status?.type === 'idle') continue;
      threads.push({ id, active: false, turn: null });
      continue;
    }
    if (t.status.type === 'active' || turn?.status === 'inProgress' || turn?.items?.some(i => i.status === 'inProgress')) threads.push({ id,
      active: t.status.type === 'active',
      thread: t, flags: t.status.activeFlags, turn });
  }
  return { threads, known };
}

/** A waiting result sends no interrupt and no authentication mutation. */
export async function prepareCodexLiveHandoff(rpc, options = {}) {
  const isCurrent = options.isCurrent ?? (() => true);
  const paused = [];
  const { threads: initial, known } = await snapshot(rpc);
  if (initial.some(t => !t.active || t.thread?.canAcceptDirectInput === false
    || t.thread?.parentThreadId && t.thread.canAcceptDirectInput !== true
    || !Array.isArray(t.flags) || t.flags.length || t.turn?.status !== 'inProgress' || !safe(t.turn, t.thread, known))) {
    return { waiting: true, paused };
  }
  // Stop parents first so a child's interruption cannot complete a live wait
  // and let its parent launch more work. Resume in the opposite order below.
  initial.sort((a, b) => ancestors(a.thread, known).length - ancestors(b.thread, known).length);
  try {
    for (const observed of initial) {
      if (!isCurrent()) throw liveError('native_switch_superseded');
      const now = (await rpc.request('thread/read', { threadId: observed.id, includeTurns: false }))?.thread;
      if (now?.status?.type !== 'active') continue;
      const turn = await liveLatest(rpc, now);
      if (turn?.id !== observed.turn.id || now.status.activeFlags?.length || now.canAcceptDirectInput === false
        || (now.parentThreadId ?? null) !== (observed.thread.parentThreadId ?? null)
        || now.parentThreadId && now.canAcceptDirectInput !== true
        || !safe(turn, now, known) || !sameInputs(observed.turn, turn)) throw liveError('native_activity_changed');
      const entry = { threadId: observed.id, turnId: turn.id, rootTurnId: turn.rootTurnId ?? turn.id, messageId: randomUUID(), inputIds: inputIds(turn),
        ...(now.parentThreadId ? { parentThreadId: now.parentThreadId } : {}) };
      await options.beforeInterrupt?.(entry);
      // Native acknowledges terminal completion; verify whether it interrupted
      // or finished naturally. Never use an empty ID or change configuration.
      await rpc.request('turn/interrupt', { threadId: observed.id, turnId: turn.id });
      const after = await latest(rpc, observed.id);
      if (after?.id === turn.id && after.status === 'completed') { await options.afterInterrupt?.(entry, 'skipped'); continue; }
      if (after?.id !== turn.id || after.status !== 'interrupted') throw liveError('native_interrupt_unconfirmed');
      if (!sameInputs(turn, after)) throw liveError('native_activity_changed');
      const previous = new Set(turn.items.map(i => i.id));
      if (after.items.some(i => tool(i) && !previous.has(i.id) && !completed(i))) throw liveError('native_tool_interrupted');
      paused.push(entry);
      await options.afterInterrupt?.(entry, 'paused');
    }
    await assertCodexLiveQuiet(rpc);
    return { waiting: false, paused };
  } catch (error) {
    // Preserve exact interrupted IDs for recovery, never include thread text.
    error.handoff = { waiting: false, paused };
    throw error;
  }
}

export async function assertCodexLiveQuiet(rpc) {
  if ((await snapshot(rpc)).threads.length) throw liveError('native_activity_changed');
}

/** Mark a send durably before submitting. An uncertain send is never replayed. */
export async function continueCodexLiveHandoff(rpc, handoff, options = {}) {
  let resumed = 0;
  for (const entry of [...handoff?.paused ?? []].reverse()) {
    if (entry.sent) continue;
    if (options.isCurrent && !options.isCurrent()) throw liveError('native_switch_superseded');
    const t = (await rpc.request('thread/read', { threadId: entry.threadId, includeTurns: false }))?.thread;
    // A closed/unloaded child has no direct-input capability. Leave it alone
    // before inspecting history, and allow the remaining family to continue.
    if (t?.status?.type !== 'idle') { await options.onSkip?.(entry); continue; }
    if (t?.canAcceptDirectInput === false || entry.parentThreadId
      && (t?.canAcceptDirectInput !== true || t.parentThreadId !== entry.parentThreadId)) throw liveError('native_activity_changed');
    const turn = await latest(rpc, entry.threadId);
    // New input, natural completion, archival or a different turn wins over us.
    if (turn?.id !== entry.turnId || turn.status !== 'interrupted'
      || JSON.stringify(inputIds(turn)) !== JSON.stringify(entry.inputIds)) {
      await options.onSkip?.(entry); continue;
    }
    await options.beforeSend?.(entry);
    entry.sent = true;
    const result = await rpc.request('turn/start', { threadId: entry.threadId,
      rootTurnId: entry.rootTurnId, clientUserMessageId: entry.messageId,
      input: [{ type: 'text', text: 'Continue the interrupted task, honoring the latest user instructions already in this conversation. Do not repeat completed tools or actions. If the user cancelled or asked to stop, remain stopped.' }] });
    if (!result?.turn?.id) throw liveError('native_continue_unconfirmed');
    resumed++;
    await options.afterSend?.(entry, result.turn.id);
  }
  return { resumed };
}
