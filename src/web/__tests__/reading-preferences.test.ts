import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DENSITY_KEY,
  TEXT_SIZE_INCREASE,
  TEXT_SIZES,
  TEXT_SIZE_KEY,
  resolveDensity,
  resolveTextSize,
} from "../reading-preferences";
import { CARD_BODY_PX, cardBodyPx, fitZoomForDrawnLanes, nextLod } from "../semantic-zoom";
import ReadingSection from "../components/ReadingSection";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find((m) =>
  m[1].includes(TEXT_SIZE_KEY),
)![1];
function boot(size: string | null, density: string | null, denied = false) {
  const attrs: Record<string, string> = {};
  const window = Object.defineProperty({}, "localStorage", {
    get() {
      if (denied) throw new Error("Blocked");
      return {
        getItem: (key: string) =>
          key === TEXT_SIZE_KEY ? size : key === DENSITY_KEY ? density : null,
      };
    },
  });
  new Function("window", "document", script)(window, {
    documentElement: {
      setAttribute: (key: string, value: string) => {
        attrs[key] = value;
      },
    },
  });
  return attrs;
}
describe("reading preferences before first paint", () => {
  it.each([null, "", "invalid", "LARGER", "2", "largest "])(
    "keeps the existing appearance for invalid stored values %s",
    (value) => {
      expect(resolveTextSize(value)).toBe("default");
      expect(resolveDensity(value)).toBe("default");
      expect(boot(value, value)).toEqual({
        "data-text-size": "default",
        "data-density": "default",
      });
    },
  );
  it.each(["smallest", "smaller", "default", "larger", "largest"])(
    "restores %s text consistently with React",
    (value) => {
      expect(boot(value, "compact")["data-text-size"]).toBe(
        resolveTextSize(value),
      );
    },
  );
  it.each(["tightest", "tighter", "compact", "default", "comfortable"])(
    "restores %s density consistently with React",
    (value) => {
      expect(boot("largest", value)["data-density"]).toBe(
        resolveDensity(value),
      );
    },
  );
  it("boot survives blocked storage", () => {
    expect(boot(null, null, true)).toEqual({
      "data-text-size": "default",
      "data-density": "default",
    });
  });
  it("uses separately named native radio groups and a reset disabled at default", () => {
    const draw = (textSize: "default" | "largest") =>
      renderToStaticMarkup(
        createElement(ReadingSection, {
          textSize,
          density: "default",
          onTextSize() {},
          onDensity() {},
        }),
      );
    expect(draw("default").match(/name="text-size"/g)).toHaveLength(5);
    expect(draw("default").match(/name="density"/g)).toHaveLength(5);
    expect(draw("default")).toMatch(/disabled="">Reset to defaults/);
    expect(draw("largest")).not.toMatch(/disabled="">Reset to defaults/);
  });
});

describe("the canvas reads the text size the sheet draws", () => {
  const reading = readFileSync(new URL("../styles/reading.css", import.meta.url), "utf8");
  it.each(TEXT_SIZES.filter((size) => size !== "default"))(
    "holds TEXT_SIZE_INCREASE.%s to reading.css",
    (size) => {
      const m = new RegExp(`:root\\[data-text-size="${size}"\\] \\{ --ui-text-increase: (-?\\d+)px; \\}`).exec(reading);
      expect(m, `${size} in reading.css`).not.toBeNull();
      expect(Number(m![1])).toBe(TEXT_SIZE_INCREASE[size]);
    },
  );
  it("judges the full card at smaller text's body, and at the designed body for larger text", () => {
    expect(cardBodyPx(TEXT_SIZE_INCREASE.smallest)).toBe(9);
    expect(cardBodyPx(TEXT_SIZE_INCREASE.smaller)).toBe(10);
    expect(cardBodyPx(TEXT_SIZE_INCREASE.default)).toBe(CARD_BODY_PX);
    expect(cardBodyPx(TEXT_SIZE_INCREASE.largest)).toBe(CARD_BODY_PX);
  });
  it("gives 9px of body over to the faces at a zoom where 11px still reads", () => {
    // 11 × 0.7 = 7.7px reads; 9 × 0.7 = 6.3px is under the 7.2px floor.
    expect(nextLod(null, 0.7)).toBe("detail");
    expect(nextLod(null, 0.7, undefined, cardBodyPx(-2))).not.toBe("detail");
    // And the fit keeps the bubbles' lane only where the full card is drawn.
    expect(fitZoomForDrawnLanes(0.7, 0.9)).toBe(0.7);
    expect(fitZoomForDrawnLanes(0.7, 0.9, cardBodyPx(-2))).toBeGreaterThan(0.7);
  });
});
