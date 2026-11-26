// Chat's live row (ChatTurn.tsx LiveLine): what the session still does once
// its turn is over. A compaction with its own clock and no made-up progress;
// background agents counted, with each one's type, task and time a press
// away and the way to Term; one sentence for a screen reader, never a clock.
// The facts behind it are live-activity.test.ts; ChatView keeping the turn's
// "Worked for…" beside it is live-activity-view.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveLine, TurnClock } from "../components/chat/ChatTurn";
import type { ChatLive } from "../components/chat/chat-model";
import { setLanguage, t } from "../i18n";
import { all, mount, one, textOf } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => setLanguage("en"));
afterEach(() => { vi.useRealTimers(); setLanguage("en"); });

const NOW = 3_000_000;
const AGENTS: ChatLive["agents"] = [
  { id: "s::ag1", label: "Explore", task: "Find the flaky tests", since: NOW - 125_000 },
  { id: "s::ag2", label: "general-purpose", since: NOW - 4_000 },
];
const byClass = (tree: unknown, name: string) => one(tree, el => el.props.className === name);

describe("background agents", () => {
  it("are counted on one row, closed, with the press that opens their list", () => {
    const view = mount(LiveLine, { live: { agents: AGENTS } });
    const row = one(view.tree, el => el.props["data-live"] === "background")!;
    expect(row.props["data-state"]).toBe("working");
    expect(textOf(byClass(row, "chat-progress-text"))).toBe("Waiting for 2 background agents");
    const toggle = byClass(row, "chat-live-toggle")!;
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(byClass(view.tree, "chat-live-agents")).toBeNull();
  });

  it("open to each agent's type, its task when the call said one, and how long it has run, with the way to Term", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const onShowTerm = vi.fn();
    const view = mount(LiveLine, { live: { agents: AGENTS }, onShowTerm });
    (byClass(view.tree, "chat-live-toggle")!.props.onClick as () => void)();
    const toggle = byClass(view.tree, "chat-live-toggle")!;
    expect(toggle.props["aria-expanded"]).toBe(true);
    const list = byClass(view.tree, "chat-live-agents")!;
    expect(toggle.props["aria-controls"]).toBe(list.props.id);
    const rows = all(list, el => el.props.className === "chat-live-agent");
    expect(rows.map(r => textOf(byClass(r, "chat-live-agent-name")))).toEqual(["Explore", "general-purpose"]);
    expect(rows.map(r => byClass(r, "chat-live-agent-task") && textOf(byClass(r, "chat-live-agent-task")))).toEqual(["Find the flaky tests", null]);
    expect(rows.map(r => one(r, el => el.type === TurnClock)!.props.since)).toEqual([NOW - 125_000, NOW - 4_000]);
    const term = one(list, el => el.props.className === "chat-ask-term")!;
    expect(textOf(term)).toBe(t("board.chat.showTerm"));
    (term.props.onClick as () => void)();
    expect(onShowTerm).toHaveBeenCalledTimes(1);
    (toggle.props.onClick as () => void)();
    expect(byClass(view.tree, "chat-live-agents")).toBeNull();
  });

  it("say one agent as one", () => {
    expect(textOf(byClass(mount(LiveLine, { live: { agents: AGENTS.slice(0, 1) } }).tree, "chat-progress-text"))).toBe("Waiting for 1 background agent");
  });

  it("are counted in each language's own plural forms", () => {
    setLanguage("ro");
    const said = (n: number) => t("board.chat.live.background", { count: n });
    expect([said(1), said(2), said(20)]).toEqual(["Se așteaptă 1 agent în fundal", "Se așteaptă 2 agenți în fundal", "Se așteaptă 20 de agenți în fundal"]);
    // Every other language says them in its own words, the count in place.
    setLanguage("en");
    const english = [said(1), said(2), t("board.chat.live.compacting"), t("board.stage.backgroundAgents", { count: 3 })];
    for (const lang of ["de", "es", "fr", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"] as const) {
      setLanguage(lang);
      const own = [said(1), said(2), t("board.chat.live.compacting"), t("board.stage.backgroundAgents", { count: 3 })];
      own.forEach((text, i) => expect(text, `${lang}: ${english[i]}`).not.toBe(english[i]));
      expect(own[0]).toContain("1");
      expect(own[1]).toContain("2");
      expect(own[3]).toContain("3");
    }
  });
});

describe("a compaction", () => {
  it("says so, with its own clock and no progress beyond it", () => {
    const view = mount(LiveLine, { live: { compacting: { since: NOW - 37_000 } } });
    const row = one(view.tree, el => el.props["data-live"] === "compacting")!;
    expect(textOf(byClass(row, "chat-progress-text"))).toBe("Compacting conversation…");
    expect(one(row, el => el.type === TurnClock)!.props.since).toBe(NOW - 37_000);
    expect(all(row, el => el.type === "progress" || el.props.role === "progressbar")).toEqual([]);
    expect(byClass(view.tree, "chat-live-toggle")).toBeNull();
  });

  it("goes first when background agents run beside it", () => {
    const view = mount(LiveLine, { live: { compacting: { since: NOW }, agents: AGENTS } });
    expect(all(view.tree, el => el.props["data-live"] !== undefined).map(el => el.props["data-live"])).toEqual(["compacting", "background"]);
  });
});

describe("what a screen reader hears", () => {
  it("is the words, politely, once they change, and never a clock", () => {
    const view = mount(LiveLine, { live: { compacting: { since: NOW }, agents: AGENTS } });
    const said = one(view.tree, el => el.props.role === "status")!;
    expect(said.props["aria-live"]).toBe("polite");
    expect(textOf(said)).toBe("Compacting conversation…. Waiting for 2 background agents");
    view.rerender({ live: { agents: AGENTS.slice(1) } });
    expect(textOf(one(view.tree, el => el.props.role === "status"))).toBe("Waiting for 1 background agent");
  });
});
