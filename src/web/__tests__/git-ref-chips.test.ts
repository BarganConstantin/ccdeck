// A branch on one of the history's ref chips, cut to the chip's room: the card
// chip's rule and the card chip's measure, not a copy of either.
//
// The ref chips measured a name as its code points times one character's
// width. A CJK character draws two columns of a monospace font, so a Japanese
// branch overflowed its chip by up to half again; an emoji is two code units
// and one or two columns; a flag is two code points drawn as one; and a cut
// by code points could split a joined emoji or a flag in two. They now take
// the card chip's spellings (git-chip.ts: the ticket whole, cuts between the
// characters a reader sees) and its canvas measure in the chip's own font.
import { describe, expect, it } from "vitest";
import { refChips } from "../components/GitGraph";
import { graphemes, textColumns } from "../git-chip";
import type { LogCommit } from "../git-graph-layout";
import { sourceOf } from "./client-source";

/** A monospace font at 6px a column: what a canvas says for the deck's mono
 *  stack, wide characters and emoji two columns. */
const measure = (text: string) => textColumns(text) * 6;
const ROOM = 120; // the narrow pane's chip box

function chipFor(name: string, kind: "local" | "remote" = "local", room = ROOM) {
  const c: LogCommit = {
    sha: "a".repeat(40), parents: [], author: { name: "A", email: "a@x" }, date: "2026-10-06T12:00:00Z", subject: "s", trailers: [],
    refs: { local: kind === "local" ? [name] : [], remote: kind === "remote" ? [`origin/${name}`] : [], tags: [], head: false }, agent: null,
  };
  return refChips(c, null, () => null, room, measure).chips[0];
}

/** Every character a reader sees in `label` is one of `name`'s, or the ellipsis. */
const wholeCharacters = (label: string, name: string) => {
  const own = new Set(graphemes(name));
  return graphemes(label).every(g => g === "…" || own.has(g));
};
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("a ref chip's name, cut to its room", () => {
  it("keeps a long ticket whole at every room, and fits the room whenever a spelling can", () => {
    const name = "feature/bargan/VCRM-9142-checkout-split-payment-intents-and-retries";
    for (let room = 60; room <= 240; room += 6) {
      const { label } = chipFor(name, "local", room);
      expect(label.includes("VCRM-9142"), `${room}px: ${label}`).toBe(true);
      expect(measure(label) <= Math.max(48, room - 12) || label === name.split("/").pop(), `${room}px: ${label}`).toBe(true);
    }
    expect(chipFor(name, "local", 240).label).toBe("VCRM-9142-checkout-split…-and-retries");
    // Nothing fits: the last segment whole, ticket first, for the box's own
    // ellipsis to end (the card's rule: a cut word cut again reads as noise).
    expect(chipFor(name, "local", 60).label).toBe("VCRM-9142-checkout-split-payment-intents-and-retries");
  });

  it("counts CJK as the two columns it draws, so a Japanese branch fits its chip", () => {
    const name = "feature/支払い分割の対応と再試行の整理";
    const { label } = chipFor(name);
    expect(measure(label)).toBeLessThanOrEqual(ROOM - 12);
    expect(wholeCharacters(label, name)).toBe(true);
    // Counted by code points it would have been kept far longer than its box.
    expect(label.length).toBeLessThan(name.length);
  });

  it("never splits a joined emoji or a flag, and counts each as wide as it draws", () => {
    for (const name of [
      "fix/👩‍💻👨‍👩‍👧‍👦-pairing-session-tools-and-follow-ups",
      "release/🇲🇩🇷🇴🇺🇦-launch-weekend-notes-for-everyone",
      "feat/🚀🚀🚀🚀-rocket-emoji-everywhere-in-branch",
    ]) {
      const { label } = chipFor(name);
      expect(LONE_SURROGATE.test(label), label).toBe(false);
      expect(wholeCharacters(label, name), label).toBe(true);
      expect(measure(label), label).toBeLessThanOrEqual(ROOM - 12);
    }
  });

  it("puts the remote's name first when there is room, and measures it with the rest", () => {
    const wide = chipFor("feature/x", "remote", 230);
    expect(wide.label).toBe("origin/feature/x");
    expect(chipFor("fix/csrf", "remote", 120).label).toBe("origin/fix/csrf");
    // Never by cutting the branch's own words further: without the room for
    // both, the cloud and the dashed edge say remote and the words stay.
    const narrow = chipFor("feature/payments-v2-with-a-long-name", "remote", 120);
    expect(narrow.label.startsWith("origin/")).toBe(false);
    expect(narrow.label).toBe(chipFor("feature/payments-v2-with-a-long-name", "local", 120 - 15).label);
    expect(measure(narrow.label)).toBeLessThanOrEqual(120 - 27);
  });

  it("is the card chip's rule and measure, not a second copy of them", () => {
    const src = sourceOf("components/GitGraph.tsx");
    expect(src).toMatch(/import \{ fitBranch \} from "\.\.\/git-chip";/);
    expect(src).toMatch(/import \{ monoMeasure, type Measure \} from "\.\.\/git-path-fit";/);
    expect(src).toMatch(/monoMeasure\(REF_PX, REF_WEIGHT\)/);
    expect(src).not.toMatch(/TICKET|\[A-Z\]\[A-Z0-9\]|charPx|\.length \* /);
  });
});
