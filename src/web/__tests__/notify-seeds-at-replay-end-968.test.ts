// WHEN the notifier adopts the world as history, which is a different question
// from WHAT it adopts.
//
// notify.test.ts settles the what, and settles it correctly: hand `seedRaised`
// four standing blocks and it adopts four, so a deck restored onto a machine
// with four prompts already up says nothing about them. Nothing handed it the
// blocks. The seed ran from an effect keyed on the notification permission, so
// it ran at MOUNT — and at mount `stateRef.current` is `initialState()`, an
// empty graph, because the EventSource that fills it is opened by an effect of
// its own and its first message cannot land before the mount commit. The seed
// therefore adopted `[]` and then wrote down that it had seeded, so it never
// ran again.
//
// WHAT WAS OBSERVED, by driving the three effects in their declaration order
// against the real rules (the `deck` harness below, with `liveSince` ignored
// exactly as the component ignored it):
//
//     mount              raised = {}            notices = 0
//     replay-end, 3 standing prompts, tab hidden
//                        raised = {}            notices = 3   ← the storm
//
// Three desktop notifications about permission prompts that had been sitting
// there since before the reboot, all at once, on a tab the browser restored
// into the background — which is the precise case the seed exists for, and the
// one the visibility gate cannot cover, because a restored background tab is
// hidden and so passes straight through it.
//
// THE MUTE RACE MADE IT WORSE RATHER THAN BETTER, and that is worth writing
// down because it looks like a mitigation. If `/api/prefs` had not landed when
// the replay did, `noticesFor` returned `[]` for the muted switch and the
// hidden branch then called `nextRaised(waiting, [], raised)`, which keeps only
// keys already in `raised` — so the standing blocks were still never adopted
// and fired on the next `blockedKeys` change instead. Later, not never.
//
// So the rule pinned here is about ORDER: the world is adopted at the moment
// the deck has finished adopting the world, which is `replay-end` — and only
// the FIRST one. A reconnect ends in `replay-end` too, and seeding there would
// swallow a block raised while the tab was disconnected, which is the single
// notification a user who walked away most wants to come back to.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  blockKey,
  mayRaise,
  nextRaised,
  noticesFor,
  seedRaised,
  shouldReseed,
  shouldSeedFromWorld,
  type BlockNotice,
  type NotifyPermission,
} from "../notify";
import type { BlockedSession } from "../ambient-counts";
import type { WaitingBlock } from "../types";

function block(over: Partial<WaitingBlock> = {}): WaitingBlock {
  return { kind: "permission", message: "Claude needs your permission", since: 1_000, ...over };
}

function session(id: string, over: Partial<WaitingBlock> = {}, label = id): BlockedSession {
  return { id, label, waiting: block(over) };
}

/**
 * App.tsx's notifier, as three effects in their declaration order.
 *
 * This calls the REAL rules — `shouldReseed`, `shouldSeedFromWorld`,
 * `mayRaise`, `noticesFor`, `seedRaised`, `nextRaised` — and owns only the
 * things React owns: which effects a commit runs (those whose dependencies
 * changed), and in what order. That split is the whole point. A harness that
 * restated the rules would pass against a component that had stopped obeying
 * them; the source assertions at the bottom of this file are the other half,
 * and pin that App.tsx still wires these exact rules in this exact order.
 */
