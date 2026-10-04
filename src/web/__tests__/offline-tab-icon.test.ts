// The tab's offline mark is the one icon shown only when the deck has stopped
// answering. Since the brand kit the states are files the deck serves
// (ambient.ts), and the writer pointed the tab's links at those paths when the
// state changed — so the offline mark was first asked for at the moment the
// server that had it went away. The request failed and the tab kept whatever
// icon it wore before: the waiting mark beside `(1) ccdeck`, the pair #719
// removed.
//
// Now every state's file is fetched once while the deck is up and held in the
// page as a data: URL, and the writer hands the links those. The fetch and the
// hold are plain functions, so they run here in bare node with a fake fetch;
// the writer itself is DOM code and is read as text.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FAVICON_FALLBACK_HREF, FAVICON_HREF } from "../ambient";
import { holdTabIcons, tabIconHref, TAB_ICON_HREFS, _forgetHeldIcons } from "../tab-icons";
import { sourceOf } from "./client-source";

const publicFile = (href: string) => readFileSync(fileURLToPath(new URL(`../public${href}`, import.meta.url)));
const TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

/** The deck while it is up: every public file, under its own type. */
const deckUp = async (href: string) => {
  const ext = href.slice(href.lastIndexOf("."));
  return new Response(publicFile(href), { status: 200, headers: { "Content-Type": TYPES[ext] } });
};
/** The deck once its process is gone: every request fails. */
const deckDown = async (): Promise<Response> => { throw new TypeError("Failed to fetch"); };

beforeEach(() => _forgetHeldIcons());

describe("the tab's state icons", () => {
  it("holds every state the writer can ask for, for both links", () => {
    expect([...TAB_ICON_HREFS].sort()).toEqual(
      [...new Set([...Object.values(FAVICON_HREF), ...Object.values(FAVICON_FALLBACK_HREF)])].sort(),
    );
  });

  it("gives the offline mark without asking the deck, once held while it was up", async () => {
    await holdTabIcons(TAB_ICON_HREFS, deckUp);
    for (const href of [FAVICON_HREF.offline, FAVICON_FALLBACK_HREF.offline]) {
      const held = tabIconHref(href);
      expect(held, `${href} is still a path on the deck`).toMatch(/^data:image\/(svg\+xml|png);base64,/);
      // The very bytes the deck serves, so the mark is the kit's file.
      expect(Buffer.from(held.slice(held.indexOf(",") + 1), "base64").equals(publicFile(href))).toBe(true);
    }
  });

  it("falls back to the path when the hold never landed, and holds on a later try", async () => {
    await holdTabIcons(TAB_ICON_HREFS, deckDown);
    expect(tabIconHref(FAVICON_HREF.offline)).toBe(FAVICON_HREF.offline);
    await holdTabIcons(TAB_ICON_HREFS, deckUp);
    expect(tabIconHref(FAVICON_HREF.offline)).toMatch(/^data:/);
  });

  it("does not hold a page the server sent in place of an icon", async () => {
    const spa = async () => new Response("<!doctype html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    await holdTabIcons(TAB_ICON_HREFS, spa);
    expect(tabIconHref(FAVICON_HREF.offline)).toBe(FAVICON_HREF.offline);
  });
});

describe("the writer", () => {
  const writer = sourceOf("use-tab-ambient.ts");

  it("hands the links the held icons, never a bare path the deck must answer", () => {
    expect(writer).not.toMatch(/\.href = FAVICON_(?:FALLBACK_)?HREF\[/);
    expect(writer).toMatch(/svg\.href = tabIconHref\(FAVICON_HREF\[icon\]\)/);
    expect(writer).toMatch(/fallback\.href = tabIconHref\(FAVICON_FALLBACK_HREF\[icon\]\)/);
  });

  it("holds them while the stream is live", () => {
    expect(writer).toMatch(/if \(live\) void holdTabIcons\(TAB_ICON_HREFS\)/);
  });
});
