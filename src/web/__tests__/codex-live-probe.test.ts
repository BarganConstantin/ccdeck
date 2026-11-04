import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error server ES module
import { probeCodexLiveDaemon } from '../../server/codex-live-rpc.mjs';

describe('read-only Codex daemon discovery retry', () => {
  const snapshot = { status: 'running', appServerVersion: '0.166.0', socketPath: '/private/synthetic.sock' };
  const success = () => ({ stdout: JSON.stringify(snapshot) });
  const probe = (execFile: ReturnType<typeof vi.fn>) => probeCodexLiveDaemon('/synthetic/codex',
    { CODEX_HOME: '/private/synthetic' }, { platform: 'linux', execFile });

  it('returns immediately when the first probe succeeds', async () => {
    const execFile = vi.fn().mockResolvedValue(success());
    expect(await probe(execFile)).toEqual(snapshot);
    expect(execFile).toHaveBeenCalledOnce();
  });

  it.each(['timeout', 'command', 'json'])('recovers from a temporary %s failure before any account RPC', async kind => {
    const execFile = vi.fn();
    if (kind === 'json') execFile.mockResolvedValueOnce({ stdout: '{' });
    else execFile.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_NATIVE_ERROR'), kind === 'timeout' ? { killed: true } : { code: 1 }));
    execFile.mockResolvedValue(success());
    expect(await probe(execFile)).toEqual(snapshot);
    expect(execFile).toHaveBeenCalledTimes(2);
    for (const [file, args, options] of execFile.mock.calls) {
      expect(file).toBe('/synthetic/codex');
      expect(args).toEqual(['app-server', 'daemon', 'version']);
      expect(options).toMatchObject({ env: { CODEX_HOME: '/private/synthetic' }, timeout: 5000, windowsHide: true });
    }
  });

  it('bounds persistent failure to three probes and retains only a safe diagnostic', async () => {
    const execFile = vi.fn().mockRejectedValue(Object.assign(new Error('PRIVATE_NATIVE_ERROR'), { killed: true, stderr: 'PRIVATE_CREDENTIAL' }));
    const pending = probe(execFile).catch((error: Error) => error);
    const error = await pending;
    expect(error).toMatchObject({ code: 'native_unavailable', cause: { code: 'native_probe_timeout' } });
    expect(execFile).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE/);
  });

  it.each(['ENOENT', 'EACCES', 'EPERM'])('does not retry a permanent %s executable failure', async code => {
    const execFile = vi.fn().mockRejectedValue(Object.assign(new Error('PRIVATE_PATH'), { code }));
    await expect(probe(execFile)).rejects.toMatchObject({ code: 'native_unavailable', cause: { code: 'native_probe_command_failed' } });
    expect(execFile).toHaveBeenCalledOnce();
  });

  it.each(['stopped', 'starting'])('does not retry a valid %s response or start the daemon', async status => {
    const execFile = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ status }) });
    expect(await probe(execFile)).toEqual({ status });
    expect(execFile).toHaveBeenCalledOnce();
  });
});
