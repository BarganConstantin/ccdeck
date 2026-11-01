// The Tool and Skill activity reports run in a worker, and a worker cannot start
// when the folder the deck was started from has been deleted: Node asks the
// process for its directory while it sets the worker up, and the report failed
// with `ENOENT: no such file or directory, uv_cwd` for as long as the deck ran.
//
// The deleted folder has to be the real process's, so each case runs in a child
// process of its own. Where a folder in use cannot be deleted (Windows) the
// directory stays valid and the report must work all the same.
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const module = fileURLToPath(new URL('../../server/tool-audit.mjs', import.meta.url));

function inGoneDirectory(body: string) {
  const script = `
    const { mkdtempSync, rmSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ccdeck-gone-'));
    process.chdir(dir);
    try { rmSync(dir, { recursive: true }); } catch {}
    (async () => {
      const audit = await import(${JSON.stringify('file://' + module.replace(/\\/g, '/'))});
      ${body}
    })().catch(e => { console.log(JSON.stringify({ error: String(e && e.message || e) })); });
  `;
  const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30_000, cwd: process.cwd() });
  return JSON.parse(run.stdout.trim().split('\n').pop() || '{}');
}

describe('a report asked for after the deck\'s folder was deleted', () => {
  it('runs: the worker starts from a directory that exists', () => {
    const out = inGoneDirectory(`
      const report = await audit.workerReport({ files: [], query: { view: 'tools' }, now: Date.now(), meta: {} });
      console.log(JSON.stringify({ ok: typeof report === 'object', cwdExists: (() => { try { process.cwd(); return true; } catch { return false; } })() }));
    `);
    expect(out).toEqual({ ok: true, cwdExists: true });
  });

  it('moves the process out of a missing directory, and leaves a valid one alone', () => {
    const out = inGoneDirectory(`
      audit.ensureUsableCwd();
      const first = process.cwd();
      audit.ensureUsableCwd();
      console.log(JSON.stringify({ stable: first === process.cwd(), valid: typeof first === 'string' }));
    `);
    expect(out).toEqual({ stable: true, valid: true });
  });
});
