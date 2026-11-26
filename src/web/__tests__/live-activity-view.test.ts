// Chat with the session still at work after its turn (ChatView, live-activity.ts):
// the turn that ended keeps its "Worked for…", and the live row follows it as
// the last line, where the working row would be while a turn runs.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import ChatView from "../components/chat/ChatView";
import type { ChatActivity, ChatLive, ChatSource, ChatTurn } from "../components/chat/chat-model";
import { setLanguage } from "../i18n";
import { words } from "./screens-fixtures";

afterEach(() => setLanguage("en"));

const AT = new Date(2026, 10, 26, 10, 0, 0).getTime();
const TURNS: ChatTurn[] = [
  { kind: "user", text: "look into the flaky tests", at: AT - 582_000 },
  { kind: "agent", type: "Explore", description: "Find the flaky tests", background: true, at: AT - 580_000 },
  { kind: "assistant", text: "Two agents are on it; I'll report back.", at: AT },
];
const view = (o: { activity?: ChatActivity; live?: ChatLive } = {}) =>
  renderToStaticMarkup(createElement(ChatView, { source: { state: "ready", turns: TURNS } satisfies ChatSource, session: "s", ...o }));
const LIVE: ChatLive = { agents: [{ id: "s::ag1", label: "Explore", since: AT - 580_000 }, { id: "s::ag2", label: "Explore", since: AT - 579_000 }] };

describe("Chat while background agents run after the turn", () => {
  it("keeps the turn's Worked for, and says what still runs after it", () => {
    const markup = view({ live: LIVE });
    expect(words(markup)).toContain("Worked for 9m 42s");
    expect(markup.indexOf("chat-turn-foot")).toBeLessThan(markup.indexOf('class="chat-live"'));
    expect(words(markup)).toContain("Waiting for 2 background agents");
  });

  it("draws nothing extra for an ordinary finished turn", () => {
    const markup = view();
    expect(words(markup)).toContain("Worked for 9m 42s");
    expect(markup).not.toContain("chat-live");
  });

  it("says a compaction the same way, the turn's time kept", () => {
    const markup = view({ live: { compacting: { since: AT } } });
    expect(words(markup)).toContain("Worked for 9m 42s");
    expect(words(markup)).toContain("Compacting conversation…");
  });

  it("is the working row's place while a turn runs, which hides that turn's time as before", () => {
    const markup = view({ activity: { state: "working" } });
    expect(words(markup)).not.toContain("Worked for");
    expect(markup).not.toContain("chat-live");
  });
});
