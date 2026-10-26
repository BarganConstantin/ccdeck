import { describe, expect, it, vi } from "vitest";
import { mount, one } from "./fake-react";
import type { Account } from "../claude-accounts";
const { default: AccountRow } = await import("../components/AccountRow");

const account: Account = {
  num: 2, email: "work@example.test", alias: null, org: null, active: false,
  disabled: false, lanes: [], headroom: 0, fetchedAt: null, nextAt: null,
  stale: true, error: "invalid_grant",
};

describe("an account's visible sign-in action", () => {
  it.each([{}, { noCopyWorksNearby: true }])("opens the existing sign-in flow for the expired account (%j)", lan => {
    const onSignIn = vi.fn();
    const onOpenIssue = vi.fn();
    const props = {
      a: account, nowSec: 1_790_000_000, lan, opened: false, onToggleLanes: vi.fn(),
      busy: null, pressProps: () => ({}), onSwitch: vi.fn(), menuOpen: false,
      onOpenMenu: vi.fn(), onCloseMenu: vi.fn(), refusal: null, onDismissRefusal: vi.fn(),
      onSignIn, switchedHere: false, swapped: null, displaced: undefined,
      issueExpanded: false, onOpenIssue,
    };
    const view = mount(AccountRow, props);
    const action = one(view.tree, e => e.props["aria-label"] === "Sign in again as work@example.test")!;
    expect(action).not.toBeNull();
    expect(action.props.children).toBe("Sign in");
    (action.props.onClick as () => void)();
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignIn).toHaveBeenCalledWith(account.email);
    expect(onOpenIssue).not.toHaveBeenCalled();
    expect(one(view.tree, e => e.props.id === "ap-issue-2")).not.toBeNull();
    view.rerender({ ...props, a: { ...account, error: "network" } });
    expect(one(view.tree, e => e.props["aria-label"] === "Sign in again as work@example.test")).toBeNull();
    view.rerender({ ...props, a: { ...account, error: null, staleCopy: true, repair: { state: "running" as const } } });
    expect(one(view.tree, e => e.props.className === "ap-sign-in")).toBeNull();
    view.unmount();
  });
});
