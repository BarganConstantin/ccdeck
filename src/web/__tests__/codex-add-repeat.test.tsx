// OpenAI's sign-in page takes whichever account the browser is already in, so
// "add a second account" can quietly be the first one signing in again. As in
// Claude's dialog that is a success, not a refusal: the account's stored login is
// replaced with this one, and it says so.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, one, textOf, flush } from './fake-react';
import { doneTitle } from '../signin-stages';
import type { SignedIn } from '../components/AddCodexAccountDialog';

vi.mock('react', async () => (await import('./fake-react')).react);
vi.mock('react-dom', () => ({ createPortal: (node: unknown) => node }));
const { default: AddCodexAccountDialog } = await import('../components/AddCodexAccountDialog');

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

const fresh = (account: string): SignedIn => ({ account, repeats: null });
const again = (name: string): SignedIn => ({ account: name, repeats: { id: 'held-row', name } });

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
    onSignedIn: vi.fn(async () => fresh('two@example.com')), onReplace: vi.fn(async () => true), onDiscard: vi.fn(async () => true), ...over,
  };
  const view = mount(AddCodexAccountDialog as never, props as never); cleanup = view.unmount;
  return { view, props };
}

async function signIn(view: { tree: unknown }) {
  (one(view.tree, el => el.type === 'button' && textOf(el) === 'Sign in with ChatGPT')!.props.onClick as () => void)();
  await vi.advanceTimersByTimeAsync(2000);
  await flush();
}

const buttons = (view: { tree: unknown }, label: string) => one(view.tree, el => el.type === 'button' && textOf(el) === label);

describe('adding a Codex account that is already here', () => {
  it('says the browser decides, before the press', () => {
    const { view } = setup({});
    expect(textOf(view.tree)).toContain('sign out of ChatGPT there first');
  });

  it('refreshes the account in place, in Claude\'s words, and ends on one Done', async () => {
    const { view, props } = setup({ onSignedIn: vi.fn(async () => again('one@example.com')) });
    await signIn(view);
    expect(props.onReplace).toHaveBeenCalledWith('new-profile', 'held-row');
    expect(props.onDiscard).not.toHaveBeenCalled();
    const said = textOf(view.tree);
    expect(said).toContain(doneTitle({ num: null, added: false }));
    expect(said).toContain('Credentials refreshed');
    expect(said).toContain('one@example.com was already in the rotation, so its stored login was replaced with this one.');
    expect(buttons(view, 'Done')).toBeTruthy();
    expect(buttons(view, 'Try another account')).toBeFalsy();
  });

  it('throws no confetti for a refresh, and does for a new account', async () => {
    const isConfetti = (el: { props: Record<string, unknown> }) => 'anchor' in el.props;
    const refreshed = setup({ onSignedIn: vi.fn(async () => again('one@example.com')) });
    await signIn(refreshed.view);
    expect(one(refreshed.view.tree, isConfetti)).toBeFalsy();
    refreshed.view.unmount();
    const added = setup({});
    await signIn(added.view);
    expect(one(added.view.tree, isConfetti)).toBeTruthy();
  });

  it('says nothing was added when the login cannot move, and takes the new row back', async () => {
    const { view, props } = setup({ onSignedIn: vi.fn(async () => again('one@example.com')), onReplace: vi.fn(async () => false) });
    await signIn(view);
    expect(props.onDiscard).toHaveBeenCalledWith('new-profile');
    const said = textOf(view.tree);
    expect(said).toContain('Already in your accounts');
    expect(said).toContain('it keeps the login it had');
    expect(said).toContain('private window');
    expect(said).not.toContain('Credentials refreshed');
    // Trying again starts over from the first step, with a new account.
    (buttons(view, 'Try another account')!.props.onClick as () => void)();
    expect(textOf(view.tree)).toContain('Sign in with ChatGPT');
    await signIn(view);
    expect(props.onCreate).toHaveBeenCalledTimes(2);
  });

  it('treats a move that threw as one that did not happen', async () => {
    const { view, props } = setup({ onSignedIn: vi.fn(async () => again('one@example.com')), onReplace: vi.fn(async () => { throw new Error('gone'); }) });
    await signIn(view);
    expect(props.onDiscard).toHaveBeenCalledWith('new-profile');
    expect(textOf(view.tree)).toContain('Already in your accounts');
  });

  it('calls a new account a new account', async () => {
    const { view, props } = setup({});
    await signIn(view);
    expect(props.onReplace).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();
    const said = textOf(view.tree);
    expect(said).toContain('Account added');
    expect(said).toContain('two@example.com is in the rotation. The account you were using is still active.');
  });
});

describe('signing an account in again from its own row', () => {
  it('is a refresh when the same account came back', async () => {
    const { view, props } = setup({
      profile: { id: 'existing', label: 'Row', account: 'one@example.com' },
      onSignedIn: vi.fn(async () => fresh('one@example.com')),
    });
    await signIn(view);
    expect(props.onReplace).not.toHaveBeenCalled();
    expect(textOf(view.tree)).toContain('Credentials refreshed');
    expect(textOf(view.tree)).toContain('one@example.com was already in the rotation');
  });

  it('keeps the row when it landed on another row\'s account, and says what it now repeats', async () => {
    const { view, props } = setup({
      profile: { id: 'existing', label: 'Row', account: 'old@example.com' },
      onSignedIn: vi.fn(async () => again('one@example.com')),
    });
    await signIn(view);
    expect(props.onReplace).not.toHaveBeenCalled();
    expect(props.onDiscard).not.toHaveBeenCalled();
    expect(textOf(view.tree)).toContain('Signed in');
    expect(textOf(view.tree)).toContain('same ChatGPT account as one@example.com');
  });

  it('is an ordinary sign-in for a row that had no login', async () => {
    const { view } = setup({ profile: { id: 'existing', label: 'Row', account: null } });
    await signIn(view);
    expect(textOf(view.tree)).toContain('Signed in');
    expect(textOf(view.tree)).toContain('The account is ready');
    expect(textOf(view.tree)).not.toContain('Credentials refreshed');
  });
});
