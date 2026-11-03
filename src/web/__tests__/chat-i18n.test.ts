// Chat's own words in another language (board.chat.*): its loading line, region
// name, Retry and the divider's plural forms come from the catalog.
//
// Drawn under the suite's stand-in React (fake-react.ts) because a render to a
// string has no language to follow: it always draws the default.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLanguageForTest, setLanguage } from "../i18n";
import ChatView from "../components/chat/ChatView";
import { sinceText } from "../components/chat/ChatTurn";
import type { ChatSource } from "../components/chat/chat-model";
import { all, mount, textOf } from "./fake-react";

vi.mock("react", async () => (await import("./fake-react")).react);

beforeEach(() => resetLanguageForTest());
afterEach(() => setLanguage("en"));

const draw = (source: ChatSource) => mount(ChatView, { source }).tree;
const region = (tree: unknown) => all(tree, el => el.props.role === "region")[0];

describe("Chat in another language", () => {
  it("draws its region name, loading line, error and Retry from the catalog", () => {
    setLanguage("de");
    const loading = draw({ state: "loading" });
    expect(region(loading).props["aria-label"]).toBe("Unterhaltung");
    expect(all(loading, el => typeof el.props.label === "string")[0].props.label).toBe("Unterhaltung wird gelesen");
    const error = draw({ state: "error", message: "x", onRetry() {} });
    expect(textOf(all(error, el => el.props.className === "chat-retry")[0])).toBe("Erneut versuchen");
  });

  it("draws the same in English by default", () => {
    const loading = draw({ state: "loading" });
    expect(region(loading).props["aria-label"]).toBe("Conversation");
    expect(all(loading, el => typeof el.props.label === "string")[0].props.label).toBe("Reading the conversation");
  });

  it("counts the tool calls in the language's own plural forms", () => {
    setLanguage("ro");
    expect(sinceText({ toolCalls: 1, label: "acum" })).toBe("De la ultima ta privire · 1 apel de unealtă · acum");
    expect(sinceText({ toolCalls: 3, label: "acum" })).toBe("De la ultima ta privire · 3 apeluri de unelte · acum");
    expect(sinceText({ toolCalls: 20, label: "acum" })).toBe("De la ultima ta privire · 20 de apeluri de unelte · acum");
    setLanguage("en");
    expect(sinceText({ toolCalls: 1, label: "now asking" })).toBe("Since you looked · 1 tool call · now asking");
    expect(sinceText({ toolCalls: 4, label: "now asking" })).toBe("Since you looked · 4 tool calls · now asking");
  });
});
