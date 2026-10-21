/** One plain line per known tool or command: what it is for in general, never
 *  what a recorded call did (arguments and output are not kept). Exact names
 *  only, plus two shapes that can be read off the name itself: `<pm> run <x>`
 *  and `mcp__<server>__<tool>`. Anything else gets no line rather than a guess. */
const entries: Record<string, string> = {
  // Claude Code
  Read: 'Reads a file',
  Edit: 'Changes part of a file',
  MultiEdit: 'Makes several changes to one file',
  Write: 'Creates or overwrites a file',
  NotebookEdit: 'Changes a Jupyter notebook cell',
  Grep: 'Searches file contents',
  Glob: 'Finds files by name',
  LS: 'Lists a folder',
  WebFetch: 'Opens a web page',
  WebSearch: 'Searches the web',
  Agent: 'Hands work to a subagent',
  Task: 'Hands work to a subagent',
  TodoWrite: 'Updates the agent’s to-do list',
  Skill: 'Loads a skill',
  ToolSearch: 'Looks up another tool',
  // Codex
  apply_patch: 'Changes files',
  update_plan: 'Updates the agent’s plan',
  view_image: 'Looks at an image file',
  write_stdin: 'Talks to a running command',
  multi_agent_v1__wait_agent: 'Waits for other agents to finish',
  // Shell commands
  rg: 'Searches file contents',
  grep: 'Searches text',
  ls: 'Lists a folder',
  cat: 'Prints a file',
  sed: 'Prints or edits text',
  head: 'Shows the start of a file',
  tail: 'Shows the end of a file',
  find: 'Finds files',
  wc: 'Counts lines or words',
  cut: 'Picks columns out of text',
  sort: 'Sorts lines',
  jq: 'Reads JSON',
  curl: 'Makes a web request',
  sleep: 'Waits',
  node: 'Runs a Node.js script',
  python: 'Runs a Python script',
  python3: 'Runs a Python script',
  git: 'Runs Git',
  'git status': 'Shows what changed',
  'git diff': 'Shows the exact changes',
  'git log': 'Shows the commit history',
  'git show': 'Shows one commit',
  'git add': 'Stages changes',
  'git commit': 'Saves a commit',
  'git push': 'Uploads commits',
  'git pull': 'Downloads and merges commits',
  'git fetch': 'Downloads commits',
  'git checkout': 'Switches branch or restores files',
  'git switch': 'Switches branch',
  'git branch': 'Lists or changes branches',
  'git merge': 'Merges a branch',
  'git rebase': 'Replays commits on another base',
  'git stash': 'Puts changes aside',
  'git restore': 'Restores files',
  'git reset': 'Moves the branch or unstages changes',
  'git worktree': 'Manages worktrees',
  'npm test': 'Runs the project’s tests',
  'npm install': 'Installs packages',
  'npm ci': 'Installs packages from the lock file',
  'gh pr': 'Works with GitHub pull requests',
  'gh issue': 'Works with GitHub issues',
  'gh run': 'Works with GitHub Actions runs',
  'gh api': 'Calls the GitHub API',
  'shell (unclassified)': 'A shell command ccdeck could not name',
  'exec (unclassified)': 'A Codex script ccdeck could not name',
  'tool (unclassified)': 'A tool with an unreadable name',
};

export function operationDescription(operation: string): string | null {
  if (Object.hasOwn(entries, operation)) return entries[operation];
  const script = /^(npm|pnpm|yarn|bun) run (.+)$/.exec(operation);
  if (script) return `Runs the “${script[2]}” script`;
  const mcp = mcpParts(operation);
  if (mcp) return `From the ${mcp.server} MCP server`;
  return null;
}

/** `mcp__chrome-devtools__take_screenshot` → server `chrome-devtools`, tool `take_screenshot`. */
export function mcpParts(operation: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(operation);
  return match ? { server: match[1], tool: match[2] } : null;
}

/** What a row is called: an MCP tool by its own name, everything else as recorded. */
export const operationName = (operation: string) => mcpParts(operation)?.tool ?? operation;
