// A conversation, laid out (feedback-conversations.ts): runs of messages by
// side, a signature once over a team run, event lines from the API's own text,
// day dividers on a fixed clock and time zone; links found the way the API
// finds them, held to the shared fixture both repositories test against; and
// titles held to the other shared fixture, whose expected values the API
// generated from this deck's own feedbackTitle.
import { describe, expect, it } from "vitest";
import { fixture } from "./account-fake-api";
import { feedbackTitle, limitLine as fromWrite, type Kind } from "../feedback";
import {
  dayLabel, highestSeq, imagesOnWeb, limitLine, linkify, listTime, mergeItems, parseReplyCreated, parseThreadList,
  parseThreadView, previewLine, startedLine, statusTone, timeLabel, timeline, RUN_GAP_MS, type ThreadItem,
} from "../feedback-conversations";

const TZ = "Europe/Chisinau";
const NOW = Date.parse("2026-10-28T18:00:00Z");

describe("the shared fixtures", () => {
  it("finds every link feedback-links.json says, and nothing else", () => {
    const cases = fixture("feedback-links.json") as { text: string; parts: ({ text: string } | { url: string; text: string })[] }[];
    expect(cases.length).toBeGreaterThanOrEqual(38);
    for (const { text, parts } of cases) expect(linkify(text), JSON.stringify(text).slice(0, 80)).toEqual(parts);
  });

  it("titles a message as feedback-titles.json says, which is this deck's own rule", () => {
    const cases = fixture("feedback-titles.json") as { kind: Kind; body: string; title: string }[];
    expect(cases.length).toBeGreaterThanOrEqual(30);
    for (const { kind, body, title } of cases) expect(feedbackTitle(kind, body), JSON.stringify(body).slice(0, 80)).toBe(title);
  });

  it("reads every answer fixture whole", () => {
    const view = parseThreadView(fixture("feedback-thread.response.json"))!;
    expect(view.items.map(i => i.type)).toEqual(["message", "message", "status", "issue", "duplicate", "status", "released", "message", "reopened", "status"]);
    expect(view.items[0].images).toHaveLength(1);
    expect(view.thread.trackedIssue).toEqual({ number: 123, url: "https://github.com/BarganConstantin/ccdeck/issues/123" });
    expect(view.earlier).toBeNull();
    const list = parseThreadList(fixture("feedback-threads.response.json"))!;
    expect(list.threads).toHaveLength(2);
    expect(list).toMatchObject({ next: "CN80SaQVDgABmfKgGyx9Pp9AWmt8jZ4P", unread: 1, latestAt: "2026-10-28T09:12:00Z" });
    const reply = parseReplyCreated(fixture("feedback-reply.response.json"))!;
    expect(reply.item).toMatchObject({ seq: 4, side: "user", via: "deck" });
    expect(reply.thread.lastSeq).toBe(4);
  });

  it("drops what is not an item rather than drawing it, and keeps an unknown type", () => {
    const v = fixture("feedback-thread.response.json");
    v.items.push({ seq: 10, at: "2026-10-28T17:00:00Z", type: "poll", side: "team", text: "A new kind of event." });
    v.items.push({ seq: "11", at: "x", type: "message", side: "team", text: "no" });
    v.items.push({ seq: 12, at: "2026-10-28T17:01:00Z", type: "message", side: "admin", text: "no" });
    const view = parseThreadView(v)!;
    expect(view.items.map(i => i.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(parseThreadView({ thread: { id: "x" }, items: [] })).toBeNull();
    expect(parseThreadList({ threads: "no" })).toBeNull();
  });
});

const msg = (seq: number, at: string, side: "user" | "team", extra: Partial<ThreadItem> = {}): ThreadItem =>
  ({ seq, at, type: "message", side, text: `m${seq}`, ...extra });

describe("the timeline", () => {
  it("groups one side's messages within five minutes into a run, the time under its last", () => {
    const rows = timeline([
      msg(0, "2026-10-28T08:00:00Z", "user"),
      msg(1, "2026-10-28T08:04:59Z", "user"),
      msg(2, "2026-10-28T08:10:00Z", "user"),
      msg(3, "2026-10-28T08:11:00Z", "team", { signature: "Constantin · ccdeck team" }),
      msg(4, "2026-10-28T08:12:00Z", "team", { signature: "Constantin · ccdeck team" }),
      msg(5, "2026-10-28T08:13:00Z", "team", { signature: "ccdeck team" }),
    ], NOW, TZ);
    expect(rows.map(r => r.kind)).toEqual(["day", "run", "run", "run", "run"]);
    const runs = rows.filter(r => r.kind === "run") as Extract<(typeof rows)[number], { kind: "run" }>[];
    expect(runs.map(r => r.messages.map(m => m.seq))).toEqual([[0, 1], [2], [3, 4], [5]]);
    // The signature once over a run, and a new run where it changes.
    expect(runs.map(r => r.signature)).toEqual([null, null, "Constantin · ccdeck team", "ccdeck team"]);
    expect(runs[0].time).toBe("10:04");
    expect(RUN_GAP_MS).toBe(300_000);
  });

  it("draws every event as its own line, from the API's text, and breaks the run around it", () => {
    const view = parseThreadView(fixture("feedback-thread.response.json"))!;
    const rows = timeline(view.items, NOW, TZ);
    const events = rows.filter(r => r.kind === "event") as Extract<(typeof rows)[number], { kind: "event" }>[];
    expect(events.map(e => e.item.text)).toEqual([
      "Status changed to Looking into it.", "Tracked publicly as #123.", "Grouped with similar reports. You'll hear here when it's fixed.",
      "Fixed in 3.49.0. You'll hear here when it's out.", "What you asked for is in ccdeck 3.49.0.", "Reopened by your reply.",
      "Won't do: The system stops the network while it sleeps, and ccdeck cannot keep it awake.",
    ]);
    expect(events.every(e => e.known)).toBe(true);
    const unknown = timeline([{ seq: 0, at: "2026-10-28T08:00:00Z", type: "poll", side: "team", text: "Vote." }], NOW, TZ);
    expect(unknown[1]).toMatchObject({ kind: "event", known: false, item: { text: "Vote." } });
  });

  it("puts a day divider before each day, in the reader's time zone", () => {
    const rows = timeline([
      msg(0, "2026-10-25T22:30:00Z", "user"), // Oct 26, 00:30 in Chisinau, the day its summer time ended
      msg(1, "2026-10-27T10:00:00Z", "team", { signature: "ccdeck team" }),
      msg(2, "2026-10-28T07:00:00Z", "user"),
    ], NOW, TZ);
    expect(rows.filter(r => r.kind === "day").map(r => (r as { label: string }).label)).toEqual(["Oct 26", "Yesterday", "Today"]);
    expect(timeLabel("2026-10-25T22:30:00Z", TZ)).toBe("00:30");
    expect(dayLabel("2025-12-31T10:00:00Z", NOW, TZ)).toBe("Dec 31, 2025");
    expect(dayLabel("2026-10-28T10:00:00Z", NOW, "UTC")).toBe("Today");
  });

  it("joins an earlier page and a refetch without doubling an item", () => {
    const shown = [msg(5, "2026-10-28T08:00:00Z", "user"), msg(6, "2026-10-28T08:01:00Z", "team")];
    const merged = mergeItems(shown, [msg(3, "2026-10-28T07:00:00Z", "user"), msg(6, "2026-10-28T08:01:00Z", "team"), msg(7, "2026-10-28T09:00:00Z", "team")]);
    expect(merged.map(i => i.seq)).toEqual([3, 5, 6, 7]);
    expect(highestSeq(merged)).toBe(7);
    expect(highestSeq([])).toBe(-1);
  });
});

describe("a list row and the words", () => {
  it("previews whose the latest item is, and when", () => {
    const [team, mine] = parseThreadList(fixture("feedback-threads.response.json"))!.threads;
    expect(previewLine(team)).toBe("Thanks! We can reproduce it after a sleep of more than an hour.");
    expect(previewLine({ ...mine, preview: { side: "user", text: "Still there." } })).toBe("You: Still there.");
    expect(listTime("2026-10-28T09:12:00Z", NOW, TZ)).toBe("11:12");
    expect(listTime("2026-10-27T16:45:00Z", NOW, TZ)).toBe("Yesterday");
    expect(listTime("2026-10-20T12:30:00Z", NOW, TZ)).toBe("Oct 20");
  });

  it("tones a pill by its code, never by its words", () => {
    expect(["received", "looking", "planned", "fixed", "wont_do", "later"].map(statusTone))
      .toEqual(["open", "progress", "progress", "done", "closed", "open"]);
  });

  it("says the images, the start and a limit in plain words", () => {
    expect(imagesOnWeb(1)).toBe("1 image — view on the web");
    expect(imagesOnWeb(3)).toBe("3 images — view on the web");
    expect(startedLine("2026-10-20T08:01:00Z", "deck", NOW, TZ)).toBe("Started Oct 20 from your deck");
    expect(startedLine("2026-10-28T08:01:00Z", "web", NOW, TZ)).toBe("Started today from the web");
    const at = new Date("2026-10-28T12:05:00Z");
    expect(limitLine("conversations", 10, at, "UTC")).toBe("You've reached today's limit of 10 new conversations. You can try again at 12:05; your text is still here.");
    expect(limitLine("replies", 50, at, TZ)).toBe("You've reached today's limit of 50 replies. You can try again at 14:05; your text is still here.");
    expect(limitLine).toBe(fromWrite);
  });
});
