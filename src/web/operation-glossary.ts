import { t } from './i18n';

/** One plain line per known tool or command (text in the insights catalog): what it is for in general, never
 *  what a recorded call did (arguments and output are not kept). Exact names
 *  only, plus two shapes that can be read off the name itself: `<pm> run <x>`
 *  and `mcp__<server>__<tool>`. Anything else gets no line rather than a guess. */
const known = new Set([
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task',
  'TodoWrite',
  'Skill',
  'ToolSearch',
  'apply_patch',
  'update_plan',
  'view_image',
  'write_stdin',
  'multi_agent_v1__wait_agent',
  'rg',
  'grep',
  'ls',
  'cat',
  'sed',
  'head',
  'tail',
  'find',
  'wc',
  'cut',
  'sort',
  'jq',
  'curl',
  'sleep',
  'node',
  'python',
  'python3',
  'git',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git add',
  'git commit',
  'git push',
  'git pull',
  'git fetch',
  'git checkout',
  'git switch',
  'git branch',
  'git merge',
  'git rebase',
  'git stash',
  'git restore',
  'git reset',
  'git worktree',
  'npm test',
  'npm install',
  'npm ci',
  'gh pr',
  'gh issue',
  'gh run',
  'gh api',
  'shell (unclassified)',
  'exec (unclassified)',
  'tool (unclassified)',
]);

/** The key of a known operation's line in the catalog ("git status" -> insights.op.git_status). */
const opKey = (operation: string) => `insights.op.${operation.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;

/** The line for an operation, in the language on show; the English `entries`
 *  above stay as the list of names that have one (and for tests). */
export function operationDescription(operation: string): string | null {
  if (known.has(operation)) return t(opKey(operation));
  const script = /^(npm|pnpm|yarn|bun) run (.+)$/.exec(operation);
  if (script) return t('insights.op.script', { script: script[2] });
  const mcp = mcpParts(operation);
  if (mcp) return t('insights.op.mcp', { server: mcp.server });
  return null;
}

/** `mcp__chrome-devtools__take_screenshot` → server `chrome-devtools`, tool `take_screenshot`. */
export function mcpParts(operation: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(operation);
  return match ? { server: match[1], tool: match[2] } : null;
}

/** What a row is called: an MCP tool by its own name, everything else as recorded. */
export const operationName = (operation: string) => mcpParts(operation)?.tool ?? operation;
