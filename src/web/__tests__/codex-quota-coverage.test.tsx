import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodexQuotaSection } from '../components/QuotaSections';

describe('native Codex quota coverage', () => {
  // The line under the bars saying only the standard limits are counted took
  // three lines of a narrow panel for something nobody acts on (owner,
  // 2026-11-03): native limits draw their bars and nothing more.
  it('adds no line under native standard limits, and no mapping error either', () => {
    const html = renderToStaticMarkup(<CodexQuotaSection codexQuota={{ ok: true, partial: true, coverage: 'standard_limits', windows: [] }} codexLoading={false} codexUsage={null} nowSec={0} />);
    expect(html).not.toContain('up-quota-hint');
    expect(html).not.toContain('Standard Codex limits');
    expect(html).not.toContain("returned limits this build");
    // A plain footnote, not the partial-data box.
    expect(html).not.toContain('up-quota-note');
  });
  it('retains the mapping warning for unrecognized direct endpoint data', () => {
    const html = renderToStaticMarkup(<CodexQuotaSection codexQuota={{ ok: true, partial: true, windows: [] }} codexLoading={false} codexUsage={null} nowSec={0} />);
    expect(html).toContain("returned limits this build");
    // The partial-data note is the box.
    expect(html).toContain('up-quota-sub up-quota-note');
  });
  it.each([1, 3])('shows %s available reset grants and their nearest expiry with native limits', count => {
    const html = renderToStaticMarkup(<CodexQuotaSection codexQuota={{ ok: true, partial: true, coverage: 'standard_limits', windows: [],
      resetCredits: { availableCount: count, nextExpiryAt: Date.parse('2030-01-10T12:30:00Z') } }} codexLoading={false} nowSec={0} />);
    expect(html).toContain(`${count} rate-limit reset`);
    expect(html).toContain('available');
    expect(html).toContain('expires');
    expect(html).not.toContain('Standard Codex limits');
  });
});
