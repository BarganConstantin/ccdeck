// How the Feedback button's dot learns about a reply (feedback conversations,
// design 4.3 and 4.5): every status frame's answer carries the account's
// summary, `{ unread, latestAt, mail }`, and the service keeps it in its view —
// in memory only, null before the first frame and whenever not connected — and
// says so on the event stream only when it changed. A summary that is not one
// changes nothing. Reading a thread answers the summary after it, so the dot
// clears at once rather than a frame later.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeClock, manualTimers, settle, tempDir, until } from "./account-test-kit";
import { fixture, startFakeApi, type FakeApi } from "./account-fake-api";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountService } from "../../server/account-service.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createTokenStore } from "../../server/account-token-store.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { feedbackSummary, FEEDBACK_UNREAD_MAX } from "../../server/account-status.mjs";

const DECK = { version: "3.49.1", os: "linux", arch: "x64", channel: "npm" };
const ACCOUNT = "0199e1c0-0d5b-7d02-8a51-3f6e2c9b1a77";
const clock = fakeClock(Date.parse("2026-10-28T09:00:00Z"));
let api: FakeApi | null = null;
let dir = "";
afterEach(async () => {
  await api?.close();
  api = null;
  if (dir) rmTempDir(dir);
  dir = "";
});

async function connected() {
  api = await startFakeApi({ now: clock.now });
  dir = tempDir("ccdeck-feedback-control-");
  const home = join(dir, "deck");
  const timers = manualTimers();
  const views: any[] = [];
  const s = createAccountService({
    env: { CCDECK_ACCOUNT_API: api.url }, home, prefs: () => ({}),
    tokenStore: createTokenStore({ platform: "linux", env: {}, home, which: () => false }),
    facts: DECK, now: clock.now, random: () => 0.5, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    broadcast: (v: unknown) => views.push(v), log: () => {},
  });
  await s.start();
  const v = await s.connect("laptop-a");
  api.approve(v.connect.userCode, ACCOUNT);
  clock.advance(5_000);
  await timers.fire({ until: () => s.view().state === "connected" });
  await until(() => s.view().state === "connected" && s.publisher() != null && existsSync(join(home, "account.json")), 3_000, "connected");
  await settle(30);
  /** Send the next status frame now and wait for its answer to be handled. */
  const frame = async () => {
    const before = api!.requests.filter(r => r.path === "/v1/device/status").length;
    await s.publisher().tickNow();
    await until(() => api!.requests.filter(r => r.path === "/v1/device/status").length > before, 3_000, "a frame");
    await settle(10);
  };
  return { s, timers, views, frame, api };
}

const feedbackViews = (views: any[]) => views.map(v => v.feedback);

