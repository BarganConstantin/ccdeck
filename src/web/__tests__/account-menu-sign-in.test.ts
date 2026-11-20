// The ⋯ menu offers "Sign in again" on a Claude account whose login needs it
// (user feedback): the reader whose stored login expired looked for the fix in
// the account's own menu and found Rename, Move, Share and Remove. The item is
// the row's Sign in by another door — the same verdict decides both — so it is
// absent from every account the row offers no Sign in on.
import { describe, expect, it, vi } from "vitest";
import { all, mount, textOf } from "./fake-react";
import type { Account } from "../claude-accounts";
const { default: AccountMenuPopover } = await import("../components/AccountMenuPopover");

const healthy: Account = {
  num: 2, email: "work@example.test", alias: "work", org: null, active: false,
  disabled: false, lanes: [], headroom: 80, fetchedAt: 1_790_000_000_000, nextAt: null,
  stale: false, error: null,
};

function draw(a: Account, onSignIn?: () => void) {
  const noop = vi.fn();
  const accountMenu = {
    menu: { num: a.num, view: "menu" as const, start: "first" as const },
    menuError: null, aliasDraft: "", confirmRemove: null, share: null, shareCopied: false, slotDraft: null,
    dropMenu: noop, closeMenu: noop, startRename: noop, typeAlias: noop, doAlias: noop, startMove: noop,
    pickSlot: noop, doSlot: noop, makeShare: noop, copyShare: noop, pressRemove: noop,
  };
  const view = mount(AccountMenuPopover as (p: unknown) => unknown, {
    a, slots: [1, 2], nowSec: 1_790_000_000, boundaryId: "ap-scroll",
    accountMenu, busy: null, pressProps: () => ({}),
    onProjects: noop, onRotation: noop, home: false, onHome: noop, onSignIn,
  });
  return all(view.tree, el => el.props.role === "menuitem");
}

describe("the ⋯ menu's sign-in", () => {
  it("comes first on an account whose stored login was refused, and opens the sign-in", () => {
    const onSignIn = vi.fn();
    const items = draw({ ...healthy, error: "invalid_grant" }, onSignIn);
    expect(textOf(items[0])).toBe("Sign in again");
    expect(items).toHaveLength(8);
    (items[0].props.onClick as () => void)();
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it("is there for the collector's own verdicts that only a sign-in clears", () => {
    expect(textOf(draw({ ...healthy, stopped: true, collector: "relogin_required" }, vi.fn())[0])).toBe("Sign in again");
    // Nothing stored yet: the row's fix says "sign in", and so does the menu.
    expect(textOf(draw({ ...healthy, stopped: true, collector: "no_credentials" }, vi.fn())[0])).toBe("Sign in");
  });

  it("is absent wherever the row offers no Sign in", () => {
    const words = (a: Account) => draw(a, vi.fn()).map(textOf);
    const signs = (w: string[]) => w.filter(x => /^Sign in/.test(x));
    expect(signs(words(healthy))).toEqual([]);
    expect(words(healthy)).toHaveLength(7);
    // A stale copy the deck re-captures by itself: the reader IS signed in.
    expect(signs(words({ ...healthy, staleCopy: true, repair: { state: "running" } }))).toEqual([]);
    // Not the account's fault, and not fixed by replacing a working login.
    expect(signs(words({ ...healthy, stopped: true, collector: "keychain_unavailable" }))).toEqual([]);
    // A rate limit, a network blip.
    expect(signs(words({ ...healthy, error: "http-429" }))).toEqual([]);
    expect(signs(words({ ...healthy, error: "network" }))).toEqual([]);
  });

  it("is absent when the panel hands the menu no way to sign in", () => {
    expect(draw({ ...healthy, error: "invalid_grant" }).map(textOf)).not.toContain("Sign in again");
  });
});