function deck({ permission = "granted" as NotifyPermission, visible = false } = {}) {
  let seededAt: NotifyPermission | null = null;
  let seededFromWorld = false;
  let raised: ReadonlySet<string> = new Set();
  let liveSince: number | null = null;
  let blocked: readonly BlockedSession[] = [];
  let muted = false;
  let pageVisible = visible;
  // Last committed dependency values, so "did this effect's deps change" is
  // answered the way React answers it rather than by running everything.
  let lastDeps: { permission: NotifyPermission | null; liveSince: number | null | undefined; keys: string | null } =
    { permission: null, liveSince: undefined, keys: null };
  let mounted = false;
  const fired: BlockNotice[][] = [];

  /** One React commit. */
  function commit() {
    const keys = blocked.map(b => blockKey(b.id, b.waiting)).join("|");
    const first = !mounted;
    mounted = true;

    // ── effect 1: the permission seed, deps [notifyPermission] ──────────────
    if (first || lastDeps.permission !== permission) {
      if (shouldReseed(seededAt, permission)) {
        seededAt = permission;
        raised = seedRaised(blocked);
      }
    }
    // ── effect 2: the first-replay seed, deps [liveSince] ───────────────────
    if (first || lastDeps.liveSince !== liveSince) {
      if (shouldSeedFromWorld(seededFromWorld, liveSince)) {
        seededFromWorld = true;
        raised = seedRaised(blocked);
      }
    }
    // ── effect 3: the raiser, deps [blockedKeys, liveSince] ─────────────────
    if (first || lastDeps.keys !== keys || lastDeps.liveSince !== liveSince) {
      raise(keys);
    }
    lastDeps = { permission, liveSince, keys };
  }

  function raise(_keys: string) {
    if (permission !== "granted") return;
    if (!mayRaise(seededAt, liveSince)) return;
    const notices = noticesFor(blocked, raised, pageVisible, !muted);
    fired.push(notices);
    raised = pageVisible ? seedRaised(blocked) : nextRaised(blocked, notices, raised);
  }

  return {
    /** The mount commit: an empty graph, because the stream is not open yet. */
    mount() { commit(); return this; },
    /** The server finished draining its ring buffer. The coalescer flushes the
     *  applied envelopes and `setLiveSince(Date.now())` lands in the same tick,
     *  so both arrive on one commit — which is what makes the order matter. */
    replayEnd(standing: readonly BlockedSession[], at = 10_000) {
      blocked = standing;
      liveSince = at;
      commit();
      return this;
    },
    /** An ordinary live change: a block appears, clears, or is answered. */
    change(next: readonly BlockedSession[]) { blocked = next; commit(); return this; },
    /** The stream dropped — `error` sets `liveSince` back to null. */
    drop() { liveSince = null; commit(); return this; },
    setMuted(on: boolean) { muted = on; commit(); return this; },
    setVisible(on: boolean) { pageVisible = on; commit(); return this; },
    grant() { permission = "granted"; commit(); return this; },
    /** Every notice raised since the last reading, flattened. */
    notices(): BlockNotice[] { return fired.flat(); },
    raisedKeys(): string[] { return [...raised].sort(); },
  };
}

const THREE = [session("s1"), session("s2"), session("s3")];

// ── the storm ────────────────────────────────────────────────────────────────

describe("a deck restored into a background tab", () => {
  it("says nothing about the prompts that were already standing", () => {
    // The whole issue in five lines. Permission was granted in an earlier
    // session, the tab came back hidden, and three sessions had been blocked
    // since before the reboot.
    const d = deck({ permission: "granted", visible: false })
      .mount()
      .replayEnd(THREE);

    expect(d.notices()).toEqual([]);
  });

  it("adopts them, rather than merely declining to mention them once", () => {
    // The difference matters: "not raised this frame" and "recorded as history"
    // look identical at the moment of the replay and diverge immediately after.
    // If the blocks were only skipped, the next unrelated change to
    // `blockedKeys` — a fourth session blocking, one of the three clearing —
    // would find them still unadopted and fire about all of them then.
    const d = deck({ visible: false }).mount().replayEnd(THREE);

    expect(d.raisedKeys()).toEqual(THREE.map(b => blockKey(b.id, b.waiting)).sort());
  });

  it("still announces a block that arrives after the replay", () => {
    // The seed is not allowed to make the deck quiet in general — it is the
    // difference between history and news, and everything after the replay is
    // news.
    const fresh = session("s4", { since: 99_000 });
    const d = deck({ visible: false })
      .mount()
      .replayEnd(THREE)
      .change([...THREE, fresh]);

    expect(d.notices().map(n => n.sessionId)).toEqual(["s4"]);
  });

  it("does not let the mute race turn the storm into a later storm", () => {
    // `/api/prefs` landing after the replay was the shape that looked like a
    // mitigation and was not: muted, `noticesFor` answers `[]`, the hidden
    // branch calls `nextRaised(waiting, [], raised)` and that keeps only keys
    // ALREADY in `raised` — so with an unseeded `raised` the standing blocks
    // stayed unadopted and fired the moment the switch came on. Seeded at
    // replay-end, they are history before the switch has an opinion.
    const d = deck({ visible: false });
    d.setMuted(true);
    d.mount().replayEnd(THREE);
    d.setMuted(false);
    d.change([...THREE]);

    expect(d.notices()).toEqual([]);
  });
});

// ── the reconnect, which must NOT be treated as a fresh start ────────────────

describe("a stream that dropped and came back", () => {
  it("announces the block that was raised while the deck was away", () => {
    // The reason `shouldSeedFromWorld` carries a first-replay-only flag rather
    // than simply keying on `liveSince`. A reconnect ends in `replay-end` too,
    // and the ring it replays holds whatever blocked while the tab had no
    // stream — which is the one notification this whole feature is for. Seeding
    // there would swallow exactly it.
    const away = session("s9", { since: 50_000 });
    const d = deck({ visible: false })
      .mount()
      .replayEnd(THREE)
      .drop()
      .replayEnd([...THREE, away], 60_000);

    expect(d.notices().map(n => n.sessionId)).toEqual(["s9"]);
  });

  it("does not re-announce the blocks it had already adopted", () => {
    // The other half of the same commit: the three from before the drop are
    // still standing with their original `since`, so their keys are unchanged
    // and `raised` still holds them.
    const d = deck({ visible: false })
      .mount()
      .replayEnd(THREE)
      .drop()
      .replayEnd(THREE, 60_000);

    expect(d.notices()).toEqual([]);
  });
});

