// The press that is its own confirmation (#1175).
//
// Removing an account deletes its stored credentials, and unpairing a deck
// cannot be undone from this deck either. Neither asks in a dialog. The control
// arms on the first press, stands down on its own after four seconds, and only
// a second press inside that window acts — and a second press sooner than
// CONFIRM_GAP_MS after the first is ignored, because a double-click lands its
// second press before anybody could have read `Confirm`.
//
// The rule was written out by hand at four sites: the account menu's Remove,
// the LAN row's unpair, and both unpairs in the paired-deck dialog. The three
// unpairs were pinned by the shape of their lines; Remove, the one that deletes
// credentials, was pinned by nothing at all, and deleting its gap line let a
// double-click remove an account with the suite green. The four now ask one
// function, which is driven here, and a sweep holds every site to it — and the
// fifth, deleting a custom notification sound (#1207), which has no undo either.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { armedPress } from "../panel-press";
import { CONFIRM_GAP_MS } from "../components/LanSyncSection";
import { withoutComments } from "./tsx-scan";

const GAP = 400;
const press = (armedFor: number | null, target: number, armedAt: number, now: number) =>
  armedPress({ armedFor, target, armedAt, now, gapMs: GAP });

describe("armedPress", () => {
  it("arms on the first press and does nothing else", () => {
    expect(press(null, 4, 0, 1_000)).toBe("arm");
  });

  it("ignores a second press inside the gap, which is a double-click and not an answer", () => {
    expect(press(4, 4, 1_000, 1_200)).toBe("ignore");
    expect(press(4, 4, 1_000, 1_399)).toBe("ignore");
  });

  it("fires on a second press at the gap and after it", () => {
    // The boundary is the gap itself: 400ms later is two decisions.
    expect(press(4, 4, 1_000, 1_400)).toBe("fire");
    expect(press(4, 4, 1_000, 3_000)).toBe("fire");
  });

  it("arms another row rather than firing it", () => {
    // An open menu lies over the next account's ⋯, so a press aimed there can
    // land on a different row's Remove. It moves the arm and never acts, however
    // long after the first arm it comes.
    expect(press(4, 5, 1_000, 1_200)).toBe("arm");
    expect(press(4, 5, 1_000, 60_000)).toBe("arm");
  });

  it("takes a fingerprint as readily as a slot number", () => {
    // The LAN rows arm by fingerprint.
    expect(armedPress({ armedFor: "fp-a", target: "fp-a", armedAt: 0, now: 1_000, gapMs: GAP })).toBe("fire");
    expect(armedPress({ armedFor: "fp-a", target: "fp-b", armedAt: 0, now: 1_000, gapMs: GAP })).toBe("arm");
  });

  it("walks a double-click and a deliberate confirm the way the sites run them", () => {
    // What each site does with the answer, replayed over two gestures: the arm
    // records when it happened, and only a fire removes anything.
    const gesture = (gapBetween: number) => {
      let armedFor: number | null = null;
      let armedAt = 0;
      let fired = 0;
      for (const now of [10_000, 10_000 + gapBetween]) {
        const p = armedPress({ armedFor, target: 7, armedAt, now, gapMs: CONFIRM_GAP_MS });
        if (p === "arm") { armedFor = 7; armedAt = now; continue; }
        if (p === "ignore") continue;
        armedFor = null;
        fired++;
      }
      return fired;
    };
    expect(gesture(100)).toBe(0);
    expect(gesture(CONFIRM_GAP_MS + 100)).toBe(1);
  });
});

describe("every arm-then-confirm press asks armedPress", () => {
  const read = (name: string) =>
    withoutComments(readFileSync(fileURLToPath(new URL(`../components/${name}`, import.meta.url)), "utf8"));
  const accounts = read("AccountsPanel.tsx");
  const section = read("LanSyncSection.tsx");
  const modal = read("LanPeerModal.tsx");
  const sound = read("SoundMenu.tsx");

  it("routes the account's Remove through it, and only a fire posts the removal", () => {
    const start = accounts.indexOf("armedFor: confirmRemove, target: a.num,");
    expect(start).toBeGreaterThan(-1);
    const post = 'admin({ action: "remove", account: a.num }';
    const handler = accounts.slice(start, accounts.indexOf(post, start) + post.length);
    expect(handler).toMatch(/armedAt: removeArmedAt\.current, now, gapMs: CONFIRM_GAP_MS,/);
    // The arm records when it happened — without that the gap measures from 0
    // and every second press is a fire.
    expect(handler).toMatch(/if \(press === "arm"\) \{\s*setConfirmRemove\(a\.num\);\s*removeArmedAt\.current = now;/);
    // And the ignore returns before the request is built.
    expect(handler).toMatch(/if \(press === "ignore"\) return;\s*setConfirmRemove\(null\);\s*admin\(\{ action: "remove", account: a\.num \}/);
  });

  it("routes all three unpairs through it", () => {
    expect(section).toMatch(/armedFor: armed, target: p\.fp, armedAt: armedAt\.current, now, gapMs: CONFIRM_GAP_MS,/);
    expect(modal).toMatch(/armedFor: armedTwin, target: fpT, armedAt: armedAt\.current, now, gapMs: CONFIRM_GAP_MS,/);
    expect(modal).toMatch(/armedFor: armed \? row\.fp : null, target: row\.fp, armedAt: armedAt\.current, now, gapMs: CONFIRM_GAP_MS,/);
    expect([...section.matchAll(/if \(press === "ignore"\) return;/g)]).toHaveLength(1);
    expect([...modal.matchAll(/if \(press === "ignore"\) return;/g)]).toHaveLength(2);
  });

  it("routes a custom sound's Delete through it, and only a fire deletes", () => {
    const start = sound.indexOf("const pressDelete = ");
    expect(start).toBeGreaterThan(-1);
    const call = "await onDeleteCustom(id);";
    const handler = sound.slice(start, sound.indexOf(call, start) + call.length);
    expect(handler).toMatch(/armedFor: armedDelete, target: id, armedAt: deleteArmedAt\.current, now, gapMs: CONFIRM_GAP_MS,/);
    expect(handler).toMatch(/if \(press === "arm"\) \{ setArmedDelete\(id\); deleteArmedAt\.current = now; return; \}/);
    expect(handler).toMatch(/if \(press === "ignore"\) return;\s*setArmedDelete\(null\);/);
    // The row's button asks the handler and nothing else: no second road to
    // the delete that skips the arm.
    expect([...sound.matchAll(/onDeleteCustom\(/g)]).toHaveLength(1);
    expect(sound).toMatch(/onClick=\{e => pressDelete\(asset\.id, e\.currentTarget\)\}/);
  });

  it("leaves no hand-written gap check anywhere in the components", () => {
    // A fifth copy is how the first four drifted apart in what they pinned.
    for (const [name, src] of [["AccountsPanel.tsx", accounts], ["LanSyncSection.tsx", section], ["LanPeerModal.tsx", modal], ["SoundMenu.tsx", sound]]) {
      expect(`${name}: ${/Date\.now\(\) - \w*[aA]rmedAt/.test(src)}`).toBe(`${name}: false`);
      expect(`${name}: ${/[aA]rmedAt\.current < CONFIRM_GAP_MS/.test(src)}`).toBe(`${name}: false`);
    }
  });
});
