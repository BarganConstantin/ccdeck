// #704: the deck plays its own two sounds, instead of writing a Stop hook that
// runs `afplay` into the user's settings.json.
//
// Two halves are checked here and the second is the one worth explaining. The
// decision — which envelope earns which tone — is a pure function and is tested
// directly. The player looks like it needs a browser, and it does not: it takes
// its AudioContext constructor as an argument, so the autoplay behaviour that
// is the actual risk in this feature (a context that starts suspended, and a
// tab nobody has clicked staying silent) is exercised here against a stub
// rather than left to a hand check nobody repeats.
//
// What still needs eyes: whether the two tones are TELLABLE APART by ear, and
// whether they are pleasant. No assertion can answer either.
import { describe, it, expect } from "vitest";
import { chimeFor, createChimePlayer, FIGURES, PEAK_GAIN } from "../sound";

const env = (hook_event_name: string) => ({ payload: { hook_event_name } });

describe("which envelope earns a tone", () => {
  it("gives Stop the finished tone and Notification the asking one", () => {
    expect(chimeFor(env("Stop"), false)).toBe("done");
    expect(chimeFor(env("Notification"), false)).toBe("needs-input");
  });

  it("says nothing for every other kind of event", () => {
    // The list is the deck's whole installed hook set minus the two above. A
    // tone on PreToolUse would fire hundreds of times a session.
    for (const kind of [
      "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
      "SubagentStop", "SessionEnd", "SessionStart",
      "ModelObserved", "UsageObserved", "ContextObserved", "SessionNamed",
    ]) {
      expect(chimeFor(env(kind), false), `${kind} must be silent`).toBeNull();
    }
  });

  it("is silent for a replayed envelope, which is what stops a reconnect firing a hundred tones", () => {
    // The ring holds up to two thousand envelopes and a returning tab is sent
    // all of them at once. Every Stop in a day's work is in there.
    expect(chimeFor(env("Stop"), true)).toBeNull();
    expect(chimeFor(env("Notification"), true)).toBeNull();
  });

  it("says nothing rather than throwing on an envelope it cannot read", () => {
    // A frame from a future server, or a truncated one. The event path must not
    // lose a frame because the sound layer disliked it.
    expect(chimeFor(null, false)).toBeNull();
    expect(chimeFor(undefined, false)).toBeNull();
    expect(chimeFor({}, false)).toBeNull();
    expect(chimeFor({ payload: null }, false)).toBeNull();
    expect(chimeFor({ payload: { hook_event_name: 42 as unknown as string } }, false)).toBeNull();
  });
});

describe("the two figures", () => {
  it("are the same two notes in opposite order, so the contour is what tells them apart", () => {
    const done = FIGURES.done.map(n => n.hz);
    const asking = FIGURES["needs-input"].map(n => n.hz);
    expect(done).toEqual([...asking].reverse());
    // Falling for the one that is over, rising for the one that wants an
    // answer. A listener who was never told which is which can still guess.
    expect(done[0]).toBeGreaterThan(done[done.length - 1]);
    expect(asking[0]).toBeLessThan(asking[asking.length - 1]);
  });

  it("keeps the two pitches far enough apart to read as two notes", () => {
    // A tone apart reads as one wobbling note on a laptop speaker. A major
    // sixth is 1.5x or better.
    for (const notes of Object.values(FIGURES)) {
      const [lo, hi] = [...notes.map(n => n.hz)].sort((a, b) => a - b);
      expect(hi / lo).toBeGreaterThan(1.4);
    }
  });

  it("is short enough to be a notification rather than an interruption", () => {
    for (const [name, notes] of Object.entries(FIGURES)) {
      const end = Math.max(...notes.map(n => n.at * 1000 + n.ms));
      expect(end, `${name} runs ${end}ms`).toBeLessThan(400);
      expect(notes.length, `${name} note count`).toBeGreaterThan(1);
    }
  });

  it("stays well below full scale", () => {
    expect(PEAK_GAIN).toBeGreaterThan(0);
    expect(PEAK_GAIN).toBeLessThan(0.3);
  });
});

/** The smallest AudioContext that answers what the player asks of it. */
function fakeAudio() {
  const started: { hz: number; at: number }[] = [];
  let resumed = false;
  class Ctx {
    state: "suspended" | "running" = "suspended";
    currentTime = 0;
    destination = {} as AudioNode;
    resume() { resumed = true; this.state = "running"; return Promise.resolve(); }
    createOscillator() {
      const node = {
        type: "", frequency: { value: 0 },
        connect: (n: unknown) => n,
        start(at: number) { started.push({ hz: node.frequency.value, at }); },
        stop() {},
      };
      return node as unknown as OscillatorNode;
    }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (n: unknown) => n,
      } as unknown as GainNode;
    }
  }
  return { Ctx: Ctx as unknown as typeof AudioContext, started, wasResumed: () => resumed };
}

describe("the player, against the autoplay rules", () => {
  it("makes no sound before the page has been interacted with", () => {
    const { Ctx, started } = fakeAudio();
    const p = createChimePlayer({ enabled: () => true, ctor: Ctx });
    expect(p.state()).toBe("locked");
    expect(p.play("done")).toBe(false);
    expect(started).toHaveLength(0);
  });

  it("builds no context at all until then, rather than leaving a suspended one behind", () => {
    const { Ctx } = fakeAudio();
    const p = createChimePlayer({ enabled: () => true, ctor: Ctx });
    expect(p.context).toBeNull();
    p.unlock();
    expect(p.context).not.toBeNull();
  });

  it("plays both notes once a gesture has unlocked it", () => {
    const { Ctx, started, wasResumed } = fakeAudio();
    const p = createChimePlayer({ enabled: () => true, ctor: Ctx });
    p.unlock();
    expect(wasResumed()).toBe(true);
    expect(p.state()).toBe("ready");
    expect(p.play("needs-input")).toBe(true);
    expect(started.map(s => s.hz)).toEqual(FIGURES["needs-input"].map(n => n.hz));
  });

  it("stays quiet while the switch is off, unlocked or not", () => {
    const { Ctx, started } = fakeAudio();
    let on = false;
    const p = createChimePlayer({ enabled: () => on, ctor: Ctx });
    p.unlock();
    expect(p.state()).toBe("off");
    expect(p.play("done")).toBe(false);
    on = true;
    expect(p.play("done")).toBe(true);
    expect(started).toHaveLength(FIGURES.done.length);
  });

  it("reports its state as it changes, so the switch can say why it is silent", () => {
    const { Ctx } = fakeAudio();
    const seen: string[] = [];
    const p = createChimePlayer({ enabled: () => true, ctor: Ctx, onState: s => seen.push(s) });
    expect(p.state()).toBe("locked");
    p.unlock();
    expect(seen).toContain("ready");
  });

  it("degrades to silence, not to a crash, where there is no Web Audio at all", () => {
    const p = createChimePlayer({ enabled: () => true, ctor: null });
    p.unlock();
    expect(p.state()).toBe("locked");
    expect(p.play("done")).toBe(false);
  });
});
