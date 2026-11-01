// Codex's column on Claude's own row: what a profile and its reading become, and
// the moments a person actually hits. The one that started this file: a second
// account added, and its row stuck on "Quota unavailable: profile changed".
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush, type Drawn } from './fake-react';
import { openMenuOf, openOthers, rowOf, rowText } from './codex-panel-helpers';
import { codexAccount, codexIssue, lanesOf, nextReading, readingFor, type CodexProfile, type ProfileQuota } from '../codex-accounts';

vi.mock('react', async () => (await import('./fake-react')).react);
const { default: CodexProfilesSection } = await import('../components/CodexProfilesSection');

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

const NOW = 1_800_000_000_000;
const profile = (over: Partial<CodexProfile> = {}): CodexProfile => ({
  id: 'p', label: 'person@example.com', account: 'person@example.com', identityVersion: 'v', active: false,
  signedInFilePresent: true, authSource: 'native', signedIn: true, available: true, ...over,
});
const reading = (over: Partial<ProfileQuota> = {}): ProfileQuota => ({
  ok: true, identityVersion: 'v', fetchedAt: NOW, windows: [{ usedPercent: 40, seconds: 604800, resetAt: 1_800_100_000 }], ...over,
});

describe('a Codex reading, as the row reads it', () => {
  it('names a window as Claude\'s column does, so its order choices work on it', () => {
    expect(lanesOf(reading({ windows: [
      { usedPercent: 10, seconds: 18000, resetAt: null }, { usedPercent: 20, seconds: 604800, resetAt: null },
    ] }))).toEqual([
      expect.objectContaining({ id: 'five_hour', label: '5h', pct: 10 }),
      expect.objectContaining({ id: 'seven_day', label: '7d', pct: 20 }),
    ]);
    // A plan with one window has one bar: Codex's own answer, not a gap.
    expect(lanesOf(reading())).toHaveLength(1);
  });

  it('reads the room left from the fullest window, and says when the next read is', () => {
    const a = codexAccount(profile({ active: true }), 1, reading({ windows: [
      { usedPercent: 10, seconds: 18000, resetAt: null }, { usedPercent: 97, seconds: 604800, resetAt: null },
    ] }), { nowMs: NOW });
    expect(a.headroom).toBe(3);
    expect(a.nextAt).toBe(NOW + 60_000);
    expect(codexAccount(profile(), 2, reading(), { nowMs: NOW }).nextAt).toBe(NOW + 300_000);
  });

  it('calls a row by its name, then its email, then its place', () => {
    expect(codexAccount(profile({ managedLabel: 'work' }), 2, null, { nowMs: NOW })).toMatchObject({ alias: 'work', email: 'person@example.com' });
    expect(codexAccount(profile({ account: null, label: 'Codex profile 2' }), 2, null, { nowMs: NOW })).toMatchObject({ alias: null, email: 'Codex profile 2' });
  });

  it('draws an old reading as a record, and a held-out account as held out', () => {
    expect(codexAccount(profile(), 2, reading({ fetchedAt: NOW - 16 * 60_000 }), { nowMs: NOW }).stale).toBe(true);
    expect(codexAccount(profile(), 2, reading(), { nowMs: NOW }).stale).toBe(false);
    expect(codexAccount(profile(), 2, null, { nowMs: NOW, heldOut: ['p'] }).disabled).toBe(true);
  });

  it('keeps the numbers through a read that failed in passing, and not through one that says the login is dead', () => {
    const good = reading();
    expect(nextReading(good, { ok: false, reason: 'timeout' })).toMatchObject({ ok: false, stale: true, lastGood: good });
    expect(nextReading(good, { ok: false, reason: 'reauth_required' })).toEqual({ ok: false, reason: 'reauth_required' });
    expect(nextReading(null, { ok: false, reason: 'timeout' })).toEqual({ ok: false, reason: 'timeout' });
  });

  it('never shows a reading taken for another login as this row\'s', () => {
    expect(readingFor(profile(), reading({ identityVersion: 'other' }))).toEqual({ ok: false, reason: 'profile_changed' });
  });
});

