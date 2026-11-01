// The stage's hold on the older session hosts (use-older-hosts.ts), run under
// fake-react: read only on Windows, read again when the stage moves, and the
// Review dialog's End, Keep them running and cancel as the reader meets them.
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async () => (await import("./fake-react")).react);

import { flush, mount } from "./fake-react";
import type { ApiFailure, HostsAnswer, OlderHost } from "../terminal-api";
import type { HostsApi } from "../components/terminal/older-hosts";
import { useOlderHosts, type OlderHosts } from "../components/terminal/use-older-hosts";

const id = (n: number) => n.toString(16).padStart(32, "0");
const session = (n: number) => ({ id: id(n), name: `proj-${n}`, agent: "claude" as const, cwd: `C:\\work\\proj-${n}`, conversation: "", started: 1 });
const host = (generation: number, ...sessions: ReturnType<typeof session>[]): OlderHost => ({ generation, state: "stranded", sessions });
const answer = (hosts: OlderHost[], launchesRefused: string | null = null): HostsAnswer => ({ ok: true, hosts, launchesRefused });
const OUTDATED: ApiFailure = { ok: false, status: 409, error: "The sessions on that session host changed. Review them again.", code: "consent-outdated" };
const GONE: ApiFailure = { ok: false, status: 409, error: "That session host is no longer running.", code: "host-gone" };

function fakeApi(reads: Array<HostsAnswer | ApiFailure>, ends: Array<{ ok: true; ended: number } | ApiFailure> = []) {
  const calls: string[] = [];
  let r = 0, e = 0;
  const api: HostsApi = {
    read: async () => { calls.push("read"); return reads[Math.min(r++, reads.length - 1)]; },
    end: async order => { calls.push(`end ${order.generation} ${order.sessions.length}`); return ends[e++]; },
  };
  return { api, calls };
}

interface Props { windows: boolean; subject: string; api: HostsApi; announce: (s: string) => void }
function run(props: Props) {
  let got: OlderHosts | null = null;
  const m = mount((p: Props) => { got = useOlderHosts(p.windows, p.subject, p.announce, p.api); return null; }, props);
  return { m, get h() { return got!; } };
}

describe("the older hosts on the stage", () => {
  it("reads nothing off Windows, and has no line", async () => {
    const { api, calls } = fakeApi([answer([host(1, session(1))])]);
    const s = run({ windows: false, subject: "session:a", api, announce: vi.fn() });
    await flush();
    expect([s.h.line, s.h.canReview, calls]).toEqual([null, false, []]);
  });

  it("reads on Windows as the stage opens and again when it moves, and has no line on a failure", async () => {
    const { api, calls } = fakeApi([answer([host(1, session(1))]), { ok: false, status: 409, error: "No terminal.", code: "no-terminal" }]);
    const props = { windows: true, subject: "session:a", api, announce: vi.fn() };
    const s = run(props);
    await flush();
    // CHANGED ON PURPOSE (here and twice below): the line is Figma V4's "{n}
    // sessions on an older host" (V4's Figma), not "still runs on an older
    // session host."
    expect([s.h.line, s.h.canReview]).toEqual(["1 session on an older host", true]);
    s.m.rerender({ ...props, subject: "launch:k-1" });
    await flush();
    expect([s.h.line, s.h.canReview, calls]).toEqual([null, false, ["read", "read"]]);
  });

  it("closes on cancel having asked nothing, and on Keep them running says the kept line until the list changes", async () => {
    const one = answer([host(1, session(1))]);
    const two = answer([host(1, session(1), session(2))]);
    const { api, calls } = fakeApi([one, one, two]);
    const props = { windows: true, subject: "session:a", api, announce: vi.fn() };
    const s = run(props);
    await flush();
    s.h.review();
    expect(s.h.open).toBe(true);
    s.h.cancel();
    expect([s.h.open, s.h.line]).toEqual([false, "1 session on an older host"]);
    s.h.review();
    s.h.keep();
    expect([s.h.open, s.h.line]).toEqual([false, "Kept running: the Command Panel cannot open that session here."]);
    s.m.rerender({ ...props, subject: "session:b" });
    await flush();
    expect(s.h.line, "the same list: still kept").toBe("Kept running: the Command Panel cannot open that session here.");
    s.m.rerender({ ...props, subject: "session:c" });
    await flush();
    expect(s.h.line, "another list: asked again").toBe("2 sessions on an older host");
    expect(calls).toEqual(["read", "read", "read"]);
  });

  it("ends the reviewed host's sessions once, says so, and closes when nothing is left", async () => {
    const { api, calls } = fakeApi([answer([host(3, session(1), session(2))]), answer([])], [{ ok: true, ended: 2 }]);
    const announce = vi.fn();
    const s = run({ windows: true, subject: "session:a", api, announce });
    await flush();
    s.h.review();
    const shown = s.h.view!.hosts[0];
    s.h.end(shown);
    s.h.end(shown);
    expect(s.h.busy).toBe(3);
    await flush();
    expect([s.h.open, s.h.busy, s.h.line]).toEqual([false, null, null]);
    expect(announce).toHaveBeenCalledWith("Ended 2 sessions on an older session host.");
    expect(calls, "one end, however many presses").toEqual(["read", "end 3 2", "read"]);
  });

  it("keeps the dialog open on a list that changed, with the new list and the engine's sentence", async () => {
    const changed = answer([host(3, session(1), session(2), session(4))]);
    const { api } = fakeApi([answer([host(3, session(1), session(2))]), changed], [OUTDATED]);
    const s = run({ windows: true, subject: "session:a", api, announce: vi.fn() });
    await flush();
    s.h.review();
    s.h.end(s.h.view!.hosts[0]);
    await flush();
    expect([s.h.open, s.h.said, s.h.view!.hosts[0].sessions.length]).toEqual([true, OUTDATED.error, 3]);
  });

  it("closes when the host went and none is left, and keeps the list on any other refusal, asked once", async () => {
    const gone = fakeApi([answer([host(3, session(1))]), answer([])], [GONE]);
    const a = run({ windows: true, subject: "session:a", api: gone.api, announce: vi.fn() });
    await flush();
    a.h.review();
    a.h.end(a.h.view!.hosts[0]);
    await flush();
    expect([a.h.open, a.h.line]).toEqual([false, null]);

    const failed: ApiFailure = { ok: false, status: 500, error: "The deck answered in a form this page cannot read." };
    const other = fakeApi([answer([host(3, session(1))])], [failed]);
    const b = run({ windows: true, subject: "session:a", api: other.api, announce: vi.fn() });
    await flush();
    b.h.review();
    b.h.end(b.h.view!.hosts[0]);
    await flush();
    expect([b.h.open, b.h.said, b.h.view!.hosts.length]).toEqual([true, failed.error, 1]);
    expect(other.calls).toEqual(["read", "end 3 1"]);
  });
});
