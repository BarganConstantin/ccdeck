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
  it.each([1, 3])('shows %s available reset grants and their nearest expiry with native limits', count => {
    const html = renderToStaticMarkup(<CodexQuotaSection codexQuota={{ ok: true, partial: true, coverage: 'standard_limits', windows: [],
      resetCredits: { availableCount: count, nextExpiryAt: Date.parse('2030-01-10T12:30:00Z') } }} codexLoading={false} nowSec={0} />);
    expect(html).toContain(`${count} rate-limit reset`);
    expect(html).toContain('available');
    expect(html).toContain('expires');
    expect(html).toContain('available resets; additional limits and credit balances');
    expect(html).not.toContain('additional limits and credits are not included');
  });
});
