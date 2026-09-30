// #1800. Four sentences in and around the Local network view sent a reader to
// "the +" — the invite-only line in this deck's settings, the guide's pairing
// tip, the way out under a blocked verdict, and the hint on a deck that only
// calls in. The view's add control has been a chain-link glyph named "Add a
// deck" since #838, and the only + near it is the accounts view's "Add an
// account", which has no invite behind it. So a reader who did what the copy
// said looked for a control that is not drawn, or pressed the wrong one.
//
// Rendered, not read, where it can be: the settings dialog is drawn
// server-side with invite-only on and the portal flattened in place, and the
// line is read out of the markup it produces. The other three are data.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { sourceOf } from "./client-source";

vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));

const { default: LanSetupModal } = await import("../components/LanSetupModal");
const { LAN_STEPS } = await import("../components/guide-art");
const { REACH_WAY_OUT } = await import("../components/LanReachNote");
const { deckRows } = await import("../lan-roster");

const NOW = 1_700_000_000_000;

beforeAll(() => { vi.stubGlobal("document", { body: null }); });
afterAll(() => { vi.unstubAllGlobals(); });

/** The text of the invite-only line, as the dialog draws it. */
function inviteOnlyLine(): string {
  const html = renderToStaticMarkup(createElement(LanSetupModal, {
    status: {
      enabled: true, running: true, name: "Studio", fp: "abcd-ef01-2345-6789", port: 57051,
      pairingMode: "invite", addrs: [], shared: [], peers: [], trusted: [], invite: null,
      pending: [], strangers: [],
    } as never,
    accounts: [],
    onClose: () => {},
    onChanged: () => {},
  }));
  const m = /<span id="lan-invite-only-detail"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  return (m?.[1] ?? "").replace(/<[^>]+>/g, "");
}

/** What the view's add control is named, so the copy is checked against the
 *  control and not against a word this file happens to remember. */
const header = sourceOf("components/LanViewHeader.tsx");

describe("the Local network copy names the add control it draws (#1800)", () => {
  it("draws that control as a link named Add a deck, with no + in it", () => {
    const add = /<button type="button" className="glyph-btn ap-lan-plus"[\s\S]*?<\/button>/.exec(header)?.[0] ?? "";
    expect(add).toMatch(/aria-label="Add a deck"/);
    expect(add).not.toMatch(/>\s*\+\s*</);
  });

  it("says where the invite comes from in this deck's settings", () => {
    const line = inviteOnlyLine();
    expect(line).not.toBe("");
    expect(line).not.toMatch(/\+/);
    expect(line).toMatch(/Add a deck/);
    expect(line).toMatch(/\blink\b/);
    // The half of the line that was never wrong stays.
    expect(line).toMatch(/Paired decks stay paired\./);
  });

  it("says it in the guide's pairing tip", () => {
    const tip = LAN_STEPS[1].tip ?? "";
    expect(tip).not.toMatch(/\+/);
    expect(tip).toMatch(/Add a deck/);
    expect(tip).toMatch(/\blink\b/);
  });

  it("says it in the way out under a blocked verdict, in the view", () => {
    expect(REACH_WAY_OUT.panel).not.toMatch(/\+/);
    expect(REACH_WAY_OUT.panel).toMatch(/Add a deck/);
  });

  it("says it in the hint on a deck that only calls in", () => {
    const [row] = deckRows({
      peers: [{ fp: "aaaa-bbbb-cccc-dddd", peerFp: "aaaa-bbbb-cccc-dddd", name: "Far", addr: "", port: 0,
        paired: true, waiting: true, lastSeen: NOW }],
    }, NOW);
    expect(row.hint).not.toMatch(/\+/);
    expect(row.hint).toMatch(/Add a deck/);
  });
});
