// OpenAI's sign-in page takes whichever account the browser is already in, so
// "add a second account" can quietly add the first one again. The dialog checks
// who the sign-in landed on before it calls it a new account.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';

vi.mock('react', async () => (await import('./fake-react')).react);
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));
const { default: AddCodexAccountDialog } = await import('../components/AddCodexAccountDialog');

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(over: Record<string, unknown>) {
  vi.useFakeTimers();
  vi.stubGlobal('window', { open: () => null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { body: {}, activeElement: null, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true, json: async () => url.endsWith('login-start')
      ? { ok: true, state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' }
      : { ok: true, state: 'done' },
  })));
  const props = {
    onCreate: vi.fn(async () => 'new-profile'), onCopyCommand: vi.fn(), onClose: vi.fn(),
    onSignedIn: vi.fn(async () => null as string | null), onDiscard: vi.fn(async () => true), ...over,
  };
  const view = mount(AddCodexAccountDialog as never, props as never); cleanup = view.unmount;
  return { view, props };
}

async function signIn(view: { tree: unknown }) {
  (one(view.tree, el => el.type === 'button' && textOf(el) === 'Sign in with ChatGPT')!.props.onClick as () => void)();
  await vi.advanceTimersByTimeAsync(2000);
  await flush();
}

describe('adding a Codex account that is already here', () => {
  it('says the browser decides, before the press', () => {
    const { view } = setup({});
    expect(textOf(view.tree)).toContain('sign out of ChatGPT there first');
  });

  it('takes the repeat back and says why, leaving one row per account', async () => {
    const { view, props } = setup({ onSignedIn: vi.fn(async () => 'one@example.com') });
    await signIn(view);
    expect(props.onDiscard).toHaveBeenCalledWith('new-profile');
    const said = textOf(view.tree);
    expect(said).toContain('Already in your accounts');
    expect(said).toContain('one@example.com');
    expect(said).toContain('private window');
    expect(said).not.toContain('Signed in');
    // Trying again starts over from the first step, with a new account.
    (one(view.tree, el => el.type === 'button' && textOf(el) === 'Try another account')!.props.onClick as () => void)();
    expect(textOf(view.tree)).toContain('Sign in with ChatGPT');
    await signIn(view);
    expect(props.onCreate).toHaveBeenCalledTimes(2);
  });

  it('keeps a row asked to sign in again, and says what it now repeats', async () => {
    const { view, props } = setup({ profile: { id: 'existing', label: 'Row' }, onSignedIn: vi.fn(async () => 'one@example.com') });
    await signIn(view);
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(textOf(view.tree)).toContain('Signed in');
    expect(textOf(view.tree)).toContain('same ChatGPT account as one@example.com');
  });

  it('calls a new account a new account', async () => {
    const { view, props } = setup({});
    await signIn(view);
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(textOf(view.tree)).toContain('The account is ready');
  });
});
