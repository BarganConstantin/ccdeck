// When Chat asks for the page before by itself (chat-older.ts): once the top
// is in reach, one ask per offer and none while a page is read, none after a
// failure until the host offers again, none at the start, at most OLDER_RUN in
// a row while the top stays in reach, and a new run when the top goes out of
// reach, the reader moves up or another session is shown.
import { describe, expect, it } from "vitest";
import { OLDER_RUN, olderPager, topInReach, type OlderOffer } from "../components/chat/chat-older";

const idle = (): OlderOffer => ({ loading: false, failed: false });

/** The host's offers for one page: asked, read, in. */
function readPage(p: ReturnType<typeof olderPager>, session = "a") {
  p.due({ session, older: { loading: true }, near: true });
}

describe("olderPager", () => {
  it("asks once the top is in reach, and not before", () => {
    const p = olderPager();
    const offer = idle();
    expect(p.due({ session: "a", older: offer, near: false })).toBe(false);
    expect(p.due({ session: "a", older: offer, near: true })).toBe(true);
  });

  it("asks once per offer: a burst of scroll events, and the page being read, ask nothing more", () => {
    const p = olderPager();
    const offer = idle();
    expect(p.due({ session: "a", older: offer, near: true })).toBe(true);
    for (let i = 0; i < 20; i++) expect(p.due({ session: "a", older: offer, near: true })).toBe(false);
    expect(p.due({ session: "a", older: { loading: true }, near: true })).toBe(false);
    expect(p.due({ session: "a", older: { loading: true }, near: true })).toBe(false);
    // The page is in, the top still in reach: the next one.
    expect(p.due({ session: "a", older: idle(), near: true })).toBe(true);
  });

  it("asks nothing at the start of the conversation, where nothing older is offered", () => {
    const p = olderPager();
    expect(p.due({ session: "a", near: true })).toBe(false);
    p.moved();
    expect(p.due({ session: "a", near: true })).toBe(false);
  });

  it("does not ask again after a failure; once a press has read the page, it goes on", () => {
    const p = olderPager();
    expect(p.due({ session: "a", older: idle(), near: true })).toBe(true);
    readPage(p);
    const failed = { loading: false, failed: true };
    expect(p.due({ session: "a", older: failed, near: true })).toBe(false);
    p.moved();
    expect(p.due({ session: "a", older: failed, near: true })).toBe(false);
    // Retry pressed: the host reads it, and offers the page before that one.
    readPage(p);
    expect(p.due({ session: "a", older: idle(), near: true })).toBe(true);
  });

  it(`asks at most ${OLDER_RUN} pages in a row while the top stays in reach`, () => {
    const p = olderPager();
    for (let i = 0; i < OLDER_RUN; i++) {
      expect(p.due({ session: "a", older: idle(), near: true })).toBe(true);
      readPage(p);
    }
    expect(p.due({ session: "a", older: idle(), near: true })).toBe(false);
    expect(p.due({ session: "a", older: idle(), near: true })).toBe(false);
  });

  it("starts a new run when the reader moves up on their own", () => {
    const p = olderPager(2);
    for (let i = 0; i < 2; i++) { expect(p.due({ session: "a", older: idle(), near: true })).toBe(true); readPage(p); }
    const offer = idle();
    expect(p.due({ session: "a", older: offer, near: true })).toBe(false);
    p.moved();
    expect(p.due({ session: "a", older: offer, near: true })).toBe(true);
  });

  it("starts a new run once the top goes out of reach: the conversation scrolls", () => {
    const p = olderPager(2);
    for (let i = 0; i < 2; i++) { expect(p.due({ session: "a", older: idle(), near: true })).toBe(true); readPage(p); }
    const offer = idle();
    expect(p.due({ session: "a", older: offer, near: true })).toBe(false);
    expect(p.due({ session: "a", older: offer, near: false })).toBe(false);
    expect(p.due({ session: "a", older: offer, near: true })).toBe(true);
  });

  it("starts anew for another session: neither its run nor an ask in flight carries over", () => {
    const p = olderPager(1);
    const offer = idle();
    expect(p.due({ session: "a", older: offer, near: true })).toBe(true);
    expect(p.due({ session: "a", older: idle(), near: true })).toBe(false);
    expect(p.due({ session: "b", older: offer, near: true })).toBe(true);
  });
});

describe("topInReach", () => {
  it("is the top within a view's height of what shows", () => {
    expect(topInReach({ scrollTop: 0, clientHeight: 400 })).toBe(true);
    expect(topInReach({ scrollTop: 400, clientHeight: 400 })).toBe(true);
    expect(topInReach({ scrollTop: 401, clientHeight: 400 })).toBe(false);
  });
});
