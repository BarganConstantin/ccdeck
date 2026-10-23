// What the Local network settings dialog says about the login this deck is on
// (#2192): the row it keeps here says so, and "Send the login this deck is
// using too" is a switch that is off until somebody turns it on — and says
// what it costs only while it is on.
//
// Rendered, not read: the dialog is drawn server-side with the portal
// flattened in place, as lan-add-a-deck-copy-1800.test.ts draws it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("react-dom", async (orig) => ({ ...(await orig<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));

const { default: LanSetupModal } = await import("../components/LanSetupModal");
const { offeredHere } = await import("../account-lan");

beforeAll(() => { vi.stubGlobal("document", { body: null }); });
afterAll(() => { vi.unstubAllGlobals(); });

const WORK = "work@example.test@@org-w";
const HOME = "home@example.test@@org-h";
const held = [
  { key: WORK, email: "work@example.test", alive: true, shareable: true, active: true },
  { key: HOME, email: "home@example.test", alive: true, shareable: true },
];

function dialog(sendInUse: boolean | undefined, shared: string[] = [WORK, HOME]) {
  const status = {
    enabled: true, running: true, name: "Studio", fp: "abcd-ef01-2345-6789", port: 57051,
    pairingMode: "automatic", autoAsk: true, autoAccept: true, addrs: [], shared, peers: [],
    trusted: [], invite: null, pending: [], strangers: [],
    ...(sendInUse === undefined ? {} : { sendInUse }),
  };
  return renderToStaticMarkup(createElement(LanSetupModal, {
    status: status as never,
    // What LanSyncSection hands the dialog: the roster through offeredHere.
    accounts: offeredHere(held, status),
    onClose: () => {},
    onChanged: () => {},
  }));
}

/** The row of the account `email` in "Share these accounts": its title, and its text. */
function rowOf(html: string, email: string) {
  const label = [...html.matchAll(/<label class="ap-lan-pick"[^>]*>[\s\S]*?<\/label>/g)].map(m => m[0])
    .find(l => l.includes(`>${email}<`)) ?? "";
  return {
    title: /^<label[^>]*title="([^"]*)"/.exec(label)?.[1] ?? "",
    text: label.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  };
}

/** The switch element named `label`, as drawn. */
const switchNamed = (html: string, label: string) =>
  new RegExp(`<button[^>]*role="switch"[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? "";

describe("the login this deck is on, in the Local network settings", () => {
  it("is kept here by default, and its row says so", () => {
    const html = dialog(undefined);
    const send = switchNamed(html, "Send the login this deck is using too");
    expect(send).toContain('aria-checked="false"');
    expect(send).toContain('data-tone="warn"');
    expect(send).not.toContain("aria-describedby");
    expect(html).not.toContain('id="lan-send-in-use-detail"');
    // Beside the account it is about, and only that one.
    expect(html).toMatch(/work@example\.test<\/span><span class="ap-lan-dead">in use here · not sent<\/span>/);
    expect(html.match(/in use here · not sent/g)).toHaveLength(1);
  });

  it("is sent once its owner turns that on, and the switch then says what it costs", () => {
    const html = dialog(true);
    const send = switchNamed(html, "Send the login this deck is using too");
    expect(send).toContain('aria-checked="true"');
    expect(send).toContain('aria-describedby="lan-send-in-use-detail"');
    // Not "if the other machine uses it": claude-swap renews an idle copy too.
    expect(html).toContain("The other machine renews its copy even when idle, and whichever renews it second is signed out.");
    expect(html).not.toContain("in use here · not sent");
  });

  it("leaves the switch above it as it was", () => {
    const html = dialog(undefined);
    const tells = switchNamed(html, "Show paired decks which of these this deck is using");
    expect(tells).toContain('aria-checked="true"');
    expect(tells).toContain("Stop telling paired decks which account this one is on. They read “current account hidden” instead.");
  });
});

describe("the row of the login this deck is on, in Share these accounts", () => {
  it("says nothing beside it while it is not ticked, as 3.43.3 did", () => {
    const html = dialog(undefined, [HOME]);
    expect(rowOf(html, "work@example.test").text).toBe("work@example.test");
    expect(html).not.toContain("in use here · not sent");
  });

  it("is titled with what ticking it does while this deck is on it, not with a repair it does not make", () => {
    for (const shared of [[WORK, HOME], [HOME]]) {
      const { title } = rowOf(dialog(undefined, shared), "work@example.test");
      expect(title).toBe("Offer this account to the decks you have paired with. While this deck is on it, it stays here, "
        + "and it goes out like the others once this deck switches away. Unticking stops it being offered from now on; "
        + "it does not take back a copy somebody already has.");
    }
    // Every other working login keeps its title.
    expect(rowOf(dialog(undefined), "home@example.test").title).toContain("so one whose copy has died can heal from yours");
    // And with the login in use sent too, it is offered like the others.
    expect(rowOf(dialog(true), "work@example.test").title).toContain("so one whose copy has died can heal from yours");
  });
});