describe("the frame answer's feedback summary", () => {
  it("is null before the first frame, and the API's summary after it", async () => {
    const { s, frame } = await connected();
    expect(s.view().feedback).toBeNull();
    await frame();
    expect(s.view().feedback).toEqual({ unread: 0, latestAt: null, mail: true });
  });

  it("lights up with a reply from the team, and says when it was written", async () => {
    const { s, frame, api } = await connected();
    await frame();
    const t = await s.feedbackCreate({ fields: { kind: "bug", title: "The panel is empty", body: "It was fine yesterday." } });
    expect(t.ok).toBe(true);
    clock.advance(60_000);
    const reply = api.feedback.teamReply(t.body.thread.id, "Thanks, we can see it.");
    await frame();
    expect(s.view().feedback).toEqual({ unread: 1, latestAt: reply.at, mail: true });
  });

  it("is said on the event stream only when it changed", async () => {
    const { s, views } = await connected();
    const said = () => feedbackViews(views).length;
    const before = said();
    s.noteFeedback({ unread: 1, latestAt: "2026-10-28T09:12:00Z" });
    await settle(5);
    expect(said()).toBe(before + 1);
    expect(views.at(-1).feedback).toEqual({ unread: 1, latestAt: "2026-10-28T09:12:00Z", mail: true });
    s.noteFeedback({ unread: 1, latestAt: "2026-10-28T09:12:00Z" });
    await settle(5);
    expect(said(), "the same summary again is not news").toBe(before + 1);
    s.noteFeedback({ unread: 1, latestAt: "2026-10-28T09:30:00Z" });
    await settle(5);
    expect(said(), "a newer reply in the same conversation is").toBe(before + 2);
    s.noteFeedback({ unread: 1, latestAt: "2026-10-28T09:30:00Z", mail: false });
    await settle(5);
    expect(said(), "replies no longer mailed is").toBe(before + 3);
    expect(views.at(-1).feedback.mail).toBe(false);
  });

  it("says whether replies are mailed, as the API's answer does", async () => {
    const { s, frame, api } = await connected();
    await frame();
    expect(s.view().feedback.mail).toBe(true);
    api.feedback.setMail(false);
    await frame();
    expect(s.view().feedback).toEqual({ unread: 0, latestAt: null, mail: false });
    api.feedback.setMail(true);
    await frame();
    expect(s.view().feedback.mail).toBe(true);
  });

  it("ignores a summary that is not one, and keeps the last good one", async () => {
    const { s, frame, api } = await connected();
    s.noteFeedback({ unread: 2, latestAt: "2026-10-28T09:12:00Z" });
    for (const bad of [
      { unread: -1, latestAt: null }, { unread: "2", latestAt: null }, { unread: 1.5, latestAt: null },
      { unread: FEEDBACK_UNREAD_MAX + 1, latestAt: null }, { unread: 1, latestAt: "yesterday" }, { unread: 1 },
      { unread: 1, latestAt: null, mail: "no" }, { unread: 1, latestAt: null, mail: null }, { unread: 1, latestAt: null, mail: 0 },
      [1, null], "1", 7,
    ]) {
      api.override("/v1/device/status", () => ({ status: 200, body: { ...fixture("status-response.json"), feedback: bad }, headers: { "content-type": "application/json" } }));
      await frame();
      expect(s.view().feedback, JSON.stringify(bad)).toEqual({ unread: 2, latestAt: "2026-10-28T09:12:00Z", mail: true });
    }
    // An API from before conversations sends none: no summary, no dot.
    const { feedback: _gone, ...older } = fixture("status-response.json");
    api.override("/v1/device/status", () => ({ status: 200, body: older, headers: { "content-type": "application/json" } }));
    await frame();
    expect(s.view().feedback).toBeNull();
    api.override("/v1/device/status", null);
  });

  it("takes only the three fields, whatever else a summary holds", () => {
    expect(feedbackSummary({ unread: 3, latestAt: "2026-10-28T09:12:00Z", email: "x@example.com" }))
      .toEqual({ unread: 3, latestAt: "2026-10-28T09:12:00Z", mail: true });
    // An API from before `mail` mailed every reply.
    expect(feedbackSummary({ unread: 3, latestAt: null })).toEqual({ unread: 3, latestAt: null, mail: true });
    expect(feedbackSummary({ unread: 3, latestAt: null, mail: false })).toEqual({ unread: 3, latestAt: null, mail: false });
    expect(feedbackSummary(fixture("status-response.no-mail.json").feedback)).toEqual(fixture("status-response.no-mail.json").feedback);
    expect(feedbackSummary(fixture("feedback-read.response.json"))).toEqual(fixture("feedback-read.response.json"));
    expect(feedbackSummary(fixture("status-response.json").feedback)).toEqual(fixture("status-response.json").feedback);
    expect(feedbackSummary(null)).toBeNull();
  });

  it("is gone once the deck is not connected", async () => {
    const { s, frame } = await connected();
    await frame();
    expect(s.view().feedback).not.toBeNull();
    await s.disconnect();
    expect(s.view().feedback).toBeNull();
  });
});

describe("reading a conversation", () => {
  it("clears the dot at once, from the read's own answer", async () => {
    const { s, frame, api, views } = await connected();
    const t = await s.feedbackCreate({ fields: { kind: "idea", title: "Pin a session", body: "Pin a session to the top." } });
    const id = t.body.thread.id;
    clock.advance(60_000);
    const reply = api.feedback.teamReply(id, "Good idea.");
    await frame();
    expect(s.view().feedback).toEqual({ unread: 1, latestAt: reply.at, mail: true });
    const said = views.length;
    const read = await s.feedbackRead(id, reply.seq);
    expect(read).toMatchObject({ ok: true, body: { unread: 0, latestAt: reply.at } });
    expect(s.view().feedback, "no frame in between").toEqual({ unread: 0, latestAt: reply.at, mail: true });
    await settle(5);
    expect(views.length).toBe(said + 1);
    expect(views.at(-1).feedback.unread).toBe(0);
  });

  it("only moves forward, and never past the last item", async () => {
    const { s, api } = await connected();
    const t = await s.feedbackCreate({ fields: { kind: "bug", title: "It stops", body: "It stops." } });
    const id = t.body.thread.id;
    api.feedback.teamReply(id, "One.");
    api.feedback.teamReply(id, "Two.");
    await s.feedbackRead(id, 99);
    expect(api.feedback.thread(id).readSeq).toBe(2);
    await s.feedbackRead(id, 1);
    expect(api.feedback.thread(id).readSeq).toBe(2);
  });
});