describe('what is wrong with a Codex account', () => {
  it('has nothing to say about a login that moved during a read', () => {
    expect(codexIssue(profile(), { ok: false, reason: 'profile_changed' }, [])).toBeNull();
  });

  it.each([
    ['expired', 'Login expired', 'Sign in again', true],
    ['reauth_required', 'Login expired', 'Sign in again', true],
    ['no_token', 'Not signed in', 'Sign in', true],
    ['api_key_mode', 'Uses an API key', null, false],
    ['http_429', 'Rate limited', null, false],
    ['timeout', 'Temporary error', null, false],
    ['unsupported', 'Usage not available', null, false],
  ])('says %s in the product\'s voice', (reason, text, fix, blocksSwitch) => {
    expect(codexIssue(profile(), { ok: false, reason }, [])).toMatchObject({ text, fix, blocksSwitch });
  });

  it('tells a signed-out account from one nobody could read', () => {
    expect(codexIssue(profile({ signedIn: false }), null, [])).toMatchObject({ text: 'Not signed in', blocksSwitch: true });
    expect(codexIssue(profile({ signedIn: undefined, metadataUnavailable: true, metadataReason: 'cli_unavailable' }), null, []))
      .toMatchObject({ text: 'Codex not found', blocksSwitch: false });
  });

  it('says a second row on one ChatGPT account is that, and how to make it another', () => {
    const roster = [profile({ id: 'd', active: true }), profile({ id: 'r', sameAccountAs: 'd' })];
    const issue = codexIssue(roster[1], reading(), roster)!;
    expect(issue).toMatchObject({ text: 'Same as your default', fix: 'Sign in', tone: 'warn', blocksSwitch: false });
    expect(issue.hint).toContain('sign out of ChatGPT');
  });
});

/** A deck with `profiles`, whose quota route answers from `quota`. */
async function deck(profiles: () => CodexProfile[], quota: (id: string) => ProfileQuota, extra: (url: string, body: unknown) => unknown = () => null) {
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    const body = options?.body ? JSON.parse(String(options.body)) : undefined;
    if (options?.method === 'POST') posts.push({ url, body });
    const answer = extra(url, body);
    if (answer) return { ok: true, status: 200, json: async () => answer };
    if (url === '/api/codex-profiles') return { ok: true, json: async () => ({ revision: 7, profiles: profiles() }) };
    if (url.startsWith('/api/codex-profile-quota')) return { ok: true, json: async () => quota(new URL(url, 'http://x').searchParams.get('id')!) };
    return { ok: false, json: async () => ({}) };
  }));
  const view = mount(() => CodexProfilesSection()); cleanup = view.unmount;
  await flush();
  return { view, posts };
}

