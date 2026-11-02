// "Last news" on the phone's offline card: the moment the link dropped, when it
// had been open, in the deck's language, with the day when it is not today.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lastNewsTime, unreachableSub, UNREACHABLE_SUB } from "../components/ConnectionBanner";
import { NEVER_OPEN, linkDropped, linkOpened } from "../last-news";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

describe("the link's memory", () => {
  it("a link open and quiet since noon, dropped at two, reads two", () => {
    const noon = new Date(2026, 10, 2, 12, 0).getTime();
    const two = new Date(2026, 10, 2, 14, 0).getTime();
    const open = linkOpened(NEVER_OPEN);
    expect(open.open).toBe(true);
    expect(linkDropped(open, two).droppedAt).toBe(two);
    expect(linkDropped(open, two).droppedAt).not.toBe(noon);
  });

  it("a link already down keeps the earlier time through the browser's repeated errors", () => {
    const first = linkDropped(linkOpened(NEVER_OPEN), 1000);
    const again = linkDropped(first, 5000);
    expect(again.droppedAt).toBe(1000);
    expect(linkDropped(again, 9000).droppedAt).toBe(1000);
  });

  it("a link that never opened has no last news", () => {
    expect(linkDropped(NEVER_OPEN, 1000).droppedAt).toBeNull();
    expect(unreachableSub(null)).toBe(UNREACHABLE_SUB);
  });

  it("opening again keeps the old time until the next drop, which replaces it", () => {
    const down = linkDropped(linkOpened(NEVER_OPEN), 1000);
    const up = linkOpened(down);
    expect(up.droppedAt).toBe(1000);
    expect(linkDropped(up, 7000).droppedAt).toBe(7000);
    expect(linkOpened(up)).toBe(up);
  });

  it("no event is compared with this phone's clock any more", () => {
    const stream = read("use-event-stream.ts");
    expect(stream).not.toContain("heardRef");
    expect(stream).toContain("linkRef.current = linkOpened(linkRef.current);");
  });
});

describe("the time on the card", () => {
  const at = new Date(2026, 10, 2, 14, 2).getTime();

  it("is the clock time alone when it is today", () => {
    expect(lastNewsTime(at, new Date(2026, 10, 2, 23, 59).getTime())).toBe("14:02");
  });

  it("carries the day when it is not today, a tab left open overnight", () => {
    const next = new Date(2026, 10, 3, 8, 0).getTime();
    const out = lastNewsTime(at, next);
    expect(out).toMatch(/14:02$/);
    expect(out.length).toBeGreaterThan("14:02".length);
    expect(out).toMatch(/2/);
    expect(unreachableSub(at, next)).toContain(`Last news ${out}`);
  });

  it("is formatted with the deck's chosen language, not the browser's", () => {
    const banner = read("components/ConnectionBanner.tsx");
    expect(banner).toContain("const language = currentLanguage();");
    expect(banner).toContain("toLocaleTimeString(language,");
    expect(banner).not.toContain("toLocaleTimeString(undefined");
  });
});
