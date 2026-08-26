// What the sound switch claims, now that the deck makes the sound itself.
//
// This file used to pin the opposite premise, and the reversal is the point of
// the comment. The sound was one entry in Claude Code's settings.json — a
// `Stop` hook running notify.mjs, executed by Claude Code at the end of a turn.
// Codex never reached it, so a Codex user turned the switch on and watched turn
// after turn finish in silence. The copy therefore had to name the mechanism
// and not just the limit: "Claude Code only" is a fact a user can act on.
//
// The old header also recorded why a deck-played sound had been considered and
// refused, and every one of those objections was real:
//
//   1. it fires once per deck tailing that rollout;
//   2. only inside that deck's workspace;
//   3. and never with the deck down.
//
// They were not answered. They were weighed and accepted, deliberately, by the
// person who owns the trade (#704). (1) is the chosen behaviour — every open
// tab plays, and nobody wanted leader election between tabs for a chime. (2) is
// arguably right rather than merely tolerable: a deck scoped to one tree is
// scoped for a reason, and hearing another tree's turns end would be the
// surprising outcome. (3) is the one real loss, taken because a dashboard's
// normal state is open.
//
// What that buys, and what this file now pins: the tone follows the EVENT, so
// it is no longer Claude-only. `index.mjs` maps a Codex `task_complete` /
// `turn_aborted` onto a synthetic `Stop` (#395), and the deck plays a `Stop`
// whatever produced it. Codex has no `Notification` equivalent, so the second
// tone stays Claude Code's, and the copy has to say that rather than let a user
// discover the asymmetry by waiting for a sound that cannot come.
//
// PLAIN NODE. Nothing here renders React — the component source is read as text
// and the pure module is imported. Comments are stripped before every "appears
// nowhere" assertion, because the explanations in this repo quote the strings
// they explain.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finishSoundTitle } from "../provider-copy";
import { ASSUMED } from "../providers";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const src = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const BOTH = { claude: true, codex: true };
const CLAUDE_ONLY = { claude: true, codex: false };

describe("the tooltip on a machine running both CLIs", () => {
  it("no longer claims Codex turns finish in silence, because they no longer do", () => {
    // The sentence this replaces was the whole point of the old file. A Codex
    // rollout's end is mapped to a Stop, and the tone follows the event.
    const on = finishSoundTitle(BOTH, { on: true, locked: false });
    expect(on).not.toMatch(/silence/i);
    expect(on).not.toMatch(/Claude Code turns only/);
    expect(on).toMatch(/Both CLIs get the finish tone/);
  });

  it("says which of the two tones Codex cannot have, so the gap is read rather than discovered", () => {
    const on = finishSoundTitle(BOTH, { on: true, locked: false });
    // Not "some things do not work with Codex" — the specific one, and why.
    expect(on).toMatch(/no Codex equivalent/);
    expect(on).toMatch(/only ever plays for Claude Code/);
  });

  it("keeps that qualification off a machine with no Codex to qualify", () => {
    const on = finishSoundTitle(CLAUDE_ONLY, { on: true, locked: false });
    expect(on).not.toMatch(/Codex/);
  });

  it("warns before the server has answered, which is when both are assumed", () => {
    // ASSUMED is what `providers` holds until /api/health replies. A tooltip
    // read in that window must carry the qualification, not acquire it later.
    expect(finishSoundTitle(ASSUMED, { on: true, locked: false })).toMatch(/no Codex equivalent/);
  });
});

describe("what the switch says it is", () => {
  it("leads with the state and the key, in both directions", () => {
    const on = finishSoundTitle(BOTH, { on: true, locked: false });
    const off = finishSoundTitle(BOTH, { on: false, locked: false });
    expect(on).toMatch(/^Sound: on\b/);
    expect(off).toMatch(/^Sound: off\b/);
    for (const t of [on, off]) expect(t, "the key belongs in the tooltip").toMatch(/\(M\)/);
  });

  it("stops offering to write or remove a hook, because it no longer does either", () => {
    // The old copy said "click to add a Stop hook" / "click to remove the
    // hook". Both described a write to settings.json that no longer happens.
    for (const on of [true, false]) {
      const t = finishSoundTitle(BOTH, { on, locked: false });
      expect(t).not.toMatch(/settings\.json/);
      expect(t).not.toMatch(/Stop hook/);
      expect(t).not.toMatch(/shift-click/i);
    }
  });

  it("names the second tone when it is on, since nothing else announces it", () => {
    expect(finishSoundTitle(BOTH, { on: true, locked: false })).toMatch(/asks for you/);
  });
});

describe("the silence a browser imposes", () => {
  it("explains itself when the page has not been interacted with yet", () => {
    // "On, and nothing happens" is exactly the report the old mechanism
    // generated. The switch has to be able to say which silence this is.
    const locked = finishSoundTitle(BOTH, { on: true, locked: true });
    expect(locked).toMatch(/Waiting for a click/);
    expect(locked).toMatch(/unlocks it/);
  });

  it("says nothing about it once unlocked, or while the switch is off", () => {
    expect(finishSoundTitle(BOTH, { on: true, locked: false })).not.toMatch(/Waiting for a click/);
    // Off is off: a locked context is not the reason there is no sound, and
    // saying so would send the user to press something that changes nothing.
    expect(finishSoundTitle(BOTH, { on: false, locked: true })).not.toMatch(/Waiting for a click/);
  });
});

describe("the topbar button", () => {
  it("reads its tooltip out of the module that owns the words", () => {
    const app = stripComments(src("App.tsx"));
    expect(app).toMatch(/title=\{finishSoundTitle\(/);
    // And passes the locked state through, or the sentence above can never
    // appear however locked the context is.
    expect(app).toMatch(/locked:\s*chimeState === "locked"/);
  });

  it("is still drawn only where Claude Code is", () => {
    // Unchanged by #704 and worth keeping pinned: the switch names Claude Code
    // in its aria-label, which is only true because it does not render without
    // it. The finish tone now covers Codex, but a Codex-only machine has no
    // Notification to explain and no established home for this control.
    const app = stripComments(src("App.tsx"));
    expect(app).toMatch(/providers\.claude && soundOn !== null/);
  });
});
