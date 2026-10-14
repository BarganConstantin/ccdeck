import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DENSITY_KEY,
  TEXT_SIZE_KEY,
  resolveDensity,
  resolveTextSize,
} from "../reading-preferences";
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
  it.each(["default", "larger", "largest"])(
    "restores %s text consistently with React",
    (value) => {
      expect(boot(value, "compact")["data-text-size"]).toBe(
        resolveTextSize(value),
      );
    },
  );
  it.each(["compact", "default", "comfortable"])(
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
    expect(draw("default").match(/name="text-size"/g)).toHaveLength(3);
    expect(draw("default").match(/name="density"/g)).toHaveLength(3);
    expect(draw("default")).toMatch(/disabled="">Reset to defaults/);
    expect(draw("largest")).not.toMatch(/disabled="">Reset to defaults/);
  });
});
