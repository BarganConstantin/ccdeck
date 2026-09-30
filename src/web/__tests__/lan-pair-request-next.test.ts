// Answering one pairing request opens the next one as a new question.
//
// With two decks waiting, the answer to the first comes back with the second
// already in hand, and the dialog was drawn again with the second deck's name,
// address and fingerprint in it. It was the same dialog, so nothing moved the
// keyboard: focus stayed on whichever answer was just pressed. The dialog's own
// rule — a stray Enter or Space lands on the answer that shares nothing — ran
// only when it mounted.
//
// Now each request is its own dialog, keyed by the fingerprint it asks about,
// so the next one mounts fresh: focus goes to Decline as it does on any open,
// and a screen reader entering it is told which deck is asking.
import { describe, expect, it } from "vitest";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LanPairRequests } from "../components/LanPairRequestModal";
import type { LanStranger } from "../lan-types";

const ask = (fp: string, name: string, at: number): LanStranger => ({ fp, name, addr: "192.168.1.9", port: 62259, at });
const first = ask("aa11", "trusted-mac", 1_000);
const second = ask("bb22", "stranger", 2_000);

/** What DeckDialogs mounts for this queue, with answers that go nowhere. */
function dialogFor(lanPending: LanStranger[]) {
  return LanPairRequests({
    lanPending,
    lanDeferred: { current: new Set() },
    lanBusy: null,
    answerLanPair: async () => {},
    deferLanPair: () => {},
  });
}

describe("the next pairing request after an answer", () => {
  it("is a dialog of its own, so it is mounted afresh rather than filled in", () => {
    // React keeps an instance only while type and key both match. Keyed by the
    // request, the dialog for the second deck is a new mount, and the mount is
    // where focus is put on Decline.
    const before = dialogFor([first, second]);
    const after = dialogFor([second]);
    expect(isValidElement(before) && isValidElement(after)).toBe(true);
    expect((before as ReactElement).key).toBe(first.fp);
    expect((after as ReactElement).key).toBe(second.fp);
  });

  it("tells whoever enters it which deck is asking", () => {
    // Moving into a new dialog reads its name, and its description when it has
    // one. The name is the same sentence for every request, so the deck has to
    // be in the description or the second question sounds like the first.
    const html = renderToStaticMarkup(dialogFor([second]) as ReactElement);
    const described = /role="dialog"[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeTruthy();
    const target = new RegExp(`id="${described}"[^>]*>([\\s\\S]*?)</p>`).exec(html)?.[1] ?? "";
    expect(target).toContain(second.name);
    expect(target).toContain(second.addr);
  });
});
