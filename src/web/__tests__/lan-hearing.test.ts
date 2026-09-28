// What a deck says while it cannot hear other decks, driven on its own.
//
// lan-port-held.test.ts proves it through an engine whose discovery port is
// really taken. What is pinned here is the rule underneath — the sentence for
// each reason, and who is asked about the port how often — against a beacon
// the test describes and a port-holder the test answers.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import { createHearing } from "../../server/lan-hearing.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { DISCOVERY_PORT } from "../../server/lan-beacon.mjs";

type Beacon = { hearing: () => boolean; deafError?: () => { code?: string; message?: string } | null };

const deafBy = (code: string, message = code): Beacon => ({ hearing: () => false, deafError: () => ({ code, message }) });

/** Let the port-holder's answer land. */
const settle = () => new Promise(r => setTimeout(r, 0));

function rig(beacon: Beacon | null, answers: Array<string | null | Error> = []) {
  const state = { beacon };
  let asked = 0;
  let changes = 0;
  const portHolder = async () => {
    const a = answers[asked++];
    if (a instanceof Error) throw a;
    return a;
  };
  const h = createHearing({ beaconNow: () => state.beacon, portHolder, onChange: () => { changes++; } });
  return { h, state, asked: () => asked, changes: () => changes };
}

describe("the sentence", () => {
  it("is nothing while the deck is down or hears", () => {
    expect(rig(null).h.deafLine()).toBeNull();
    expect(rig({ hearing: () => true }).h.deafLine()).toBeNull();
  });

  it("names the error when the port is not simply taken", () => {
    expect(rig(deafBy("EACCES")).h.deafLine()).toBe(
      `This deck cannot listen on UDP ${DISCOVERY_PORT} (EACCES), so it hears no other deck announce itself. Other decks still find it and pair with it.`,
    );
    const noCode = rig({ hearing: () => false, deafError: () => ({ message: "boom" }) });
    expect(noCode.h.deafLine()).toMatch(new RegExp(`^This deck cannot listen on UDP ${DISCOVERY_PORT} \\(boom\\)`));
  });

  it("says another program holds a taken port until something says which", () => {
    expect(rig(deafBy("EADDRINUSE")).h.deafLine()).toBe(
      `Another program is holding UDP ${DISCOVERY_PORT}, so this deck hears no new decks. Others still find it and pair with it, and it takes the port back as soon as it is free.`,
    );
  });
});

describe("asking who holds the port", () => {
  it("happens once per spell, and the answer is drawn", async () => {
    const r = rig(deafBy("EADDRINUSE"), ["Tailscale"]);
    r.h.hearingChanged(false);
    r.h.hearingChanged(false);
    await settle();
    expect(r.asked()).toBe(1);
    expect(r.h.deafLine()).toMatch(/^Tailscale is holding UDP /);
    // Two changes said at once, and one more when the answer came.
    expect(r.changes()).toBe(3);
  });

  it("starts over when the deck hears again, or is stopped", async () => {
    const r = rig(deafBy("EADDRINUSE"), ["Tailscale", "Syncthing", "Dropbox"]);
    r.h.hearingChanged(false);
    await settle();
    r.h.hearingChanged(true);
    r.h.hearingChanged(false);
    await settle();
    expect(r.asked()).toBe(2);
    expect(r.h.deafLine()).toMatch(/^Syncthing is holding/);
    r.h.forget();
    r.h.hearingChanged(false);
    await settle();
    expect(r.asked()).toBe(3);
  });

  it("is not asked when the port is not taken, or there is nobody to ask", async () => {
    const r = rig(deafBy("EACCES"), ["Tailscale"]);
    r.h.hearingChanged(false);
    await settle();
    expect(r.asked()).toBe(0);
    const none = createHearing({ beaconNow: () => deafBy("EADDRINUSE"), portHolder: null, onChange: () => {} });
    expect(() => none.hearingChanged(false)).not.toThrow();
  });

  it("that fails, or will not say, leaves the plain sentence", async () => {
    for (const answer of [new Error("no powershell"), null]) {
      const r = rig(deafBy("EADDRINUSE"), [answer]);
      r.h.hearingChanged(false);
      await settle();
      expect(r.asked()).toBe(1);
      expect(r.h.deafLine()).toMatch(/^Another program is holding/);
    }
  });
});