// ── the replay itself ────────────────────────────────────────────────────────

describe("while the deck is still adopting the world", () => {
  it("raises nothing from a block that arrives mid-replay", () => {
    // A replay is history arriving. `liveSince` is null for exactly as long as
    // that is true, so it is the gate.
    const d = deck({ visible: false });
    d.mount();
    d.change(THREE);          // envelopes applied, replay-end not reached

    expect(d.notices()).toEqual([]);
  });

  it("adopts that block at replay-end rather than dropping it", () => {
    // Holding fire has to be free: the raiser returns before it touches
    // `raised`, so nothing seen during the replay is forgotten — the seed picks
    // it up. If the gate had been placed after the bookkeeping instead, these
    // blocks would be neither adopted nor announced, and would fire on the next
    // unrelated change.
    const d = deck({ visible: false });
    d.mount();
    d.change(THREE);
    d.replayEnd(THREE);
    d.change([...THREE]);

    expect(d.notices()).toEqual([]);
    expect(d.raisedKeys()).toEqual(THREE.map(b => blockKey(b.id, b.waiting)).sort());
  });
});

// ── the case that was already right, and stays right ─────────────────────────

describe("the permission seed this did not replace", () => {
  it("still treats what is on screen when the user allows as history", () => {
    // #348's first-impression bug, and the reason `shouldReseed` exists at all:
    // granting is the user saying "tell me from here", and what is standing at
    // that moment is what they were looking at when they pressed the button.
    // The new seed must not have moved that.
    const d = deck({ permission: "default", visible: true });
    d.mount();
    d.replayEnd(THREE);
    d.grant();
    d.change([...THREE]);

    expect(d.notices()).toEqual([]);
  });

  it("announces the next block after that one", () => {
    const later = session("s7", { since: 80_000 });
    const d = deck({ permission: "default", visible: true });
    d.mount();
    d.replayEnd(THREE);
    d.grant();
    d.setVisible(false);
    d.change([...THREE, later]);

    expect(d.notices().map(n => n.sessionId)).toEqual(["s7"]);
  });
});

// ── that App.tsx is actually wired the way the harness above models ──────────
//
// Read as text, the way this repo makes every other assertion about a file it
// cannot import. The harness is only worth what this section is worth: it
// proves the rules behave, and this proves the component still calls them, in
// the order the behaviour depends on.

const appSrc = () =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "App.tsx"), "utf8");

describe("App.tsx's wiring", () => {
  it("seeds from the world on an effect keyed on liveSince", () => {
    const src = appSrc();
    expect(src).toMatch(/shouldSeedFromWorld\(notifySeededReplayRef\.current, liveSince\)/);
    // The ref, not a state variable: a re-seed must be decided from the value
    // as it is NOW, and a state read would be one render stale.
    expect(src).toMatch(/notifySeededReplayRef\.current = true;/);
    expect(src).toMatch(/notifyRaisedRef\.current = seedRaised\(waitingSessions\);[\s\S]{0,200}?\}, \[liveSince\]\);/);
  });

  it("declares that seed BEFORE the raiser", () => {
    // Effects run in declaration order within a commit, and replay-end is one
    // commit carrying both the flushed blocks and the new `liveSince`. Reversed,
    // the raiser would run first against an empty `raised` and fire about every
    // standing block — the bug, restored by a reordering that looks like tidying.
    const src = appSrc();
    const seed = src.indexOf("shouldSeedFromWorld(notifySeededReplayRef.current");
    const raiser = src.indexOf("mayRaise(notifySeededAtRef.current");
    expect(seed).toBeGreaterThan(-1);
    expect(raiser).toBeGreaterThan(seed);
  });

  it("gates the raiser on both halves of having started watching", () => {
    // Not `notifySeededAtRef.current === null` any more: that comparison could
    // not see the replay, which is the half that carries the blocks.
    const src = appSrc();
    expect(src).toMatch(/if \(!mayRaise\(notifySeededAtRef\.current, liveSince\)\) return;/);
    expect(src).not.toMatch(/if \(notifySeededAtRef\.current === null\) return;/);
  });

  it("keys the raiser on liveSince as well as the blocked keys", () => {
    // Without `liveSince` in the deps, a block raised while the stream was down
    // takes its new `blockedKeys` value during the reconnect's replay — while
    // the effect is gated off — and the effect never runs again for it.
    expect(appSrc()).toMatch(/\}, \[blockedKeys, liveSince\]\);/);
  });
});
