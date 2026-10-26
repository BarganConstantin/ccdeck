// The share mark on the row of the login this deck is on (#2192).
//
// Each account's row carries a mark when this deck offers it on Local network,
// titled with the decks it is offered to (#2170). The login this deck is on is
// still ticked and is not sent while this deck is on it (#2192), and its mark
// went on saying "offered to Laptop" — the one row where that was not true. It
// says so now in the setup dialog's words, "in use here · not sent", and keeps
// the mark, unchanged in shape: the tick is still there, and the login goes out
// the moment this deck switches away.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow from "../components/AccountRow";
import { offeredHere, sharedLine, sharedMarks } from "../account-lan";
import type { Account } from "../claude-accounts";
import type { LanAccount, LanStatus } from "../lan-types";

const WORK = "work@example.test@@org-w";
const HOME = "home@example.test@@org-h";
const NOW = 1_790_000_000;

const held: LanAccount[] = [
  { key: WORK, email: "work@example.test", alive: true, shareable: true, active: true },
  { key: HOME, email: "home@example.test", alive: true, shareable: true },
];

function status(over: Partial<LanStatus> = {}): LanStatus {
  return {
    enabled: true, shared: [WORK, HOME], aliases: {},
    peers: [{ fp: "fp-laptop", name: "Laptop", addr: "192.168.1.9", port: 4317, paired: true }],
    ...over,
  } as LanStatus;
}

/** The marks the accounts panel is handed, as LanSyncSection makes them. */
const marks = (s: LanStatus) => new Map(sharedMarks(offeredHere(held, s), s));

describe("the share mark of the login this deck is on", () => {
  it("says it is in use here and not sent, rather than naming a deck it does not go to", () => {
    const m = marks(status());
    expect(m.get(WORK)).toEqual({ to: ["Laptop"], inUse: true });
    expect(sharedLine(m.get(WORK)!.to, m.get(WORK)!.inUse))
      .toBe("Shared on Local network: in use here · not sent to Laptop while this deck is on it.");
    // Every other ticked login reads as it did.
    expect(m.get(HOME)).toEqual({ to: ["Laptop"], inUse: false });
    expect(sharedLine(m.get(HOME)!.to, m.get(HOME)!.inUse)).toBe("Shared on Local network: offered to Laptop.");
  });

  it("names the decks again when its owner sends that login too", () => {
    const m = marks(status({ sendInUse: true }));
    expect(m.get(WORK)).toEqual({ to: ["Laptop"], inUse: false });
    expect(sharedLine(m.get(WORK)!.to, m.get(WORK)!.inUse)).toBe("Shared on Local network: offered to Laptop.");
  });

  it("says the same with no deck paired yet, and nothing at all while the network is off", () => {
    expect(sharedLine([], true)).toBe("Shared on Local network: in use here · not sent while this deck is on it. None is paired yet.");
    expect(sharedLine([])).toBe("Shared on Local network: offered to every deck you pair with. None is paired yet.");
    expect(marks(status({ enabled: false })).size).toBe(0);
  });
});

describe("the live account's row", () => {
  const live: Account = {
    num: 2, email: "work@example.test", alias: null, org: null, orgUuid: "org-w", active: true, disabled: false,
    lanes: [], headroom: 80, fetchedAt: (NOW - 60) * 1000, nextAt: null, stale: false, error: null,
  } as Account;
  const row = (lan: { sharedTo: readonly string[]; sharedInUse?: boolean }) => renderToStaticMarkup(createElement(AccountRow, {
    a: live, nowSec: NOW, lan, opened: false, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
    onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
    onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {},
  } as never));

  it("carries the same mark, titled and said with that line, and nothing more", () => {
    const kept = "Shared on Local network: in use here · not sent to Laptop while this deck is on it.";
    const html = row({ sharedTo: ["Laptop"], sharedInUse: true });
    expect(html).toContain('class="ap-shared" id="ap-shared-2" role="img" aria-label="Account sharing"');
    expect(html).toContain(`class="vis-hidden">${kept}<`);
    expect(html).not.toContain("offered to Laptop");
    // The markup is the offered row's, but for the line: no new element, no new word on screen.
    const offered = row({ sharedTo: ["Laptop"] });
    expect(html.split(kept).join("§")).toBe(offered.split("Shared on Local network: offered to Laptop.").join("§"));
  });
});
