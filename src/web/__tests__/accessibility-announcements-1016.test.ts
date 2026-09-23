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
    const app = strip(read("../App.tsx"));
    expect(app).toMatch(/const watchNow = watchUnseen > 0[\s\S]*?Browser watch has/);
    expect(app).toContain('nextAnnouncement(said, watchNow, "Browser watch has no unread findings.")');
    expect(app).toContain('<div className="vis-hidden" role="status" aria-atomic="true">{watchSaid}</div>');
  });

  it("does not announce an all-clear the reader caused by reading Browser Watch", () => {
    // Closing the dialog stamps every finding seen, which takes the count to
    // nothing — and the reducer would then say "no unread findings" about the
    // list the reader had just finished. Reading it puts the region back to the
    // silence it starts in; a clear from anywhere else still speaks.
    const app = strip(read("../App.tsx"));
    expect(app).toMatch(/onSeen=\{ms => \{\s*setWatchSaid\(""\);\s*setWatchSeenMs\(ms\);/);
    expect(app.match(/setWatchSaid\(""\)/g)).toHaveLength(1);
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
