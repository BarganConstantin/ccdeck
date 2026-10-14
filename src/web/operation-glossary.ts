/** Verified general purposes only. Exact identities prevent misleading MCP suffix matches. */
export interface OperationDescription { purpose: string; basis: 'manual' | 'tool-contract' | 'classifier' }
const entries = {
  rg: { purpose: 'Search for matching text across files.', basis: 'manual' },
  cat: { purpose: 'Read and combine file contents or input into output.', basis: 'manual' },
  sed: { purpose: 'Filter and transform text using editing rules.', basis: 'manual' },
  head: { purpose: 'Show the beginning of a file or text input.', basis: 'manual' },
  tail: { purpose: 'Show the end of a file or text input.', basis: 'manual' },
  'git diff': { purpose: 'Show differences between code versions or working changes.', basis: 'manual' },
  'git status': { purpose: 'Show staged, unstaged and untracked Git working-tree changes.', basis: 'manual' },
  'git commit': { purpose: 'Record staged changes in Git history.', basis: 'manual' },
  sleep: { purpose: 'Wait for a specified duration.', basis: 'manual' },
  write_stdin: { purpose: 'Send input to, or read more output from, an existing process.', basis: 'tool-contract' },
  view_image: { purpose: 'Inspect an image stored in a local file.', basis: 'tool-contract' },
  apply_patch: { purpose: 'Apply structured changes to files.', basis: 'tool-contract' },
  multi_agent_v1__wait_agent: { purpose: 'Wait for one or more agents to reach a final status.', basis: 'tool-contract' },
  'shell (unclassified)': { purpose: 'A shell command whose concrete operation could not be reliably identified.', basis: 'classifier' },
} as const satisfies Record<string, OperationDescription>;
export function operationDescription(operation: string): OperationDescription | null {
  return Object.hasOwn(entries, operation) ? entries[operation as keyof typeof entries] : null;
}
export const operationPurposeNote = 'General purpose only; recorded arguments and outputs are not available.';
export function operationFallback(operation: string) {
  return operation.startsWith('mcp__') ? 'MCP integration tool. Its specific purpose has not been verified.' : 'No verified general description is available for this operation.';
}
