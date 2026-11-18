// The Jira side of the write guard: what a Jira write scope looks like. The
// reservations, locks and liveness checks live in write-guard.mjs.
import { join } from 'node:path';
import { deckDataDir } from '../deck-home.mjs';
import { STORE_DIR } from './store.mjs';
import { createWriteGuard } from './write-guard.mjs';

const keyPattern = /^[A-Z][A-Z0-9_]{0,40}-[1-9]\d{0,11}$/;

// Validates a Jira write and builds the stored record, field order included.
function record(input) {
  const { connectionId, kind } = input;
  if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 64 || !['comment', 'status', 'move'].includes(kind)) throw new Error('Invalid guard scope');
  const op = { connectionId, kind, ...(kind === 'move' ? { boardId: input.boardId, issueKeys: input.issueKeys } : { issueKey: input.issueKey }) };
  if (kind === 'move' ? typeof op.boardId !== 'string' || !/^[1-9]\d{0,11}$/.test(op.boardId) || !Array.isArray(op.issueKeys) || op.issueKeys.length < 1 || op.issueKeys.length > 50 || op.issueKeys.some(k => !keyPattern.test(k)) : !keyPattern.test(op.issueKey)) throw new Error('Invalid guard issue keys');
  return op;
}
// The scope hash is made from this string; it must never change.
const key = rec => JSON.stringify([rec.connectionId, rec.kind, rec.kind === 'move' ? '' : rec.issueKey]);

export function createJiraWriteGuard({ dir = () => join(deckDataDir(), STORE_DIR, 'jira-write-guard'), locks } = {}) {
  return createWriteGuard({ name: 'Jira', dir, locks, scope: { record, key } });
}
export const jiraWriteGuard = createJiraWriteGuard();
