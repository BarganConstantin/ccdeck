// Invite-only pairing, as the panel and its dialogs present it (#1236).
//
// The engine side of the mode is pinned in lan-engine.test.ts. What is pinned
// here is what a person SEES while it is on: that a machine they can no longer
// ask is still a machine they can pair (by invite, from where they are
// looking), that neither end is told something untrue, and that the control is
// the dialog's own kind rather than a second one to learn.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deckRows, roundLabel } from "../components/LanSyncSection";
import { normalise } from "../../server/deck-prefs.mjs";

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
const setup = read("../components/LanSetupModal.tsx");
const peerModal = read("../components/LanPeerModal.tsx");
const addModal = read("../components/LanAddDeckModal.tsx");
const section = read("../components/LanSyncSection.tsx");

const stranger = { fp: "aaaa-bbbb-cccc-dddd", name: "Laptop", addr: "192.168.1.20" };

describe("invite-only, in the panel's own words (#1236)", () => {
  it("names what a nearby machine takes, instead of a row that reads as unpairable", () => {
    const now = Date.now();
    const auto = deckRows({ strangers: [stranger] } as never, now).find(r => r.kind === "nearby");
    const invite = deckRows({ strangers: [stranger], pairingMode: "invite" } as never, now)
      .find(r => r.kind === "nearby");
    expect(auto?.state).toBe("not paired yet");
    expect(invite?.state).toBe("needs an invite");
  });

  it("says either end's refusal as a state, not as a red fault", () => {
    const now = Date.now();
    expect(roundLabel({ at: now, error: "that deck pairs only by invite" } as never, now))
      .toEqual({ text: "it pairs only by invite", tone: "idle" });
    expect(roundLabel({ at: now, error: "this deck pairs only by invite" } as never, now))
      .toEqual({ text: "needs an invite · your setting", tone: "idle" });
  });

  it("stores only a real mode, and reads anything else as automatic", () => {
    expect(normalise({ lan: { pairingMode: "invite" } }).lan.pairingMode).toBe("invite");
    expect(normalise({ lan: { pairingMode: "INVITE" } }).lan.pairingMode).toBe("automatic");
    expect(normalise({}).lan.pairingMode).toBe("automatic");
  });
});

describe("the controls that say it (#1236)", () => {
  it("is a switch like its neighbours, pressed through the dialog's own press rule", () => {
    // Native radios in a dialog of track-and-knob switches, and `disabled` on
    // the focused one, which drops keyboard focus to <body> (#518).
    expect(setup).not.toMatch(/type="radio"/);
    expect(setup).toMatch(/aria-label="Pair new decks only by invite"[\s\S]{0,200}\{\.\.\.pressProps\("mode"\)\}/);
  });

  it("pauses both automatic pairs in place rather than hiding one and leaving the other live", () => {
    for (const tag of ["ask", "accept", "tailscale-ask", "tailscale-accept"]) {
      expect(setup, tag).toContain(`{...autoProps("${tag}")}`);
    }
    expect(setup).not.toMatch(/pairingMode !== "invite" && <div className="lan-switches">/);
  });

  it("groups each automatic pair under a caption that says invite-only is holding it", () => {
    expect(setup).toMatch(/<div className="lan-auto" role="group" aria-labelledby="lan-auto-h">\s*<p className="lan-sub" id="lan-auto-h">\s*Automatic pairing/);
    expect(setup).toMatch(/<div className="lan-auto" role="group" aria-labelledby="lan-ts-auto-h">\s*<p className="lan-sub" id="lan-ts-auto-h">\s*Automatic pairing with my devices/);
    expect(setup.match(/\{inviteOnly && <span className="lan-sub-state"> · paused while pairing is invite-only<\/span>\}/g)).toHaveLength(2);
  });

  it("leaves a nearby or declined machine one verb — an invite — on its row and in its dialog", () => {
    expect(section).toMatch(
      /\(p\.kind === "nearby" \|\| p\.kind === "declined"\) && status\?\.pairingMode === "invite"[\s\S]{0,200}setAddOpen\("invite"\)/,
    );
    expect(peerModal).toMatch(
      /\(row\.kind === "nearby" \|\| row\.kind === "declined"\) && status\.pairingMode === "invite" && onInvite/,
    );
    // And the add dialog opened through that door arrives with the invite made.
    expect(addModal).toMatch(/if \(startWith !== "invite" \|\| madeOnArrival\.current \|\| live\) return;/);
  });

  it("says the row's invite opens a dialog, the way the row's own door does", () => {
    const invite = /<button type="button" className="ap-manage-btn ap-lan-do"([^>]*?)onClick=\{\(\) => setAddOpen\("invite"\)\}/.exec(section);
    expect(invite, "the row's invite button was not found").not.toBeNull();
    expect(invite![1]).toMatch(/aria-haspopup="dialog"/);
  });

  it("names the invite's copy for what it copies, since focus lands on it once one is made", () => {
    // A bare "copy" named nothing. The name keeps the visible word in it
    // (2.5.3) in both states, and the expiry describes it.
    const copy = /<button type="button" className="ap-manage-btn" ref=\{copyRef\}[^>]*?>/.exec(addModal)?.[0] ?? "";
    expect(copy, "the invite's copy button was not found").not.toBe("");
    expect(copy).toMatch(/aria-label=\{copied === "invite" \? "Invite copied" : "Copy invite"\}/);
    expect(copy).toMatch(/aria-describedby="lan-invite-left"/);
    expect(addModal).toMatch(/<span className="ap-lan-invite-left" id="lan-invite-left">/);
  });
});
