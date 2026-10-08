// The git view and the rail's Usage and Machine panels share the right of the
// window. While the view is open the panels step out of sight under it, so a
// press on Usage or Machine there would turn a button on and show nothing:
// it closes the view instead, and the panel shows in its own place.
import { afterEach, describe, expect, it } from "vitest";
import { closeGitViewRequest, gitViewRequest, openGitViewRequest, yieldingRailToggle } from "../git-view-request";

afterEach(() => closeGitViewRequest("key"));

function panel(open: boolean) {
  let value = open;
  const set = (v: boolean | ((o: boolean) => boolean)) => { value = typeof v === "function" ? v(value) : v; };
  return { set, now: () => value };
}

describe("a Usage or Machine toggle", () => {
  it("toggles as before while the git view is closed", () => {
    const p = panel(false);
    const toggle = yieldingRailToggle(p.set, "pointer");
    toggle(o => !o);
    expect(p.now()).toBe(true);
    toggle(o => !o);
    expect(p.now()).toBe(false);
  });

  it("closes the open git view and shows the panel, whether it was on or off", () => {
    for (const was of [false, true]) {
      openGitViewRequest("pointer", { agentId: "s1" });
      const p = panel(was);
      yieldingRailToggle(p.set, "pointer")(o => !o);
      expect(gitViewRequest().open, `was ${was}`).toBe(false);
      expect(p.now(), `was ${was}`).toBe(true);
    }
  });

  it("closes the view the way it was asked: a key never animates", () => {
    openGitViewRequest("pointer", { agentId: "s1" });
    yieldingRailToggle(panel(false).set, "key")(o => !o);
    expect(gitViewRequest()).toMatchObject({ open: false, how: "key" });
  });

  it("leaves the view open for a panel's own close", () => {
    openGitViewRequest("pointer", { agentId: "s1" });
    const p = panel(true);
    yieldingRailToggle(p.set, "pointer")(false);
    expect(gitViewRequest().open).toBe(true);
    expect(p.now()).toBe(false);
  });
});
