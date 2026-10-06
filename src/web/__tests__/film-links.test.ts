// The four ways from the deck to its 30-second videos on ccdeck.dev: the
// Local network section, the Claude accounts column, the Usage panel and the
// empty canvas's tour. Each address is pinned here, so a guide that moves on
// the site is a deliberate one-line change in film-links.ts and here, and each
// place is drawn through its real component, so a link that falls out of one
// fails by name.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { navigationFor } from "../../../desktop/nav.mjs";
import { FILMS, type Film } from "../film-links";
import FilmLink from "../components/FilmLink";
import { EmptyHero } from "../components/EmptyHero";
import AccountsPanel from "../components/AccountsPanel";
import LanSyncSection from "../components/LanSyncSection";
import UsagePanel from "../components/UsagePanel";
import { initialState } from "../reducer";
import { ASSUMED } from "../providers";

const noop = () => {};
const linkTo = (film: Film) => `href="${FILMS[film].href}"`;
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the film addresses", () => {
  it("are the four guide pages, each at its film", () => {
    expect(Object.fromEntries(Object.entries(FILMS).map(([k, v]) => [k, v.href]))).toEqual({
      localNetwork: "https://ccdeck.dev/guides/local-network/#film",
      claudeAccounts: "https://ccdeck.dev/guides/claude-accounts/#film",
      usage: "https://ccdeck.dev/guides/cost-and-quota/#film",
      tour: "https://ccdeck.dev/guides/first-run/#film",
    });
  });

  it("carry nothing but the page: no query string, so a press sends nothing about the deck", () => {
    for (const { href } of Object.values(FILMS)) {
      const url = new URL(href);
      expect(url.search, href).toBe("");
      expect(url.username + url.password, href).toBe("");
    }
  });

  it("open in the person's own browser from the desktop app, never in its window", () => {
    for (const { href } of Object.values(FILMS)) {
      expect(navigationFor(href, "http://127.0.0.1:4317"), href).toBe("external");
    }
  });
});

describe("the link itself", () => {
  const html = renderToStaticMarkup(createElement(FilmLink, { film: "usage" }));

  it("is a plain link to a new tab, holding nothing of this page", () => {
    expect(html).toMatch(/^<a class="film-link" /);
    expect(html).toContain(linkTo("usage"));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("starts its name with the words on screen and says where the press goes", () => {
    const name = html.replace(/<[^>]+>/g, "");
    expect(name.startsWith("Watch · 30 s")).toBe(true);
    expect(name).toContain("ccdeck.dev");
    expect(name).toContain("opens in your browser");
  });
});

describe("each place draws its film", () => {
  it("the empty canvas, beside the tour", () => {
    const html = renderToStaticMarkup(createElement(EmptyHero, {
      live: true, everConnected: true, providers: ASSUMED, workspace: null, onTour: noop,
    }));
    expect(html).toContain(linkTo("tour"));
    expect(html.indexOf(linkTo("tour"))).toBeGreaterThan(html.indexOf("Take the tour"));
  });

  it("not on a hero that has lost the server, where the tour is gone too", () => {
    const html = renderToStaticMarkup(createElement(EmptyHero, {
      live: false, everConnected: true, providers: ASSUMED, workspace: null, onTour: noop,
    }));
    expect(html).not.toContain("film-link");
  });

  it("the Usage panel, on its last line", () => {
    const html = renderToStaticMarkup(createElement(UsagePanel, {
      state: initialState(), now: 0, providers: ASSUMED, onClose: noop,
    }));
    expect(html).toContain(linkTo("usage"));
    expect(html.indexOf(linkTo("usage"))).toBeGreaterThan(html.indexOf('class="up-empty"'));
  });

  it("the Claude accounts column, before any roster has arrived", () => {
    const html = renderToStaticMarkup(createElement(AccountsPanel, { onClose: noop }));
    expect(html).toContain(linkTo("claudeAccounts"));
  });

  it("Local network while it is off, beside `See how it works`", () => {
    const html = renderToStaticMarkup(createElement(LanSyncSection, {
      accounts: [], onChanged: noop, view: true, onOpen: noop, onBack: noop,
    }));
    const card = html.indexOf("See how it works");
    expect(card).toBeGreaterThan(-1);
    expect(html.indexOf(linkTo("localNetwork"))).toBeGreaterThan(card);
  });

  it("Local network while it is on with no other deck, beside `How it works`", () => {
    expect(read("../components/LanSyncSection.tsx"))
      .toMatch(/className="ap-lan-word ap-lan-how"[^\n]*\n\s*How it works\s*<\/button>\s*<FilmLink film="localNetwork" \/>/);
  });
});
