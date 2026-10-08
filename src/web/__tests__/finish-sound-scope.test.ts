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
// WHERE IT IS SAID MOVED (2026-10-07). These sentences were the topbar
// speaker's tooltip, and the speaker left the bar: everything it opened is in
// Settings › Sounds, which says the same things beside the controls they are
// about. Two of the tooltip's guarantees went with it, deliberately:
//
//  - the Codex sentence was dropped on a machine with no Codex. Settings says
//    "Claude or Codex" on every machine, the way it already did beside the
//    finish tone; a Claude-only reader is told about a CLI they do not run,
//    which costs a word and misleads nobody;
//  - "Waiting for a click" — the autoplay lock — was said only in the tooltip,
//    and only a pointer hovering the speaker before any press could read it.
//    Settings is opened by a click or a key, the gestures that wake the
//    player (use-chime-player.ts), so there is no moment it could be read in.
//
// PLAIN NODE. The section is drawn with renderToStaticMarkup; nothing runs in
// a browser.
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import SoundsSection, { type SoundsProps } from "../components/SoundsSection";
import { DEFAULT_PREFS } from "../sound";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const src = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const noop = () => {};
const asyncNoop = async () => {};

/** Settings › Sounds as a first render draws it. */
function drawSounds(over: Partial<SoundsProps> = {}): string {
  const props: SoundsProps = {
    soundOn: true, onToggleSound: noop, prefs: DEFAULT_PREFS, claudeHere: true,
    onLevel: noop, onFigure: noop, onPreview: noop,
    customAssets: [], customSelections: { done: null, "needs-input": null },
    onBuiltInSelected: noop, onCustomSelected: noop, onImportCustom: asyncNoop, onCreateVoice: asyncNoop,
    onRenameCustom: asyncNoop, onPreviewCustom: noop, onDeleteCustom: asyncNoop,
    ...over,
  } as SoundsProps;
  return renderToStaticMarkup(createElement(SoundsSection, props));
}

/** The text of one tone's group, from its heading to the end of its section. */
function toneGroup(html: string, name: string): string {
  const at = html.indexOf(`>${name}</h3>`);
  expect(at, name).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at)).replace(/<[^>]+>/g, " ");
}

describe("Settings › Sounds, on what each tone covers", () => {
  it("no longer claims Codex turns finish in silence, because they no longer do", () => {
    // The sentence this replaces was the whole point of the old file. A Codex
    // rollout's end is mapped to a Stop, and the tone follows the event.
    const html = drawSounds();
    expect(html).not.toMatch(/silence/i);
    expect(html).not.toMatch(/Claude Code turns only/);
    expect(toneGroup(html, "Turn finished")).toContain("Plays when Claude or Codex finishes a turn.");
  });

  it("says which of the two tones Codex cannot have, beside that tone", () => {
    // Not "some things do not work with Codex" — the specific one, where the
    // reader is choosing it.
    expect(toneGroup(drawSounds(), "Claude is asking")).toContain("Available in Claude Code only.");
  });

  it("says both on every machine, so a reader never waits on the server to be told", () => {
    // The tooltip had to carry the qualification while `providers` was still
    // ASSUMED; the section's notes depend on no provider at all.
    for (const claudeHere of [true, false]) {
      const html = drawSounds({ claudeHere });
      expect(toneGroup(html, "Turn finished"), `claudeHere=${claudeHere}`).toContain("Claude or Codex");
      expect(toneGroup(html, "Claude is asking"), `claudeHere=${claudeHere}`).toContain("Claude Code only");
    }
  });
});

describe("what the switch says it is", () => {
  it("states its state as a switch, and names its key beside it", () => {
    expect(drawSounds({ soundOn: true })).toMatch(/role="switch" aria-checked="true"/);
    expect(drawSounds({ soundOn: false })).toMatch(/role="switch" aria-checked="false"/);
    for (const soundOn of [true, false]) {
      expect(drawSounds({ soundOn }), `soundOn=${soundOn}`).toContain("<kbd>M</kbd>Mute or unmute sounds anywhere.");
    }
  });

  it("offers to write or remove no hook, because it does neither", () => {
    // The old copy said "click to add a Stop hook" / "click to remove the
    // hook". Both described a write to settings.json that no longer happens.
    for (const soundOn of [true, false]) {
      const text = drawSounds({ soundOn }).replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/settings\.json/);
      expect(text).not.toMatch(/Stop hook/);
      expect(text).not.toMatch(/shift-click/i);
    }
  });

  it("names the second tone whether the switch is on or off", () => {
    for (const soundOn of [true, false]) {
      expect(drawSounds({ soundOn }), `soundOn=${soundOn}`).toMatch(/>Claude is asking<\/h3>/);
    }
  });
});

describe("the tooltip that said it first", () => {
  it("is gone with the topbar speaker, and nothing else reads its words", () => {
    expect(stripComments(src("provider-copy.ts"))).not.toMatch(/finishSoundTitle|FinishSoundState/);
    // The chrome's controls: their definitions, the stripes, dock and topbar
    // utilities that draw them, and their one hint (2026-10-08).
    const run = ["rail-items.tsx", "components/EdgeRails.tsx", "components/use-hint.tsx"]
      .map(rel => stripComments(src(rel))).join("\n");
    expect(run).not.toMatch(/finishSoundTitle|Sound settings/);
  });
});
