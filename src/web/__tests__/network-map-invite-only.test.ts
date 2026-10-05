// On a deck that pairs by invite only, the network map told the reader to do
// something the deck cannot do.
//
// With nothing pointed at, the panel's last line is the one thing worth doing
// about the network, and for a machine heard nearby that was "Open it to ask to
// pair." In invite mode that machine's own dialog has no Ask to pair — it
// offers an invite instead (LanPeerFoot) — and the same panel, pointed at the
// same machine, already said so: "This deck pairs by invite only." The two
// halves of one panel now agree.
import { describe, expect, it } from "vitest";

import { deckNextStep, mapSummary, networkNextStep } from "../lan-network-map";
import type { DeckRow } from "../lan-roster";
import { sourceOf } from "./client-source";

let seq = 0;
function nearby(): DeckRow {
  seq += 1;
  return {
    fp: `fp-${seq}`, name: `deck-${seq}`, addr: "192.168.1.10",
    kind: "nearby", state: "needs an invite", tone: "idle", here: true, hint: "",
  };
}

describe("what the map's panel says to do about a deck nearby", () => {
  it("does not send the reader to ask a nearby deck to pair when this one pairs by invite only", () => {
    const one = networkNextStep(mapSummary([nearby()]), "invite")!;
    expect(one).not.toMatch(/ask to pair/i);
    expect(one).toBe("1 deck nearby is not paired. This deck pairs by invite only. Send one from Add a deck.");
    expect(networkNextStep(mapSummary([nearby(), nearby()]), "invite"))
      .toBe("2 decks nearby are not paired. This deck pairs by invite only. Send one from Add a deck.");
  });

  it("says what the panel says about the same deck when it is pointed at", () => {
    expect(networkNextStep(mapSummary([nearby()]), "invite")).toContain(deckNextStep(nearby(), "invite")!);
  });

  it("still sends the reader to ask where asking is how this deck pairs", () => {
    expect(networkNextStep(mapSummary([nearby()]), "automatic")).toBe("1 deck nearby is not paired. Open it to ask to pair.");
    expect(networkNextStep(mapSummary([nearby()]))).toBe("1 deck nearby is not paired. Open it to ask to pair.");
  });

  it("is told by the map how this deck pairs", () => {
    expect(sourceOf("components/LanNetworkMap.tsx")).toMatch(/networkNextStep\(summary, status\?\.pairingMode\)/);
  });
});
