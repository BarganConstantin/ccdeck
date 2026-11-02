// V4's dialog shell (PR 3a): the frame, the scrim, the header, the shared
// footer, the entrance and the "instant" flag that turns it off after a key.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";
import { installInputModality } from "../input-modality";

const css = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

/** The value of `prop` in the first rule written for exactly this selector. */
function decl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  const m = rule && new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(rule[1]);
  return m ? m[1].trim() : null;
}

describe("V4 dialog frame", () => {
  it(".modal takes the overlay radius and the overlay shadow, and no ring", () => {
    expect(decl(".modal", "border-radius")).toBe("var(--r-overlay)");
    expect(decl(".modal", "box-shadow")).toBe("var(--shadow-overlay)");
  });

  it("the scrim is the theme's token, with no per-scheme override", () => {
    expect(decl(".modal-backdrop", "--modal-scrim")).toBe("var(--scrim)");
    expect(css).not.toMatch(/\.modal-backdrop\s*\{\s*--modal-scrim/);
    expect(css).not.toMatch(/data-color-scheme="light"\]\s*\.modal-backdrop/);
  });

  it(".modal-head: 16/8 padding, no fill, a soft divider, a 20px title line", () => {
    expect(decl(".modal-head", "padding")).toBe("0 8px 0 16px");
    expect(decl(".modal-head", "border-bottom")).toBe("1px solid var(--line-soft)");
    expect(decl(".modal-head", "background")).toBeNull();
    expect(decl(".modal-head", "min-height")).toBe("var(--dialog-head-h)");
    expect(decl(".modal-head h2,\n.modal-tool-name", "line-height")).toBe("var(--lh-card-title)");
  });

  it(".modal-foot: the token height, 16px sides, a soft top divider", () => {
    expect(decl(".modal-foot", "min-height")).toBe("var(--dialog-foot-h)");
    expect(decl(".modal-foot", "padding")).toBe("0 16px");
    expect(decl(".modal-foot", "gap")).toBe("8px");
    expect(decl(".modal-foot", "justify-content")).toBe("flex-end");
    expect(decl(".modal-foot", "border-top")).toBe("1px solid var(--line-soft)");
    expect(decl(".modal-foot", "background")).toBeNull();
  });
});

describe("V4 dialog motion", () => {
  it("popIn scales in from --enter-scale and no longer lifts", () => {
    const m = /@keyframes popIn\s*\{([^\n]*)\}\s*\n/.exec(css);
    expect(m).not.toBeNull();
    expect(m![1]).toContain("transform: scale(var(--enter-scale))");
    expect(m![1]).not.toContain("translateY");
  });

  it("the dialog and its scrim animate on the Base duration and the house ease", () => {
    expect(decl(".modal", "animation")).toBe("popIn var(--dur-base) var(--ease)");
    expect(decl(".modal-backdrop", "animation")).toBe("fadeIn var(--dur-base) var(--ease)");
  });

  it("data-motion=instant turns the dialog and its scrim off", () => {
    expect(css).toMatch(
      /:root\[data-motion="instant"\] :is\(\.modal-backdrop, \.modal\)\s*\{\s*animation:\s*none;\s*\}/,
    );
  });
});

describe("Quick open never animates", () => {
  const qoSource = readFileSync(fileURLToPath(new URL("../components/QuickOpen.tsx", import.meta.url)), "utf8");

  // V4's motion rules (D19): it opens and closes at once, by key or by pointer.
  // qo-in / qo-out / qo-fade-out, the .closing state and the data-motion
  // opt-in that switched them off are gone; nothing is left to switch off.
  it("has no entrance, no exit and no keyframes of its own", () => {
    expect(css).not.toMatch(/@keyframes qo-/);
    expect(decl(".qo", "animation")).toBeNull();
    expect(decl(".qo-backdrop", "animation")).toBe("none");
    expect(css).not.toMatch(/\.qo(-backdrop)?\.closing/);
  });

  it("unmounts at once instead of waiting for an animationend", () => {
    expect(qoSource).not.toMatch(/animationend|onAnimationEnd|EXIT_MS|closing/i);
    expect(qoSource).toMatch(/const leave = finish;/);
  });
});

describe("input modality", () => {
  type Handler = (e: unknown) => void;
  function fakeDoc() {
    const handlers = new Map<string, { fn: Handler; opts: unknown }>();
    const doc = {
      documentElement: { dataset: {} as Record<string, string | undefined> },
      addEventListener: (type: string, fn: Handler, opts: unknown) => { handlers.set(type, { fn, opts }); },
      removeEventListener: (type: string) => { handlers.delete(type); },
    };
    return { doc: doc as unknown as Document, root: doc.documentElement, handlers };
  }

  it("a key sets data-motion=instant, a pointer press clears it", () => {
    const { doc, root, handlers } = fakeDoc();
    const stop = installInputModality(doc);
    handlers.get("keydown")!.fn({});
    expect(root.dataset.motion).toBe("instant");
    handlers.get("pointerdown")!.fn({});
    expect(root.dataset.motion).toBeUndefined();
    stop();
  });

  it("listens in the capture phase, passively", () => {
    const { doc, handlers } = fakeDoc();
    const stop = installInputModality(doc);
    expect(handlers.get("keydown")!.opts).toEqual({ capture: true, passive: true });
    expect(handlers.get("pointerdown")!.opts).toEqual({ capture: true, passive: true });
    stop();
  });

  it("installs once: a second call hands back the same remover", () => {
    const { doc, handlers } = fakeDoc();
    const stop = installInputModality(doc);
    expect(installInputModality(doc)).toBe(stop);
    stop();
    expect(handlers.size).toBe(0);
  });
});
