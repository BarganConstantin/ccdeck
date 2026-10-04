// The network map's key named a slice that was not drawn.
//
// Under the map, the key lists what its marks mean: the three rings, and the
// tailnet's slice — "over Tailscale". The slice is only drawn when the tailnet
// is part of the network: a network with no deck on the tailnet has none, nor
// does one where every deck is on it, nor a map the slice would leave no room
// in (network-map-narrow-stage.test.ts). The key printed its entry for it all
// the same, so a plain office network was handed a swatch for a region nobody
// could find. The panel's own note already follows the slice
// (network-map-tailnet-note.test.ts); now the key does too. A slice drawn with
// its name left off — no stretch of its edge was clear of a deck's name — keeps
// its key, which is then the only thing on the map that says what it is.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Legend } from "../components/LanNetworkMap";
import { mapLayout } from "../lan-network-map";
import type { DeckRow } from "../lan-roster";
import { sourceOf } from "./client-source";

let seq = 0;
function row(over: Partial<DeckRow>): DeckRow {
  seq += 1;
  return {
    fp: `fp-${seq}`, name: `deck-${seq}`, addr: "192.168.1.10",
    kind: "paired", state: "online", tone: "ok", here: true, hint: "",
    ...over,
  };
}

/** The key's entries, in words, as the map draws it for this layout. */
function keyFor(rows: DeckRow[]): string[] {
  const layout = mapLayout(rows, 860, 640);
  const html = renderToStaticMarkup(createElement(Legend, { slice: layout.zone != null }));
  return [...html.matchAll(/<li>(.*?)<\/li>/g)].map(m => m[1].replace(/<[^>]+>/g, "").trim());
}

describe("the network map's key", () => {
  it("has no entry for the slice on a network with no deck on the tailnet", () => {
    expect(keyFor([row({}), row({}), row({ here: false, state: "last online 2h ago" })]))
      .toEqual(["online", "away", "not paired"]);
  });

  it("has none when every deck is on the tailnet, where no slice is drawn", () => {
    expect(keyFor([row({ via: "tailscale" }), row({ via: "tailscale" })])).toEqual(["online", "away", "not paired"]);
  });

  it("names the slice where one is drawn", () => {
    expect(keyFor([row({}), row({ via: "tailscale", name: "work-laptop" })]))
      .toEqual(["online", "away", "not paired", "over Tailscale"]);
  });

  it("names a slice drawn without its own name", () => {
    expect(renderToStaticMarkup(createElement(Legend, { slice: true }))).toMatch(/over Tailscale/);
  });

  it("is told by the map whether its slice is drawn, the way the panel is", () => {
    expect(sourceOf("components/LanNetworkMap.tsx")).toMatch(/<Legend slice=\{layout\?\.zone != null\} \/>/);
  });
});
