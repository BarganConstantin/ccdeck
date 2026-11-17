// Parent-owned V2 agents pause by finishing a cooperative checkpoint, never by
// interrupting tool execution whose start is absent from the native item feed.
import { liveError } from './codex-live-rpc.mjs';
import { readCodexLiveTurn, usageLimitedTurn } from './codex-live-handoff.mjs';

const inputs = turn => turn.items.filter(i => i.type === 'userMessage').map(i => i.id);
export async function requestCodexLiveCheckpoints(rpc, entries, options) {
  for (const entry of entries) {
    if (entry.rateLimited) await options.record(entry, 'paused');
    else if (!entry.checkpointReady) await options.record(entry, 'checkpoint_waiting');
  }
  for (const owner of entries.filter(e => !e.resumeViaThreadId && !e.checkpointReady && !e.rateLimited)) {
    await options.beforeSend?.();
    await options.record(owner, 'checkpoint_sent');
    const targets = entries.filter(e => e.resumeViaThreadId === owner.threadId).reverse().map(e => e.threadId);
    const family = targets.length ? 'Use native send_message to ask each of these existing subagents to finish its current tool call, record a concise checkpoint of its unfinished assignment, '
      + 'then END its current response with CCDECK_CHECKPOINT_' + owner.checkpointId + ': ' + JSON.stringify(targets)
      + '. This is a temporary pause, not completion of the original assignments. Do not spawn replacements or close agents. '
      + 'Do not message an agent that already finished or was closed. Wait for all requested checkpoints, then ' : '';
    const text = 'A ccdeck account change is pending. Keep the existing assignments and conversation history. '
      + 'Do not cancel running commands or replay tools. Finish the current tool call, then avoid starting new work before the account change. '
      + family + 'Record a concise checkpoint of your own unfinished work and END your current response '
      + 'with CCDECK_CHECKPOINT_' + owner.checkpointId + '. Do not resume any checkpointed task until the account change is complete and you receive the continuation instruction. '
      + 'Honor newer user instructions; if the user cancelled or asked to stop, remain stopped.';
    await rpc.request('turn/steer', { threadId: owner.threadId, expectedTurnId: owner.turnId,
      clientUserMessageId: owner.checkpointId, input: [{ type: 'text', text }] });
  }
}

export async function inspectCodexLiveCheckpoints(rpc, entries, options) {
  let pending = false;
  for (const entry of entries) {
    if (entry.phase === 'skipped') continue;
    const t = (await rpc.request('thread/read', { threadId: entry.threadId, includeTurns: false }))?.thread;
    if (!t || (t.parentThreadId ?? null) !== (entry.parentThreadId ?? null)) throw liveError('native_activity_changed');
    if (t.status?.type === 'notLoaded') { pending = true; continue; }
    const turn = await readCodexLiveTurn(rpc, t);
    if (!turn || turn.itemsView !== 'full' || !Array.isArray(turn.items)) throw liveError('native_activity_unknown');
    if (turn.rootTurnId !== entry.rootTurnId || !entry.resumeViaThreadId && turn.id !== entry.turnId) throw liveError('native_activity_changed');
    if (!entry.resumeViaThreadId) {
      const previous = turn.items.filter(i => i.type === 'userMessage' && (entry.checkpointReady || entry.rateLimited || i.clientId !== entry.checkpointId)).map(i => i.id);
      if (JSON.stringify(previous) !== JSON.stringify(entry.inputIds)) throw liveError('native_activity_changed');
    }
    if (entry.rateLimited) {
      if (turn.id !== entry.turnId || !usageLimitedTurn(turn) || t.status?.type !== 'idle' || t.canAcceptDirectInput !== true
        || turn.items.some(i => i.status === 'inProgress')) throw liveError('native_activity_changed');
      continue;
    }
    if (entry.checkpointReady) {
      if (turn.id !== entry.turnId || turn.status !== 'completed'
        || !turn.items.some(i => i.type === 'agentMessage' && i.text?.includes('CCDECK_CHECKPOINT_' + entry.checkpointId))) throw liveError('native_activity_changed');
      continue;
    }
    if (turn.status === 'inProgress') { pending = true; continue; }
    if (usageLimitedTurn(turn) && t.status?.type === 'idle' && t.canAcceptDirectInput === true
      && !entry.resumeViaThreadId && turn.items.every(i => i.status !== 'inProgress')) {
      entry.turnId = turn.id; entry.inputIds = inputs(turn); entry.rateLimited = true;
      await options.record(entry, 'paused'); continue;
    }
    if (turn.status !== 'completed') throw liveError('native_continue_unconfirmed');
    const ready = turn.items.some(i => i.type === 'agentMessage' && i.text?.includes('CCDECK_CHECKPOINT_' + entry.checkpointId));
    if (ready) {
      entry.turnId = turn.id; entry.inputIds = inputs(turn); entry.checkpointReady = true;
      await options.record(entry, 'checkpoint_ready');
    } else await options.record(entry, 'skipped'); // Naturally finished work stays finished.
  }
  const paused = entries.filter(e => e.checkpointReady || e.rateLimited);
  if (!pending && paused.some(e => e.resumeViaThreadId && !paused.some(p => p.threadId === e.resumeViaThreadId))) throw liveError('native_continue_unconfirmed');
  return pending ? null : { waiting: false, paused };
}
