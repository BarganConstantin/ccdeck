// The two inline styles the cluster layer writes — the box under a session's
// cards and the header pill over it — called rather than read.
//
// They were object literals inside SessionClusters' render, where the only way
// to pin them was to match their source text. session-box-camera,
// box-translate-864, overview-legible-846 and cluster-label-gutter-977 still
// do that for the exact expressions, and that is their job: they say how each
// value is spelled. This file says what the spelling adds up to on screen, with
// numbers, now that cluster-bounds.ts builds both where a test can call it.
import { describe, it, expect } from "vitest";
import type { CSSProperties } from "react";
import { clusterBoxStyle, clusterLabelStyle, labelMaxWidth, type Cluster } from "../cluster-bounds";

/** A one-card cluster: 240px card plus PAD on both sides, somewhere off the origin. */
const C: Cluster = { sessionId: "s1", label: "vcrm-core", fullLabel: "vcrm-core", x: 100, y: 250, w: 276, h: 210 };

/** 1×, halfway, the 0.32 a real board settles at, and React Flow's minZoom here. */
const ZOOMS = [1, 0.5, 0.32, 0.2];

/** A custom property, which CSSProperties does not declare. */
const custom = (s: CSSProperties, name: string) => (s as Record<string, unknown>)[name];

describe("the box under a session's cards", () => {
  it("sits at the cluster's layout coordinates, as a translate from the origin (#864)", () => {
    expect(clusterBoxStyle(C, 210)).toMatchObject({
      position: "absolute",
      left: 0,
      top: 0,
      transform: "translate(100px, 250px)",
      width: 276,
      height: 210,
    });
  });

  it("is a function of the cluster and its hue alone, so no pan or zoom can reach it (#353)", () => {
    // The defect was the camera folded into four eased properties. A builder
    // that is never handed the viewport cannot fold it in.
    expect(clusterBoxStyle.length).toBe(2);
  });

  it("hands the sheet a hue and composes no colour of its own (#330)", () => {
    const s = clusterBoxStyle(C, 210);
    expect(custom(s, "--session-hue")).toBe(210);
    expect(Object.keys(s).filter(k => /colou?r|background|border/i.test(k))).toEqual([]);
  });
});

describe("the header pill over it", () => {
  it("is 1× on screen at every zoom: the layer's scale is divided back out (#846)", () => {
    for (const zoom of ZOOMS) {
      const s = clusterLabelStyle(C, zoom, 210);
      expect(s.transform, `zoom ${zoom}`).toBe(`scale(${1 / zoom})`);
      expect(s.transformOrigin).toBe("left top");
    }
  });

  it("keeps its 12px lift above the box on screen at every zoom (#846)", () => {
    for (const zoom of ZOOMS) {
      const top = clusterLabelStyle(C, zoom, 210).top as number;
      expect((C.y - top) * zoom, `zoom ${zoom}`).toBeCloseTo(12, 9);
    }
  });

  it("starts 16 layout units inside the box it labels", () => {
    for (const zoom of ZOOMS) expect(clusterLabelStyle(C, zoom, 210).left, `zoom ${zoom}`).toBe(C.x + 16);
  });

  it("is capped at labelMaxWidth for its own box at that zoom (#977)", () => {
    for (const zoom of ZOOMS) {
      expect(clusterLabelStyle(C, zoom, 210).maxWidth, `zoom ${zoom}`).toBe(labelMaxWidth(C.w, zoom));
    }
  });

  it("draws a zoom of zero at 1× rather than at Infinity", () => {
    // React Flow clamps to minZoom and never hands out a zero; this is the
    // fallback the `|| 1` guards, and it lands the pill where 1× would.
    expect(clusterLabelStyle(C, 0, 210)).toEqual(clusterLabelStyle(C, 1, 210));
  });

  it("wears the same hue as the box beneath it", () => {
    expect(custom(clusterLabelStyle(C, 0.32, 210), "--session-hue")).toBe(210);
    expect(custom(clusterLabelStyle(C, 0.32, 210), "--session-hue")).toBe(custom(clusterBoxStyle(C, 210), "--session-hue"));
  });
});
