import { describe, expect, it, vi } from "vitest";
import { initialState } from "../reducer";
import { usePauseGate } from "../use-pause-gate";
import { mount } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

describe("the Board always follows its event stream", () => {
  it("ignores legacy pause toggles and immediately accepts new events", () => {
    const stateRef = { current: initialState() };
    const view = mount(() => usePauseGate(stateRef), {});
    const now = () => view.tree as ReturnType<typeof usePauseGate>;
    for (const seq of [1, 2, 3]) {
      now().togglePause();
      expect(now().paused).toBe(false);
      expect(now().pauseGate.accept({ seq, receivedAt: seq, payload: {
        session_id: "main", hook_event_name: "SessionStart", cwd: "/project",
      } })).toBe(true);
    }
    expect(now().pauseGate.size).toBe(0);
    view.unmount();
  });
});