describe('the panel, on the moments that matter', () => {
  it('asks again when a login moved during a read, and the row never shows an error for it', async () => {
    vi.useFakeTimers();
    let settled = false;
    const roster = [profile({ id: 'd', label: 'one@example.com', account: 'one@example.com', identityVersion: 'one', active: true }), profile({ id: 'n', label: 'two@example.com', account: 'two@example.com', identityVersion: 'two' })];
    const { view } = await deck(() => roster, id => id === 'd'
      ? reading({ identityVersion: 'one' })
      : settled ? reading({ identityVersion: 'two' }) : { ok: false, reason: 'profile_changed' });
    openOthers(view);
    expect(rowText(rowOf(view, 'two@example.com')!)).toContain('Reading usage…');
    expect(rowText(rowOf(view, 'two@example.com')!)).not.toContain('changed');
    settled = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect((rowOf(view, 'two@example.com')!.props.a as { lanes: unknown[] }).lanes).toHaveLength(1);
  });

  it('does not call a row being read "never collected"', async () => {
    const roster = [profile({ id: 'd', label: 'd', account: 'd', active: true }), profile({ id: 'o', label: 'o', account: 'o', sameAccountAs: 'd' })];
    const { view } = await deck(() => roster, id => id === 'd' ? reading() : { ok: false, reason: 'profile_changed' });
    openOthers(view);
    const row = rowText(rowOf(view, 'o')!);
    expect(row).toContain('Same as your default');
    expect(row).toContain('Reading usage…');
    expect(row).not.toContain('never collected');
  });

  it('tells the Usage panel when the default moves, so it does not stay on the old account', async () => {
    const said: string[] = [];
    vi.stubGlobal('window', { ...(globalThis as unknown as { window: object }).window, dispatchEvent: (event: Event) => { said.push(event.type); return true; } });
    let active = 'd';
    const roster = () => [profile({ id: 'd', label: 'd', account: 'd', active: active === 'd' }), profile({ id: 'o', label: 'o', account: 'o', active: active === 'o' })];
    const { view } = await deck(roster, () => reading(), url => {
      if (url !== '/api/codex-profile-select') return null;
      active = 'o';
      return { ok: true };
    });
    openOthers(view);
    expect(said).toEqual([]);
    await (rowOf(view, 'o')!.props.onSwitch as (num: number, name: string) => Promise<void>)(2, 'o');
    await flush();
    expect(said).toEqual(['ccdeck:codex-default-moved']);
  });

  it('reads the default account each minute and the others every five', async () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    const roster = [profile({ id: 'd', label: 'd', account: 'd', active: true }), profile({ id: 'o', label: 'o', account: 'o' })];
    await deck(() => roster, id => { reads.push(id); return reading(); });
    reads.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toEqual(['d']);
    reads.length = 0;
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(reads.filter(id => id === 'd')).toHaveLength(4);
    expect(reads.filter(id => id === 'o')).toHaveLength(1);
  });

  it('puts the default account\'s trouble above the list, with the sign-in that fixes it', async () => {
    const { view } = await deck(() => [profile({ id: 'd', active: true })], () => ({ ok: false, reason: 'reauth_required' }));
    expect(textOf(view.tree)).toContain('Current account needs attention');
    const fix = one(view.tree, el => el.type === 'button' && el.props.className === 'ap-notice-fix')!;
    (fix.props.onClick as () => void)();
    expect(one(view.tree, (el: Drawn) => typeof el.type === 'function' && 'onSignedIn' in el.props)?.props.profile).toMatchObject({ id: 'd' });
  });

  it('offers no Switch to an account that cannot be switched to, and a Sign in instead', async () => {
    const { view } = await deck(() => [profile({ id: 'd', active: true, account: 'd', label: 'd' }), profile({ id: 'o', account: null, label: 'Codex profile 2', signedIn: false })], () => reading({ identityVersion: 'v' }));
    openOthers(view);
    const row = rowText(rowOf(view, 'Codex profile 2')!);
    expect(row).toContain('Not signed in');
    expect(row).toContain('Sign in');
    expect(row).not.toContain('Switch');
  });

  it('renames an account from its ⋯, and an empty name takes the name away', async () => {
    let name: string | undefined = 'work';
    const { view, posts } = await deck(() => [profile({ id: 'a'.repeat(20), active: true, managedLabel: name })], () => reading(),
      (url, body) => {
        if (url !== '/api/codex-profile-rename') return null;
        name = (body as { label: string }).label || undefined;
        return { ok: true };
      });
    openMenuOf(view, 'work');
    (one(view.tree, el => el.type === 'button' && textOf(el) === 'Rename')!.props.onClick as () => void)();
    const field = one(view.tree, el => el.type === 'input')!;
    expect(field.props.value).toBe('work');
    (field.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: '' } });
    (one(view.tree, el => el.type === 'form')!.props.onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault() {} });
    await flush();
    expect(posts).toEqual([{ url: '/api/codex-profile-rename', body: { id: 'a'.repeat(20), label: '', expectedRevision: 7 } }]);
    expect(rowOf(view, 'person@example.com')).toBeTruthy();
    expect(one(view.tree, el => el.type === 'form')).toBeFalsy();
  });

  it('draws Auto-switch behind the fold, and only once there is another account to go to', async () => {
    const status = { ok: true, enabled: true, external: false, lastTick: null, settings: { 'autoswitch.threshold': { value: '85', isDefault: false } }, choice: { next: 'room', home: null }, heldOut: ['o'] };
    const answer = (url: string) => url === '/api/codex-auto' ? status : null;
    const alone = await deck(() => [profile({ id: 'd', active: true })], () => reading(), answer);
    expect(one(alone.view.tree, el => typeof el.type === 'function' && 'thresholdPick' in el.props)).toBeFalsy();
    alone.view.unmount();
    const { view } = await deck(() => [profile({ id: 'd', active: true, account: 'd', label: 'd' }), profile({ id: 'o', account: 'o', label: 'o' })], () => reading(), answer);
    openOthers(view);
    expect(one(view.tree, el => typeof el.type === 'function' && 'thresholdPick' in el.props)?.props.threshold).toBe('85');
    expect(rowText(rowOf(view, 'o')!)).toContain('held out');
    expect(rowText(rowOf(view, 'o')!)).not.toContain('Switch');
  });
});
