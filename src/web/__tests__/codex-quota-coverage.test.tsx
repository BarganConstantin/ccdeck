import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodexQuotaSection } from '../components/QuotaSections';

describe('native Codex quota coverage', () => {
  it('explains omitted coverage without claiming a mapping error', () => {
    const html = renderToStaticMarkup(<CodexQuotaSection codexQuota={{ ok: true, partial: true, coverage: 'standard_limits', windows: [] }} codexLoading={false} codexUsage={null} nowSec={0} />);
    expect(html).toContain('additional limits and credits are not included');
    expect(html).not.toContain("returned limits this build");
  });
  it('retains the mapping warning for unrecognized direct endpoint data', () => {
    const html = renderToStaticMarkup(<CodexQuotaSection codexQuota={{ ok: true, partial: true, windows: [] }} codexLoading={false} codexUsage={null} nowSec={0} />);
    expect(html).toContain("returned limits this build");
  });
});
