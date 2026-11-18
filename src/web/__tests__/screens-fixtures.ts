// Stand-in data for the Chat and Decision screens. It lives here and nowhere in
// src/: the screens render what props give them, and the deck gives them none.
// The texts are the frames' own, so a test can hold the markup to them word for
// word.
import type { ChatSource } from "../components/chat/chat-model";
import type { DecisionModel } from "../components/decision/decision-model";

export const PERMISSION: DecisionModel = {
  kind: "permission",
  title: "Allow this command?",
  command: "npm test -- rate-limit",
  caption: "Run the rate limiter's tests · Bash in ~/work/web-api",
  options: [
    { label: "Yes, run it", sub: "Runs once. The next command asks again." },
    { label: "Yes, and don't ask again for npm test here", sub: "", locked: true, lockNote: "Changes the session's rules, so only in the terminal" },
    { label: "No, tell Claude what to do instead", sub: "The command doesn't run", free: true },
  ],
  origin: "launched",
  session: "web-api",
};

export const MULTI: DecisionModel = {
  kind: "question",
  title: "Which docs move to the new theme first?",
  caption: "Pick any. Claude moves those first and asks before the rest.",
  options: [
    { label: "Getting started", sub: "Six pages new readers see first" },
    { label: "API reference", sub: "Fourteen pages built from the schema" },
    { label: "Blog", sub: "Forty posts that read fine as they are" },
  ],
  multi: true,
  origin: "launched",
  session: "web-api",
};

export const OUTSIDE: DecisionModel = {
  ...PERMISSION,
  command: "./gradlew publishRelease",
  caption: "Publish the release build · Bash in ~/work/mobile-app",
  options: [
    PERMISSION.options[0],
    { ...PERMISSION.options[1], label: "Yes, and don't ask again for ./gradlew here" },
    PERMISSION.options[2],
  ],
  origin: "outside",
  session: "mobile-app",
};

export const PLAN: DecisionModel = {
  kind: "plan",
  title: "Approve this plan?",
  plan: ["A token bucket on the public routes", "Limits read from config/rate.json", "Tests for burst and refill"],
  caption: "3 steps · plan mode in ~/work/web-api",
  options: [
    { label: "Yes, and auto-accept edits", sub: "", locked: true, lockNote: "Changes the session’s mode, so only in the terminal" },
    { label: "Yes, and I approve each edit", sub: "Claude starts; every edit still asks you" },
    { label: "No, keep planning", sub: "Tell Claude what to change" },
  ],
  origin: "launched",
  session: "web-api",
};

export const TRANSCRIPT: ChatSource = {
  state: "ready",
  since: { toolCalls: 4, label: "now asking" },
  turns: [
    { kind: "user", text: "Add rate limiting to the public API" },
    { kind: "assistant", text: "I'll put a token-bucket limiter in front of the public routes and keep the internal ones unlimited. Starting with how the routes are mounted." },
    { kind: "tool", name: "Read", arg: "src/server/routes.ts", note: "182 lines" },
    { kind: "tool", name: "Explore", arg: "Find every public route", note: "18s · 4 calls" },
    { kind: "tool", name: "Write", arg: "middleware/rate-limit.ts", note: "+64" },
    { kind: "tool", name: "Edit", arg: "src/server/routes.ts", note: "+4 −1" },
    { kind: "assistant", text: "Now the limiter's tests." },
    { kind: "record", text: "You answered  1 · Yes, run it  ·  6m 42s after it asked" },
    { kind: "tool", name: "Bash", arg: "npm test -- rate-limit", note: "running", running: true },
  ],
};

/** Markup as the words a reader gets: tags gone, entities decoded, spaces kept. */
export function words(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, "\u0001")
    .replace(/\u0001+/g, " ")
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ");
}
