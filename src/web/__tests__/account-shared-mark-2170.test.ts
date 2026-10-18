// Each account's row says whether this deck offers it on Local network (#2170).
//
// That answer lived only in the "Share these accounts" ticks of Local network's
// setup dialog, so somebody keeping a personal login to themselves opened the
// dialog every time to be sure. sharedTo reads the same status those ticks
// write, and the row draws a mark naming the decks the login is offered to.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AccountRow from "../components/AccountRow";
import { sharedLine, sharedTo } from "../account-lan";
import type { Account } from "../claude-accounts";
import type { LanStatus, Peer } from "../lan-types";

const KEY = "me@home.io@@org-a";
const NOW = 1_790_000_000;

function peer(over: Partial<Peer>): Peer {
  return { fp: "fp-x", name: "x", addr: "192.168.1.9", port: 4317, paired: true, ...over };
}

function status(over: Partial<LanStatus> = {}): Pick<LanStatus, "enabled" | "shared" | "peers" | "aliases"> {
  return { enabled: true, shared: [KEY], peers: [], ...over };
}

describe("the decks a login is offered to", () => {
  it("are none at all while the network is off, ticked or not", () => {
    expect(sharedTo(KEY, status({ enabled: false, peers: [peer({ name: "rdp" })] }))).toBeNull();
    expect(sharedTo(KEY, null)).toBeNull();
  });

  it("are none for a login that is not ticked", () => {
    expect(sharedTo(KEY, status({ shared: ["other@home.io@@org-a"], peers: [peer({ name: "rdp" })] }))).toBeNull();
  });

  it("are an empty list for a ticked login with no deck paired yet, which is still shared", () => {
    expect(sharedTo(KEY, status())).toEqual([]);
    expect(sharedTo(KEY, status({ peers: [peer({ name: "nearby", paired: false })] }))).toEqual([]);
  });

  it("are the paired decks by the list's names, one per machine, without those it is not offered to", () => {
    const to = sharedTo(KEY, status({
      aliases: { "fp-mac": "Work Mac" },
      peers: [
        peer({ fp: "fp-rdp", name: "rdp" }),
        peer({ fp: "fp-mac", name: "macbook" }),
        peer({ fp: "fp-rdp-old", name: "rdp" }),
        peer({ fp: "fp-new", name: "studio", notOffered: [KEY] }),
        peer({ fp: "fp-far", name: "far", paired: false }),
      ],
    }));
    expect(to).toEqual(["rdp", "Work Mac"]);
  });
});

describe("what the mark says", () => {
  it("names every deck, or says that none is paired yet", () => {
    expect(sharedLine(["rdp"])).toBe("Shared on Local network: offered to rdp.");
    expect(sharedLine(["mac", "rdp", "studio"])).toBe("Shared on Local network: offered to mac, rdp and studio.");
    expect(sharedLine([])).toBe("Shared on Local network: offered to every deck you pair with. None is paired yet.");
  });
});

describe("the account's row", () => {
  const account = (over: Partial<Account> = {}): Account => ({
    num: 2, email: "me@home.io", alias: null, org: null, orgUuid: "org-a", active: false, disabled: false,
    lanes: [], headroom: 80, fetchedAt: (NOW - 60) * 1000, nextAt: null, stale: false, error: null, ...over,
  });
  const row = (a: Account, sharedTo: readonly string[] | null) => renderToStaticMarkup(createElement(AccountRow, {
    a, nowSec: NOW, lan: { sharedTo }, opened: false, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
    onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
    onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
    issueExpanded: false, onOpenIssue: () => {},
  } as never));

  it("carries the mark, titled and said, when the login is offered", () => {
    const html = row(account(), ["rdp"]);
    expect(html).toContain('class="ap-shared" id="ap-shared-2" title="Shared on Local network: offered to rdp."');
    expect(html).toMatch(/class="vis-hidden">Shared on Local network: offered to rdp\.</);
    // The door covers the mark, so the door says it too.
    expect(html).toMatch(/class="ap-row-open"[^>]*aria-describedby="[^"]*\bap-shared-2\b/);
  });

  it("carries it on the live row as well, which has no door", () => {
    const html = row(account({ active: true }), []);
    expect(html).toContain('id="ap-shared-2"');
    expect(html).not.toContain("ap-row-open");
  });

  it("carries no mark when the login is not offered", () => {
    const html = row(account(), null);
    expect(html).not.toContain("ap-shared");
  });
});
