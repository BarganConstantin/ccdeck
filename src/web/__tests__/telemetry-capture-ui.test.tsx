import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DecodedPayload, TelemetryCapture, outcomeLabel } from '../components/TelemetryCapture';
import type { CaptureSnapshot, CapturedExport, PermissionResult } from '../use-telemetry-capture';
import { LOGS } from './traffic-capture-fixture.mjs';
// What the deck's own capture answers now: monitoring is always on (traffic-radar-service.mjs).
const capture: CaptureSnapshot = { ok: true, automatic: true, featureEnabled: true, managed: true, enabled: false, sessionId: null, state: 'idle', destination: null, interface: null, startedAt: null, expiresAt: null, lastInputAt: null, bytes: 0, issues: {}, events: [] };
const props = { capture, radar: null, failed: false, busy: false, error: '', action: async () => {} };
const listening = { ...capture, enabled: true, state: 'receiving' as const, sources: [{ destination: '127.0.0.1:4317', interface: 'lo0', active: true, bytes: 0 }] };
const denied = (platform: string) => ({ ...capture, platform, enabled: true, state: 'interrupted' as const, sources: [{ destination: '127.0.0.1:4317', interface: 'lo0', active: false, bytes: 0, error: 'Packet capture permission is required.' }] });
const missing = (platform: 'linux' | 'win32') => ({ ...capture, platform, state: 'error' as const,
  setupError: platform === 'linux' ? 'Install tcpdump to capture traffic. Configuration and file inspection work without it.' : 'Install Wireshark with Npcap to capture traffic. Configuration and file inspection work without it.' });
