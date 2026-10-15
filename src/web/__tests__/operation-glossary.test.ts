import { describe, it, expect } from 'vitest';
import { mcpParts, operationDescription, operationName } from '../operation-glossary';

describe('what a tool is for, in plain words', () => {
  it('describes the tools agents use most', () => {
    for (const operation of ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'Agent', 'apply_patch', 'rg', 'sed', 'git status', 'git commit', 'npm test', 'shell (unclassified)']) {
      expect(operationDescription(operation)?.length).toBeGreaterThan(4);
    }
  });
  it('reads a package script and an MCP tool off the name, and nothing more', () => {
    expect(operationDescription('npm run build')).toBe('Runs the “build” script');
    expect(operationDescription('pnpm run lint')).toBe('Runs the “lint” script');
    expect(operationDescription('mcp__chrome-devtools__take_screenshot')).toBe('From the chrome-devtools MCP server');
    expect(mcpParts('mcp__chrome-devtools__take_screenshot')).toEqual({ server: 'chrome-devtools', tool: 'take_screenshot' });
    expect(operationName('mcp__chrome-devtools__take_screenshot')).toBe('take_screenshot');
    expect(operationName('git status')).toBe('git status');
  });
  it('stays silent on anything it does not know instead of guessing', () => {
    for (const operation of ['functions.rg', 'rg private-token', 'git commit --amend', 'multi_agent_v1_wait_agent', 'dotnet test', '__proto__', 'constructor', 'toString']) {
      expect(operationDescription(operation)).toBeNull();
    }
  });
});
