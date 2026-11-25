// A tool group in Chat, live (ChatTurn.tsx ToolGroup): it opens itself while a
// call runs and folds when the calls finish, unless the pointer or the focus
// is in it; once you open or close it, it stays as you left it, through the
// calls that run after. It used to be `open={running || undefined}`, which
// snapped shut under the reader the moment the last call finished.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolGroup } from "../components/chat/ChatTurn";
import type { ChatTurn } from "../components/chat/chat-model";
import { setLanguage } from "../i18n";
import { mount, type Drawn } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => setLanguage("en"));

describe("a tool group, live", () => {
  type Tool = Extract<ChatTurn, { kind: "tool" }>;
  const call = (running?: boolean): Tool => ({ kind: "tool", name: "Bash", arg: "npm test", ...(running ? { running } : {}) });

  function rig(running: boolean, read = false) {
    const node = { matches: (q: string) => read && q.includes(":hover") };
    const view = mount(ToolGroup, { turns: [call(running)] }, {
      commit: tree => { (((tree as Drawn).ref ?? (tree as Drawn).props.ref) as { current: unknown }).current = node; },
    });
    const open = () => (view.tree as Drawn).props.open;
    /** The browser's toggle event: the details as it is after the change. */
    const toggle = (now: boolean) => ((view.tree as Drawn).props.onToggle as (e: unknown) => void)({ currentTarget: { open: now } });
    const set = (on: boolean) => view.rerender({ turns: [call(on)] });
    return { view, open, toggle, set };
  }

  it("opens itself while a call runs and folds when the calls finish", () => {
    const r = rig(true);
    expect(r.open()).toBe(true);
    r.set(false);
    expect(r.open()).toBe(false);
    // The browser says the details closed, as React closed them: still the calls'.
    r.toggle(false);
    r.set(true);
    expect(r.open()).toBe(true);
  });

  it("does not fold under a reader whose pointer or focus is in it", () => {
    const r = rig(true, true);
    r.set(false);
    expect(r.open()).toBe(true);
  });

  it("stays closed once you closed it, through the next call that runs", () => {
    const r = rig(true);
    r.toggle(false);
    expect(r.open()).toBe(false);
    r.set(false);
    r.set(true);
    expect(r.open()).toBe(false);
  });

  it("stays open once you opened it, after its calls finish", () => {
    const r = rig(false);
    expect(r.open()).toBe(false);
    r.toggle(true);
    expect(r.open()).toBe(true);
    r.set(true);
    r.set(false);
    expect(r.open()).toBe(true);
  });
});
