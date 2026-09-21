// The desktop tray reads the board through the page's own reducer (#1160).
//
// The point being pinned is agreement: the icon and the count are the favicon
// and the topbar chip, computed by the same functions from the same events. A
// tray that said "1 waiting" beside a chip that said nothing — or the reverse —
// would teach the user to trust neither.
import { describe, it, expect } from "vitest";
import { createTrayModel } from "../tray-model";
import { ambientSignal } from "../ambient";
import type { HookEnvelope, HookPayload } from "../types";

let seq = 0;
function env(payload: HookPayload, receivedAt = 1_000 + seq): HookEnvelope {
  seq++;
  return { seq, receivedAt, source: "hook", payload };
}

function session(sid: string, cwd: string): HookEnvelope[] {
  return [
    env({ session_id: sid, hook_event_name: "SessionStart", cwd }),
    env({ session_id: sid, hook_event_name: "UserPromptSubmit", prompt: "go", cwd }),
    env({ session_id: sid, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `${sid}-t1`, cwd }),
  ];
}

describe("what the tray icon says", () => {
  it("is offline until the stream is connected, like the favicon", () => {
    const m = createTrayModel();
    expect(m.snapshot().icon).toBe("offline");
    m.setConnected(true);
    expect(m.snapshot().icon).toBe("idle");
  });

  it("is running while a session works", () => {
    const m = createTrayModel();
    m.setConnected(true);
    for (const e of session("s1", "/src/vcrm-core")) m.apply(e);
    const s = m.snapshot();
    expect(s.icon).toBe("running");
    expect(s.running).toBe(1);
    expect(s.waiting).toBe(0);
    expect(s.title).toBe(ambientSignal({ waiting: 0, running: 1 }).title);
  });

  it("counts a permission prompt, names the session, and matches the tab title", () => {
    const m = createTrayModel();
    m.setConnected(true);
    for (const e of session("s1", "/src/vcrm-core")) m.apply(e);
    m.apply(env({ session_id: "s1", hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" }));
    const s = m.snapshot();
    expect(s.icon).toBe("waiting");
    expect(s.waiting).toBe(1);
    expect(s.blocked[0]).toMatchObject({ id: "s1", kind: "permission" });
    expect(s.title).toBe(ambientSignal({ waiting: 1, running: s.running }).title);
  });

  it("does not count an idle prompt, exactly as the chip does not (#348)", () => {
    const m = createTrayModel();
    m.setConnected(true);
    for (const e of session("s1", "/src/vcrm-core")) m.apply(e);
    m.apply(env({ session_id: "s1", hook_event_name: "Stop" }));
    m.apply(env({ session_id: "s1", hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }));
    expect(m.snapshot().waiting).toBe(0);
  });

  it("clears when the session moves again", () => {
    const m = createTrayModel();
    m.setConnected(true);
    for (const e of session("s1", "/src/vcrm-core")) m.apply(e);
    m.apply(env({ session_id: "s1", hook_event_name: "Notification", notification_type: "permission_prompt", message: "x" }));
    m.apply(env({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "s1-t1" }));
    expect(m.snapshot().waiting).toBe(0);
  });

  it("starts over on reset, so a reconnect's replay is not counted twice", () => {
    const m = createTrayModel();
    m.setConnected(true);
    for (const e of session("s1", "/a")) m.apply(e);
    m.reset();
    expect(m.snapshot().running).toBe(0);
  });

  it("forgets a session nobody has heard from in 90 minutes, as the page does", () => {
    const m = createTrayModel();
    m.setConnected(true);
    for (const e of session("s1", "/a")) m.apply(e);
    m.apply(env({ session_id: "s1", hook_event_name: "Notification", notification_type: "permission_prompt", message: "x" }));
    expect(m.snapshot().waiting).toBe(1);
    m.tick(1_000 + 91 * 60_000);
    expect(m.snapshot().waiting).toBe(0);
  });
});
