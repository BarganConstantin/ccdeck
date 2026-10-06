// The git view opens and closes in four phases, and each phase ends on the
// panel's own transition rather than on a timer: a reopen that lands while the
// panel is still sliding out only retargets it, a keyboard open or close is
// instant, and a phase never ends on a transition the panel did not run.
import { describe, expect, it } from "vitest";
import { phaseAfterRequest, phaseAfterTransition, panelMounted, type GitViewPhase } from "../git-view-phase";
import { sourceOf } from "./client-source";

const own = (property: string) => ({ own: true, property });

describe("a request to open or close", () => {
  it("opens from the pointer through `opening`, and from the keyboard straight to `open`", () => {
    expect(phaseAfterRequest("closed", true, true)).toBe("opening");
    expect(phaseAfterRequest("closed", true, false)).toBe("open");
  });

  it("closes from the pointer through `closing`, and from the keyboard straight to `closed`", () => {
    expect(phaseAfterRequest("open", false, true)).toBe("closing");
    expect(phaseAfterRequest("open", false, false)).toBe("closed");
  });

  it("retargets a panel on its way out instead of waiting for it to leave", () => {
    // Reopen 60ms into a close: the same element turns round where it stands.
    expect(phaseAfterRequest("closing", true, true)).toBe("opening");
    expect(phaseAfterRequest("closing", true, false)).toBe("open");
    expect(phaseAfterRequest("opening", false, true)).toBe("closing");
    expect(phaseAfterRequest("opening", false, false)).toBe("closed");
  });

  it("leaves a settled panel alone when asked for what it already is", () => {
    for (const animate of [true, false]) {
      expect(phaseAfterRequest("open", true, animate)).toBe("open");
      expect(phaseAfterRequest("closed", false, animate)).toBe("closed");
    }
    expect(phaseAfterRequest("opening", true, true)).toBe("opening");
    expect(phaseAfterRequest("closing", false, true)).toBe("closing");
  });
});

describe("the panel's transition ending", () => {
  it("settles an opening panel open and a closing one closed", () => {
    expect(phaseAfterTransition("opening", true, own("transform"))).toBe("open");
    expect(phaseAfterTransition("closing", false, own("transform"))).toBe("closed");
  });

  it("settles on the fade under reduced motion, where the panel does not slide", () => {
    expect(phaseAfterTransition("opening", true, own("opacity"))).toBe("open");
    expect(phaseAfterTransition("closing", false, own("opacity"))).toBe("closed");
  });

  it("acts only while the target still agrees", () => {
    // A close's transitionend arriving after a reopen retargeted it must not
    // unmount the panel the reader just asked for.
    expect(phaseAfterTransition("opening", false, own("transform"))).toBe("opening");
    expect(phaseAfterTransition("closing", true, own("transform"))).toBe("closing");
  });

  it("ignores a child's transition bubbling up, and properties the panel does not travel on", () => {
    expect(phaseAfterTransition("closing", false, { own: false, property: "opacity" })).toBe("closing");
    expect(phaseAfterTransition("opening", true, own("background-color"))).toBe("opening");
  });

  it("does nothing to a settled panel", () => {
    const settled: GitViewPhase[] = ["open", "closed"];
    for (const p of settled) expect(phaseAfterTransition(p, p === "open", own("transform"))).toBe(p);
  });
});

describe("what is in the DOM", () => {
  it("mounts the panel in every phase but closed", () => {
    expect(panelMounted("closed")).toBe(false);
    for (const p of ["opening", "open", "closing"] as const) expect(panelMounted(p)).toBe(true);
  });
});

describe("ending a phase", () => {
  it("ends on transitionend, never on a timer", () => {
    const src = sourceOf("git-view-phase.ts");
    expect(src).toMatch(/transitionend|onTransitionEnd/);
    expect(src).not.toMatch(/setTimeout|setInterval/);
  });
});
