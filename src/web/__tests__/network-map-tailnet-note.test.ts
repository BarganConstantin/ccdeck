// The network map's panel pointed at a slice that was not drawn.
//
// With nothing pointed at, the panel counts the decks reached over Tailscale
// and says where they are: "the shaded slice, lower right". The slice is only
// drawn when the tailnet is part of the network — every deck on the tailnet
// has no slice, and neither does a map the slice would leave no room in — but
// the sentence was printed whenever any deck was on the tailnet, so a home
// desktop and a work laptop joined only through the tailnet were described as
// standing in a region nobody could find.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NetworkDetails } from "../components/LanNetworkMap";
import { mapLayout, mapSummary } from "../lan-network-map";
import type { DeckRow } from "../lan-roster";
import type { LanStatus } from "../lan-types";
import { sourceOf } from "./client-source";

let seq = 0;
function row(over: Partial<DeckRow>): DeckRow {
  seq += 1;
  return {
    fp: `fp-${seq}`, name: `deck-${seq}`, addr: "100.66.5.9",
    kind: "paired", state: "online", tone: "ok", here: true, hint: "",
    ...over,
  };
}

const status = { enabled: true, running: true, name: "constantin-thinkpad", fp: "fpSELF", port: 4317, addrs: [] } as unknown as LanStatus;

/** The panel's words with nothing pointed at, as the map draws it. */
function panel(rows: DeckRow[], slice: boolean): string {
  return renderToStaticMarkup(createElement(NetworkDetails, { status, summary: mapSummary(rows), entrance: "none", slice }))
    .replace(/<[^>]+>/g, " ");
}

describe("what the panel says about the decks reached over Tailscale", () => {
  it("does not point at a slice when every deck is on the tailnet and none is drawn", () => {
    const rows = [row({ via: "tailscale", name: "home-desktop" }), row({ via: "tailscale", name: "work-laptop" })];
    // The map draws no slice for this network...
    expect(mapLayout(rows, 860, 640).zone).toBeNull();
    // ...so the panel counts them without sending anybody to look for one.
    const said = panel(rows, false);
    expect(said).toMatch(/2 reached over Tailscale/);
    expect(said).not.toMatch(/slice/);
  });

  it("still points at the slice where one is drawn", () => {
    const rows = [row({ addr: "192.168.1.22" }), row({ via: "tailscale", name: "work-laptop" })];
    expect(mapLayout(rows, 860, 640).zone).not.toBeNull();
    expect(panel(rows, true)).toMatch(/1 reached over Tailscale — the shaded slice, lower right/);
  });

  it("is told by the map whether its slice is drawn", () => {
    expect(sourceOf("components/LanNetworkMap.tsx")).toMatch(/<NetworkDetails [^>]*slice=\{layout\?\.zone != null\}/);
  });
});
