// #1745: every accept and decline in the pairing requests was named only
// "accept" or "decline".
//
// With two decks asking, tabbing through the box in Local network read
// "accept, button", "decline, button", "accept, button" — nothing said which
// deck a button answers. The deck's name and its fingerprint are printed in
// the row, and neither was tied to the buttons, so the context was there for
// somebody reading the row and gone for somebody tabbing. Accepting shares this
// machine's logins, so the wrong accept pairs the wrong machine.
//
// Now each button is named for its verb and its deck, the way the deck list
// beside it names every verb ("Ask {name} to pair"), and described by its own
// request's fingerprint.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import LanAsks from "../components/LanAsks";
import type { DeckRow } from "../lan-roster";
import { pressState } from "../panel-press";

const row = (fp: string, name: string): DeckRow => ({
  fp, name, addr: "192.168.1.9", kind: "asks", state: "wants to pair", tone: "wait", here: true, hint: "",
});
const asks = [row("aa11", "trusted-mac"), row("bb22", "stranger")];

/** The section's own spread, as use-lan-section.ts builds it, with nothing out. */
const pressProps = (tag: string) => {
  const s = pressState(null, tag);
  return { disabled: s.disabled, "aria-busy": s.busy };
};

const html = renderToStaticMarkup(createElement(LanAsks, { asks, pressProps, answer: async () => null }));
const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({ attrs: m[1], text: m[2].trim() }));
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
/** The text of the element carrying this id, tags removed. */
const textOf = (id: string) => {
  const m = new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`).exec(html);
  return m ? m[2].replace(/<[^>]+>/g, "") : null;
};

describe("the pairing requests' answers say which deck they answer (#1745)", () => {
  it("draws the four buttons this case is about", () => {
    expect(buttons.map(b => b.text)).toEqual(["accept", "decline", "accept", "decline"]);
  });

  it("names each one for its verb and its own deck", () => {
    const names = buttons.map(b => attr(b.attrs, "aria-label"));
    expect(names).toEqual(["Accept trusted-mac", "Decline trusted-mac", "Accept stranger", "Decline stranger"]);
    // The visible word stays inside the name, so a voice command that says
    // what is on screen still reaches the button.
    for (const b of buttons) expect(attr(b.attrs, "aria-label")?.toLowerCase()).toContain(b.text);
  });

  it("describes each one by its own request's fingerprint", () => {
    buttons.forEach((b, i) => {
      const fp = asks[Math.floor(i / 2)].fp;
      const id = attr(b.attrs, "aria-describedby");
      expect(id, `${b.text} for ${asks[Math.floor(i / 2)].name}`).toBeTruthy();
      expect(textOf(id!)).toContain(fp);
      expect(textOf(id!)).not.toContain(asks[1 - Math.floor(i / 2)].fp);
    });
  });
});
