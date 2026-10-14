import { describe, it, expect } from 'vitest';
import { operationDescription, operationFallback, operationPurposeNote } from '../operation-glossary';
import { reportComparisonDescription } from '../tool-audit-report';
import { auditExplanations, auditReadingGuide } from '../tool-audit-education';
import type { AuditRow } from '../tool-audit';
describe('verified general operation purposes', () => {
  it('describes exact verified commands and tool contracts', () => {
    for (const operation of ['rg', 'grep', 'ls', 'cut', 'cat', 'sed', 'head', 'tail', 'git diff', 'git log', 'git status', 'git add', 'git commit', 'sleep', 'write_stdin', 'view_image', 'apply_patch', 'multi_agent_v1__wait_agent', 'shell (unclassified)']) {
      expect(operationDescription(operation)?.purpose.length).toBeGreaterThan(10);
      expect(operationDescription(operation)?.basis).toMatch(/manual|tool-contract|classifier/);
    }
    expect(operationDescription('write_stdin')?.purpose).toContain('read more output');
  });
  it('never guesses semantics from namespace suffixes or interprets arguments', () => {
    for (const operation of ['mcp__unknown__apply_patch', 'functions.rg', 'rg private-token', 'git commit --amend', 'git add --all', 'multi_agent_v1_wait_agent', '__proto__', 'constructor']) expect(operationDescription(operation)).toBeNull();
    expect(operationFallback('mcp__unknown__apply_patch')).toContain('not been verified');
    expect(operationFallback('unknown')).toContain('No verified');
  });
  it('qualifies purposes rather than inventing per-call effects', () => {
    const row = { operation: 'rg', calls: 20 } as AuditRow;
    const text = reportComparisonDescription(row, 'calls');
    expect(text).toContain(operationDescription('rg')!.purpose);
    expect(text).toContain(operationPurposeNote);
    expect(text).toContain('counts are not additive');
  });
});
describe('measurement teaching preserves the contract', () => {
  it('separates percentile meaning from the minimum-sample rule', () => {
    expect(auditExplanations.p95).toContain('95%');
    expect(auditExplanations.p95).toContain('containing-call');
    expect(auditExplanations.p95Example).toContain('95 out of 100');
    expect(auditExplanations.sample).toContain('not the definition');
    expect(auditExplanations.sample).toContain('not the definition of P95 or a confidence guarantee');
    expect(auditReadingGuide.find(([name]) => name === 'Cumulative intervals')![1]).toContain('not elapsed wall-clock');
  });
});