const render = (extra: Partial<Parameters<typeof TelemetryCapture>[0]>) => renderToStaticMarkup(<TelemetryCapture {...props} {...extra} />);
describe('telemetry content inspection', () => {
  it('says monitoring runs by itself without declaring an idle receiver safe or telemetry disabled', () => {
    const markup = render({});
    expect(markup).toContain('Waiting for traffic'); expect(markup).toContain('Radar monitors automatically when a collector is available');
    expect(markup).toContain('HTTPS contents cannot be decoded');
    expect(markup).not.toMatch(/safe|protected|telemetry is disabled/i);
  });
  it('shows continuous capture, plaintext-only coverage and process attribution limits', () => {
    const markup = render({ capture: listening });
    expect(markup).toContain('Continuous local monitoring'); expect(markup).toContain('Monitoring is always on');
    expect(markup).toContain('not only Claude'); expect(markup).toContain('Closing this modal does not stop capture');
    expect(markup).not.toContain('Settings → Radar'); expect(markup).not.toContain('Turn monitoring off'); expect(markup).not.toContain('10 minutes');
  });
  it('makes incomplete capture and encryption limitations visible', () => {
    const markup = render({ capture: { ...listening, state: 'capturing', issues: { encrypted: 1, joined_midstream: 1 } } });
    expect(markup).toContain('contents cannot be read'); expect(markup).toContain('Waiting for a new HTTP/2 connection');
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

// Monitoring is always on (the owner, 2026-10-23): no state draws Start, Stop,
// a destination picker or the Terminal steps of the unmanaged capture — not
// while the capture is still loading, not on a deck that answers automatic:false.
it('never draws Start, Stop, a destination picker or Terminal activation', () => {
  const states: (CaptureSnapshot | null)[] = [null, capture, { ...capture, automatic: false, featureEnabled: undefined }, { ...capture, managed: false, state: 'awaiting', destination: '192.0.2.16:4317' }, listening, denied('darwin'), missing('linux')];
  for (const value of states) {
    const markup = render({ capture: value });
    for (const gone of ['Start monitoring', 'Stop monitoring', 'Capture destination', 'Another IPv4 address', 'Choose a destination', 'Message capture is off', 'Activate in', 'Show activation instructions', 'Ctrl+C'])
      expect(markup, `${gone} in ${JSON.stringify(value?.state ?? null)}`).not.toContain(gone);
  }
});
// On, with no collector found yet: the header says where Radar is looking, and
// draws no empty Destination group; one appears with the first destination.
it('says where it is looking until a collector is found, then names the destinations', () => {
  const looking = render({ capture });
  expect(looking).toContain('Waiting for a collector…');
  expect(looking).toContain('Looking for the collector in Claude Code&#x27;s settings and connections.');
  expect(looking).not.toContain('aria-label="Monitored destinations"');
  expect(looking).not.toContain('the listener is not ready yet');
  const found = render({ capture: listening });
  expect(found).toContain('aria-label="Monitored destinations"'); expect(found).toContain('<code>127.0.0.1:4317</code>');
  expect(found).toContain('1 of 1 destination listening'); expect(found).not.toContain('Looking for the collector');
  const named = render({ capture: { ...capture, enabled: true, state: 'awaiting', destination: '192.0.2.16:4317' } });
  expect(named).toContain('aria-label="Monitored destinations"'); expect(named).toContain('<code>192.0.2.16:4317</code>');
  expect(named).toContain('Monitoring is enabled; the listener is not ready yet.'); expect(named).not.toContain('Looking for the collector');
  const starting = render({ capture: { ...listening, state: 'awaiting', sources: [{ ...listening.sources[0], active: false }] } });
  expect(starting).toContain('Monitoring is enabled; the listener is not ready yet.'); expect(starting).toContain('Not listening');
});
it('draws no setup card while capture is allowed', () => {
  for (const value of [capture, listening, { ...listening, state: 'capturing' as const }]) expect(render({ capture: value })).not.toContain('Allow packet capture once');
});

describe('Allow packet capture once', () => {
  it('on macOS, says what the password does before asking for it', () => {
    const markup = render({ capture: denied('darwin') });
    expect(markup).toContain('Capture permission needed'); expect(markup).toContain('Allow packet capture once');
    expect(markup).toContain('which macOS lets only an administrator read');
    expect(markup).toContain('asks for your password once'); expect(markup).toContain('small ccdeck helper'); expect(markup).toContain('after every restart');
    expect(markup).toContain('stays on this Mac');
    expect(markup).toContain('>Allow capture…</button>');
    // A region named by its title; only the outcome line is a live region, so a
    // screen reader is not read the whole card again on every refresh.
    expect(markup).toContain('<section class="tr-activation" aria-labelledby="tr-setup-title"><strong id="tr-setup-title">Allow packet capture once</strong>');
    expect(markup.match(/<section class="tr-activation"[^>]*role=/)).toBeNull(); expect(markup).toContain('<div role="status"></div></section>');
    // ccdeck sets this up itself: no Wireshark helper to install, no Terminal command.
    expect(markup).not.toContain('ChmodBPF'); expect(markup).not.toContain('Terminal'); expect(markup).not.toContain('wiki.wireshark.org');
  });
  it('on Linux, names installing tcpdump only when tcpdump is missing', () => {
    const install = render({ capture: missing('linux') });
    expect(install).toContain('Capture setup needed'); expect(install).toContain('which Linux lets only an administrator read');
    expect(install).toContain('Allow capture asks for your password once, installs tcpdump and lets tcpdump capture for your user only.'); expect(install).toContain('>Allow capture…</button>');
    const permission = render({ capture: denied('linux') });
    expect(permission).toContain('Capture permission needed'); expect(permission).toContain('Allow capture asks for your password once and lets tcpdump capture for your user only.');
    expect(permission).not.toContain('installs tcpdump'); expect(permission).toContain('stays on this computer');
  });
  // While the card explains what is missing, the rest of Monitor says what
  // happens once it is allowed rather than repeating the refusal.
  it('says Radar listens once capture is allowed, without repeating the refusal around the card', () => {
    const found = render({ capture: denied('darwin') });
    expect(found).toContain('Radar found the collector and listens as soon as capture is allowed.');
    expect(found).toContain('<code>127.0.0.1:4317</code>'); expect(found).not.toContain('class="tr-source-error"');
    expect(found).not.toContain('Packet capture permission is required.');
    expect(found).toContain('<h4>Not listening yet</h4>'); expect(found).toContain('Messages appear here once packet capture is allowed.');
    expect(found).not.toContain('Waiting for traffic'); expect(found).not.toContain('Radar monitors automatically when a collector is available');
    const none = render({ capture: missing('linux') });
    expect(none).toContain('Radar listens as soon as capture is allowed.'); expect(none).not.toContain('Radar found the collector');
    expect(none).not.toContain('Looking for the collector'); expect(none).toContain('<h4>Not listening yet</h4>');
    // Without the card, a source's own error still shows beside it.
    const other = render({ capture: { ...listening, sources: [{ ...listening.sources[0], active: false, error: 'Capture disconnected. Retrying automatically.' }] } });
    expect(other).toContain('<span class="tr-source-error">Capture disconnected. Retrying automatically.</span>');
    expect(other).not.toContain('listens as soon as capture is allowed'); expect(other).not.toContain('Not listening yet');
  });
  it('hides the raw setup error while the card explains it, and shows any other one', () => {
    expect(render({ capture: missing('linux') })).not.toContain('Configuration and file inspection work without it');
    const other = render({ capture: { ...capture, platform: 'linux', state: 'error', setupError: 'Npcap interfaces are unavailable.' } });
    expect(other).toContain('Npcap interfaces are unavailable.'); expect(other).not.toContain('Allow packet capture once');
  });
  it('on Windows, offers Wireshark instead of a password prompt', () => {
    const install = render({ capture: missing('win32') });
    expect(install).toContain('which on Windows needs Wireshark with Npcap'); expect(install).toContain('Install Wireshark once and keep Npcap ticked in its installer');
    expect(install).toContain('<a class="btn primary" href="https://www.wireshark.org/download.html"'); expect(install).toContain('>Get Wireshark</a>');
    expect(install).not.toContain('Allow capture…'); expect(install).not.toContain('password');
    const restricted = render({ capture: denied('win32') });
    expect(restricted).toContain('Npcap is limited to administrators'); expect(restricted).not.toContain('Install Wireshark once');
    expect(restricted).not.toContain('Allow capture…');
  });
  it('waits on the password prompt with a busy, still focusable button', () => {
    const markup = render({ capture: denied('darwin'), busy: true, pendingAction: 'permission' });
    expect(markup).toMatch(/<button type="button" class="btn primary" aria-busy="true">Waiting for your password…<\/button>/);
    expect(markup).not.toContain('>Allow capture…</button>');
  });
  it('says what each answer came to', () => {
    const answer = (permission: PermissionResult, platform = 'darwin') => render({ capture: denied(platform), permission });
    expect(answer({ outcome: 'cancelled' })).toContain('Nothing changed. Allow capture when you are ready.');
    expect(answer({ outcome: 'granted' })).toContain('Capture allowed. Starting monitoring…');
    const unavailable = answer({ outcome: 'unavailable', message: 'No password prompt can open in this session.', command: 'sudo sh /home/u/.agents-deck/radar-capture-setup.sh' }, 'linux');
    expect(unavailable).toContain('No password prompt can open in this session. Run this once in a terminal instead:');
    expect(unavailable).toContain('>Copy command</button>'); expect(unavailable).toContain('<pre class="tr-command">sudo sh /home/u/.agents-deck/radar-capture-setup.sh</pre>');
    const failed = answer({ outcome: 'failed', message: 'The password was not accepted.' }, 'linux');
    expect(failed).toContain('The password was not accepted.'); expect(failed).not.toContain('Copy command'); expect(failed).not.toContain('in a terminal');
    for (const outcome of ['cancelled', 'granted'] as const) expect(answer({ outcome })).not.toContain('Copy command');
  });
});
