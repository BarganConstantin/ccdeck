// What the Codex panel's tests share. The panel draws Claude's own AccountRow and
// OtherAccounts, and the fake React renders no child component, so a row is
// found by the props it was handed, and read by running AccountRow itself: it
// holds no state, so that is the row a person would see.
import AccountRow from "../components/AccountRow";
import OtherAccounts from "../components/OtherAccounts";
import { all, one, textOf, type Drawn } from "./fake-react";

type View = { tree: unknown };
type RowProps = Parameters<typeof AccountRow>[0];

// The suite has no DOM. The panel's clock and its focus rescue are the only parts
// that reach for the window, and they go through the timers a test has faked.
(globalThis as { window?: unknown }).window ??= {
  setInterval: (run: () => void, ms: number) => setInterval(run, ms),
  clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
  requestAnimationFrame: () => 0,
  dispatchEvent: () => true,
};

export const isFold = (el: Drawn) => el.type === OtherAccounts;

const nameOf = (a: RowProps["a"]) => a.alias ?? a.email;

export function rowOf(view: View, name: string): Drawn | undefined {
  return all(view.tree, el => el.type === AccountRow).find(el => nameOf(el.props.a as RowProps["a"]) === name);
}

/** Everything the row says on screen, in the row's own words. */
export function rowText(row: Drawn): string {
  return textOf(AccountRow(row.props as unknown as RowProps));
}

/** Press the "Other accounts" row. */
export function openOthers(view: View) {
  (one(view.tree, isFold)!.props.onToggle as () => void)();
}

/** Press a row's ⋯. */
export function openMenuOf(view: View, name: string) {
  const row = rowOf(view, name)!;
  (row.props.onOpenMenu as (num: number) => void)((row.props.a as RowProps["a"]).num);
}
