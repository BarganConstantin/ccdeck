// The "Login expired" popover opens with focus on Done.
//
// #1853 put a quiet "Report this" on the left of the popover's answers, first
// in the DOM, and AnchoredPopover let useModalDismiss focus the first tabbable
// control: so the press that opened the popover with the keyboard was followed
// by a focus ring on Report this, and the next Enter opened Send feedback
// instead of closing the popover or fixing the login. The button is meant to be
// subordinate to Done and the fix; the first stop is Done again, as it was
// before 3.33.0, and Report this stays one Shift+Tab away.
//
// No DOM here. The popover's own markup is read off its return value, rendered
// inside a component so its hooks run; AnchoredPopover is a plain wrapper for
// the purpose, since its portal cannot be server-rendered. What is asked is
// what useModalDismiss would focus: the element its focusRef names, or else the
// first control in the dialog.
import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceOf } from "./client-source";

vi.mock("../components/AnchoredPopover", () => ({
  default: ({ children }: { children?: ReactNode }) => children,
}));

import AccountIssuePopover from "../components/AccountIssuePopover";
import type { AccountIssue } from "../account-issue";

type El = ReactElement<{ children?: ReactNode; focusRef?: RefObject<HTMLElement | null>; className?: string }> & { ref?: unknown };

const ISSUE = {
  text: "Login expired", hint: "Its stored login was refused.", tone: "warn", fix: "Sign in again",
} as unknown as AccountIssue;

/** The popover's element tree, as it renders with these handlers. */
function tree(withReport: boolean): El {
  let out: El | null = null;
  const Probe = () => {
    out = AccountIssuePopover({
      anchorId: "a", boundaryId: "b", issue: ISSUE, who: "a@example.invalid", fetchedAt: null, nowSec: 0,
      onClose: () => {}, onSignIn: () => {}, onReport: withReport ? () => {} : undefined,
    }) as El;
    return null;
  };
  renderToStaticMarkup(createElement(Probe));
  return out!;
}

function buttons(node: ReactNode, into: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach(n => buttons(n, into)); return into; }
  if (!node || typeof node !== "object" || !("type" in node)) return into;
  const el = node as El;
  if (el.type === "button") into.push(el);
  buttons(el.props?.children, into);
  return into;
}

const label = (b: El): string => {
  const kids = ([] as ReactNode[]).concat(b.props.children);
  return kids.filter(k => typeof k === "string").join("").trim();
};

/** The control useModalDismiss puts focus on when the popover mounts. */
function firstStop(root: El): string {
  const all = buttons(root.props.children);
  const named = root.props.focusRef;
  const target = named ? all.find(b => b.ref === named) : all[0];
  expect(target, "the focusRef names no button in the popover").toBeTruthy();
  return label(target!);
}

describe("the account issue popover", () => {
  it("opens on Done when Report this is offered", () => {
    const root = tree(true);
    // Report this is still drawn, first on the left.
    expect(buttons(root.props.children).map(label)).toEqual(["Report this", "Done", "Sign in again"]);
    expect(firstStop(root)).toBe("Done");
  });

  it("opens on Done without it, too", () => {
    expect(firstStop(tree(false))).toBe("Done");
  });

  it("hands the popover's focusRef to the dismiss hook", () => {
    // AnchoredPopover is DOM and portal code; its forwarding is read as text.
    const popover = sourceOf("components/AnchoredPopover.tsx");
    expect(popover).toMatch(/\}, \{ popover: true, focusRef \}\);/);
  });
});
