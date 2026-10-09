import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecodedPayload, TelemetryCapture, outcomeLabel } from '../components/TelemetryCapture';
import type { CaptureSnapshot, CapturedExport } from '../use-telemetry-capture';
import { LOGS } from './traffic-capture-fixture.mjs';
const capture: CaptureSnapshot = { ok: true, sessionId: null, state: 'idle', destination: null, interface: null, startedAt: null, expiresAt: null, lastInputAt: null, bytes: 0, issues: {}, events: [] };
const props = { capture, radar: null, failed: false, busy: false, error: '', command: '', action: async () => {} };
describe('telemetry content inspection', () => {
  it('explains activation without declaring an idle receiver safe or telemetry disabled', () => {
    const markup = renderToStaticMarkup(<TelemetryCapture {...props} />);
    expect(markup).toContain('Start monitoring'); expect(markup).toContain('Message capture is off');
    expect(markup).toContain('HTTPS contents cannot be decoded');
    expect(markup).not.toMatch(/safe|protected|telemetry is disabled/i);
  });
  it('shows permissions, expiry, plaintext-only coverage and process attribution limits', () => {
    const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={{ ...capture, state: 'awaiting' }} command='synthetic command' />);
    expect(markup).toContain('Only tcpdump asks for administrator permission'); expect(markup).toContain('Ctrl+C');
    expect(markup).toContain('not only Claude'); expect(markup).toContain('after 10 minutes'); expect(markup).toContain('Closing this modal does not stop capture');
  });
  it('makes incomplete capture and encryption limitations visible', () => {
    const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={{ ...capture, state: 'capturing', issues: { encrypted: 1, joined_midstream: 1 } }} />);
    expect(markup).toContain('contents cannot be read'); expect(markup).toContain('Waiting for a new HTTP/2 connection');
    expect(markup).toContain('Stop monitoring');
  });
  it('renders actual OTLP body and typed attributes without reconstructing local transcripts', () => {
    const markup = renderToStaticMarkup(<DecodedPayload payload={LOGS} signal='logs' />);
    expect(markup).toContain('Synthetic fixture'); expect(markup).toContain('Explain this synthetic example.');
    expect(markup).toContain('Prompt-related field included in this export'); expect(markup).toContain('Resource metadata');
    expect(markup).toContain('All record fields');
  });
  it('escapes content instead of interpreting HTML inside prompts', () => {
    const payload = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: '<script>alert(1)</script>' } }] }] }] };
    const markup = renderToStaticMarkup(<DecodedPayload payload={payload} signal='logs' />);
    expect(markup).not.toContain('<script>'); expect(markup).toContain('&lt;script&gt;');
  });
  it('shows measurements and units without requiring a JSON inspection', () => {
    const payload = { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'tokens.used', unit: '{token}', sum: { dataPoints: [{ asInt: '9223372036854775806' }] } }] }] }] };
    const markup = renderToStaticMarkup(<DecodedPayload payload={payload} signal='metrics' />);
    expect(markup).toContain('Value'); expect(markup).toContain('9223372036854775806 {token}');
  });
  it('derives a trace duration from the actual captured timestamps', () => {
    const payload = { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'tool.Read', startTimeUnixNano: '1700000000000000000', endTimeUnixNano: '1700000000025000000' }] }] }] };
    const markup = renderToStaticMarkup(<DecodedPayload payload={payload} signal='traces' />);
    expect(markup).toContain('Duration'); expect(markup).toContain('25 ms');
  });
  it('does not turn a connection or unconfirmed transfer into collector acceptance', () => {
    expect(outcomeLabel({ outcome: 'unconfirmed' } as CapturedExport)).toContain('unconfirmed');
    expect(outcomeLabel({ outcome: 'partial' } as CapturedExport)).toContain('partial');
    expect(outcomeLabel({ outcome: 'accepted' } as CapturedExport)).toBe('Collector accepted');
  });
});


it('explains Windows PowerShell activation without a text pipeline or macOS-only instructions', () => {
  const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={{ ...capture, state: 'awaiting', shell: 'PowerShell', platform: 'win32' }} command='synthetic command' />);
  expect(markup).toContain('Activate in PowerShell'); expect(markup).toContain('Wireshark with Npcap'); expect(markup).not.toContain('Only tcpdump');
});
