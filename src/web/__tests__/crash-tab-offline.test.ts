// After a render crash the tab stops claiming the deck is live.
//
// The tab's title and icon are written by useTabAmbient, inside Inner — the
// tree the error boundary replaces. Its effect has no cleanup, so a crash left
// the tab as it last was for good: "(2) ccdeck" with the waiting mark, or the
// syncing mark, over a deck that had stopped taking events. That frozen
// reading is what ambient.ts's offline mark exists to replace (#719). Now the
// boundary puts the tab's icon on the offline mark as it catches the error,
// and leaves the count, which ambient.ts keeps through a lost stream on
// purpose: nobody answered those sessions while the deck was down.
//
// Run, not read, with React's part kept by hand: the boundary is made and
// handed a caught error the way React hands it one, against a stand-in for
// index.html's two icon links that answers the same selectors a browser would.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "../components/ErrorBoundary";
import { FAVICON_FALLBACK_HREF, FAVICON_HREF } from "../ambient";

type Link = { rel: string; href: string; type?: string; sizes?: string };

/** index.html's head, as far as the tab goes: its title and its two icon links,
 *  found by attribute selectors the way querySelector finds them. */
function head(title: string, icon: keyof typeof FAVICON_HREF) {
  const links: Link[] = [
    { rel: "icon", href: FAVICON_FALLBACK_HREF[icon], sizes: "32x32" },
    { rel: "icon", href: FAVICON_HREF[icon], type: "image/svg+xml" },
  ];
  return {
    title,
    links,
    querySelector(selector: string): Link | null {
      const match = /^link((?:\[[a-z]+="[^"]*"\])+)$/.exec(selector);
      if (!match) return null;
      const wants = [...match[1].matchAll(/\[([a-z]+)="([^"]*)"\]/g)];
      return links.find(link => wants.every(([, name, value]) => link[name as keyof Link] === value)) ?? null;
    },
  };
}

function crash() {
  const boundary = new ErrorBoundary({ children: null });
  const error = new Error("Cannot read properties of undefined (reading 'agents')");
  boundary.state = { ...boundary.state, ...ErrorBoundary.getDerivedStateFromError(error) };
  boundary.componentDidCatch(error, { componentStack: "\n    at Inner" });
}

beforeEach(() => {
  // The boundary logs what it caught and forwards it to the deck's server;
  // neither is what this file is about.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the tab after a render crash", () => {
  it.each(["waiting", "running", "idle"] as const)("wears the offline mark, not the %s one it had", icon => {
    const doc = head(icon === "waiting" ? "(2) ccdeck" : "ccdeck", icon);
    vi.stubGlobal("document", doc);
    crash();
    expect(doc.links.map(link => link.href)).toEqual([FAVICON_FALLBACK_HREF.offline, FAVICON_HREF.offline]);
  });

  it("keeps the count of sessions waiting, as a lost stream does", () => {
    const doc = head("(2) ccdeck", "waiting");
    vi.stubGlobal("document", doc);
    crash();
    expect(doc.title).toBe("(2) ccdeck");
  });
});
