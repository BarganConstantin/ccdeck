import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const strip = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");

describe("the deck announces state that is already visible (#1016)", () => {
  it("makes the session roster a list and exposes the current session", () => {
    const list = strip(read("../components/SessionList.tsx"));
    expect(list).toContain('<ul className="sl-rows">');
    expect(list).toContain('<li key={r.sessionId} className="sl-row-item">');
    expect(list).toContain('aria-current={isSelected ? "true" : undefined}');
    expect(list).toContain('</li>');
  });

  it("announces Browser Watch findings from an always-mounted polite region", () => {
    // The sentence and its reducer moved to use-live-announcements.ts; the region
    // is mounted in the topbar's readout group (components/TopbarReadouts.tsx),
    // which App.tsx mounts and hands the announcements whole. All matches are
    // positive.
    const app = strip(read("../App.tsx") + "\n" + read("../use-live-announcements.ts")
      + "\n" + read("../components/TopbarReadouts.tsx"));
    expect(app).toMatch(/const watchNow = watchUnseen > 0[\s\S]*?Browser watch has/);
    expect(app).toContain('nextAnnouncement(said, watchNow, "Browser watch has no unread findings.")');
    expect(app).toContain('<div className="vis-hidden" role="status" aria-atomic="true">{watchSaid}</div>');
    expect(strip(read("../App.tsx"))).toMatch(/<ReadoutGroup\b[^>]*\bannouncements=\{announcements\}/);
  });

  it("does not announce an all-clear the reader caused by reading Browser Watch", () => {
    // Closing the dialog stamps every finding seen, which takes the count to
    // nothing — and the reducer would then say "no unread findings" about the
    // list the reader had just finished. Reading it puts the region back to the
    // silence it starts in; a clear from anywhere else still speaks.
    // The dialog is mounted in components/DeckDialogs.tsx, which App.tsx hands
    // the announcements whole; the count reads both files.
    const app = strip(read("../App.tsx"));
    const dialogs = strip(read("../components/DeckDialogs.tsx"));
    expect(app).toMatch(/<DeckDialogs\b[^>]*\bannouncements=\{announcements\}/);
    expect(dialogs).toMatch(/const \{ setWatchSaid \} = announcements;/);
    // `markWatchSeen` is the seen stamp and its write-through, named in the badge
    // hook; the ORDER is what this pins — the region goes quiet first.
    expect(dialogs).toMatch(/onSeen=\{ms => \{\s*setWatchSaid\(""\);\s*markWatchSeen\(ms\);/);
    expect((app + "\n" + dialogs).match(/setWatchSaid\(""\)/g)).toHaveLength(1);
  });

  it("puts the context number in the button name and hides the decorative svg", () => {
    const context = strip(read("../components/ContextModal.tsx"));
    expect(context).toContain('aria-label={`Context ${Math.round(pct * 100)}% of ${window.toLocaleString()} tokens — show breakdown`}');
    expect(context).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("names the context window's progressbar", () => {
    // 4.1.2: a progressbar needs a name of its own; the percentage beside it
    // is a sibling, not a label.
    const modal = strip(read("../components/ContextModal.tsx"));
    expect(modal).toMatch(/role="progressbar" aria-label="Context window used"/);
  });

  it("resets native list chrome without changing row width", () => {
    const css = strip(read("../styles.css"));
    expect(css).toMatch(/\.session-list \.sl-rows\s*\{[\s\S]*?margin:\s*0;[\s\S]*?list-style:\s*none;/);
    expect(css).toMatch(/\.session-list \.sl-row-item > \.sl-row\s*\{[\s\S]*?width:\s*100%;/);
  });
});
