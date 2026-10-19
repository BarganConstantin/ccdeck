import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecodedPayload, TelemetryCapture, outcomeLabel } from '../components/TelemetryCapture';
import type { CaptureSnapshot, CapturedExport } from '../use-telemetry-capture';
import { LOGS } from './traffic-capture-fixture.mjs';
const capture: CaptureSnapshot = { ok: true, automatic: false, sessionId: null, state: 'idle', destination: null, interface: null, startedAt: null, expiresAt: null, lastInputAt: null, bytes: 0, issues: {}, events: [] };
const props = { capture, radar: null, failed: false, busy: false, error: '', command: '', action: async () => {} };
describe('telemetry content inspection', () => {
  it('explains activation without declaring an idle receiver safe or telemetry disabled', () => {
    const markup = renderToStaticMarkup(<TelemetryCapture {...props} />);
    expect(markup).toContain('Start monitoring'); expect(markup).toContain('Message capture is off');
    expect(markup).toContain('HTTPS contents cannot be decoded');
    expect(markup).not.toMatch(/safe|protected|telemetry is disabled/i);
  });
  it('shows permissions, continuous capture, plaintext-only coverage and process attribution limits', () => {
    const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={{ ...capture, state: 'awaiting' }} command='synthetic command' />);
    expect(markup).toContain('Only tcpdump asks for administrator permission'); expect(markup).toContain('Ctrl+C');
    expect(markup).toContain('not only Claude'); expect(markup).toContain('continues until you stop it'); expect(markup).toContain('Closing this modal does not stop capture');
  });
  it('makes incomplete capture and encryption limitations visible', () => {
    const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={{ ...capture, state: 'capturing', issues: { encrypted: 1, joined_midstream: 1 } }} />);
    expect(markup).toContain('contents cannot be read'); expect(markup).toContain('Waiting for a new HTTP/2 connection');
    expect(markup).toContain('Stop monitoring');
  });
  it('renders actual OTLP body and typed attributes without reconstructing local transcripts', () => {
    const markup = renderToStaticMarkup(<DecodedPayload payload={LOGS} signal='logs' />);
    expect(markup).toContain('Synthetic fixture'); expect(markup).toContain('Explain this synthetic example.');
    expect(markup).toContain('<dt>Prompt</dt>'); expect(markup).toContain('Resource metadata');
    expect(markup).toContain('All record fields');
  });
  it('prioritizes useful fields while keeping technical attributes in closed details', () => {
    const attributes = Object.entries({ model: 'test-model', input_tokens: '0', success: false, prompt: 'Hello', prompt_text: 'Hello', 'session.id': 'technical-session', 'request_id': 'technical-request' }).map(([key, value]) => ({ key, value: typeof value === 'boolean' ? { boolValue: value } : { stringValue: value } }));
    const payload = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes }] }] }] };
    const markup = renderToStaticMarkup(<DecodedPayload payload={payload} signal='logs' />);
    expect(markup).toContain('<dt>Model</dt>');
    expect(markup).toContain('test-model');
    expect(markup).toContain('<dt>Input tokens</dt>');
    expect(markup).toContain('>0</pre>');
    expect(markup).toContain('>false</pre>');
    expect(markup.match(/data-field="Prompt"/g)).toHaveLength(1);
    expect(markup).not.toContain('technical-session');
    expect(markup).not.toContain('technical-request');
    expect(markup).toContain('<summary>All record fields</summary>');
  });
  it('makes redacted prompts and missing project paths explicit', () => {
    const payload = { resourceLogs: [{ scopeLogs: [{ logRecords: [{ eventName: 'claude_code.user_prompt', attributes: [{ key: 'prompt', value: { stringValue: '[REDACTED]' } }] }] }] }] };
    const markup = renderToStaticMarkup(<DecodedPayload payload={payload} signal='logs' />);
    expect(markup).toContain('Redacted in export');
    expect(markup).toContain('No matching local working directory');
    expect(markup).toContain('not the original text');
    expect(markup).not.toContain('>[REDACTED]</pre>');
  });
  it('puts prompt events before startup metadata and keeps other events disclosed', () => {
    const payload = { resourceLogs: [{ resource: { attributes: [{ key: 'cwd', value: { stringValue: '/work/ccdeck' } }] }, scopeLogs: [{ logRecords: [
      { eventName: 'plugin.loaded', attributes: [{ key: 'plugin.name', value: { stringValue: 'hidden-plugin' } }] },
      { eventName: 'claude_code.user_prompt', attributes: [{ key: 'prompt_text', value: { stringValue: 'Show this prompt first' } }] },
    ] }] }] };
    const markup = renderToStaticMarkup(<DecodedPayload payload={payload} signal='logs' />);
    expect(markup).toContain('/work/ccdeck');
    expect(markup).toContain('Show this prompt first');
    expect(markup).toContain('Other events (1)');
    expect(markup).not.toContain('hidden-plugin');
    expect(markup).not.toContain('plugin.loaded');
  });
  it('distinguishes matched local project context from data actually exported', () => {
    const markup = renderToStaticMarkup(<DecodedPayload payload={LOGS} signal='logs' sessions={[{ id: 'fixture-session', label: 'ccdeck', workspace: '/local/ccdeck' }]} />);
    expect(markup).toContain('/local/ccdeck');
    expect(markup).toContain('Local ccdeck context');
    expect(markup).toContain('Project path is not present in the export');
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

it('shows continuous managed monitoring without Terminal steps or a time limit', () => {
  const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={{ ...capture, automatic: true, managed: true, enabled: true, state: 'receiving', sources: [{ destination: '127.0.0.1:4317', interface: 'lo0', active: true, bytes: 0 }] }} command='must not be shown' />);
  expect(markup).toContain('Continuous local monitoring'); expect(markup).toContain('Settings → Radar'); expect(markup).not.toContain('>Stop monitoring</button>');
  expect(markup).not.toContain('Activate in'); expect(markup).not.toContain('must not be shown'); expect(markup).not.toContain('10 minutes');
});
it('keeps automatic retry active while capture is denied and explains the required permission', () => {
  const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={{ ...capture, automatic: true, platform: 'darwin', managed: true, enabled: true, state: 'interrupted', sources: [{ destination: '127.0.0.1:4317', interface: 'lo0', active: false, bytes: 0, error: 'Packet capture permission is required.' }] }} />);
  expect(markup).toContain('Capture permission needed'); expect(markup).not.toContain('>Stop monitoring</button>'); expect(markup).toContain('ChmodBPF'); expect(markup).toContain('retries automatically');
  // ccdeck runs this capture itself: no command screen is drawn, so the copy
  // must not hold a Terminal command up as the alternative.
  expect(markup).not.toContain('Terminal');
});
it('names PowerShell, not Terminal, when unmanaged Windows activation must be generated again', () => {
  const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={{ ...capture, state: 'awaiting', shell: 'PowerShell', platform: 'win32' }} />);
  expect(markup).toContain('Generate the PowerShell instructions again'); expect(markup).toContain('Show activation instructions');
  expect(markup).not.toContain('Terminal');
});

it('has no Start or Stop controls while automatic capture is loading or waiting for a collector', () => {
  for (const value of [null, { ...capture, automatic: true, featureEnabled: true, managed: true, enabled: false, state: 'idle' as const }]) {
    const markup = renderToStaticMarkup(<TelemetryCapture {...props} capture={value} />);
    expect(markup).not.toContain('>Start monitoring</button>');
    expect(markup).not.toContain('>Stop monitoring</button>');
    expect(markup).not.toContain('Capture destination');
    expect(markup).toContain('Waiting for traffic');
  }
});
