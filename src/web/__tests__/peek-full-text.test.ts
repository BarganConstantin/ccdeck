// A hover card's cut lines carry their whole text.
//
// The canvas card's hover card says what a waiting session is waiting for on
// one line, beside how long it has waited, and cuts the line with an ellipsis at
// the card's width. Measured on a board zoomed out with keyboard focus on a
// waiting card, "Claude needs your permission to use Bash" lost its last word
// and the line had no tooltip; a question a session asks is longer still. The
// card's name and the session's title are cut the same way (one line, two
// lines), and so are the names in the two other hover cards the deck draws:
// Local network's machines and the account fold's accounts. Each of them now
// carries its whole text in a `title`, the way a card's own name and second
// row already do.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetRules } from "./sheet-cascade";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const peek = read("../components/SessionPeek.tsx");
const lan = read("../components/LanPeek.tsx");
const fold = read("../components/OtherAccounts.tsx");

/** The classes a hover card is drawn with: the shared card and its parts, the
 *  canvas card's, the recap note's and the account fold's. */
const HOVER_CARD = /\.(?:ap-peek|node-peek|recap-peek|ap-fold)\b/;
const cuts = (body: string) => /text-overflow:\s*ellipsis/.test(body) || /-webkit-line-clamp:\s*[1-9]/.test(body);

/** Every selector in the hover cards' rules that cuts its text. */
function cutSelectors(): string[] {
  return sheetRules()
    .filter(r => cuts(r.body))
    .flatMap(r => r.selectors.filter(s => HOVER_CARD.test(s)));
}

describe("the hover cards' cut lines", () => {
  it("are exactly these, so a new one has to say where its whole text is", () => {
    expect([...new Set(cutSelectors())].sort()).toEqual([
      ".ap-fold-name",
      ".ap-peek-who > span",
      ".node-peek-name",
      ".node-peek-title",
      ".node-peek-wait > span",
    ]);
  });

  it("carry their whole text on the canvas card's hover card", () => {
    expect(peek).toContain('<span className="node-peek-name" title={a.label}>{a.label}</span>');
    expect(peek).toContain('<p className="node-peek-title" title={naming.face}>{naming.face}</p>');
    expect(peek).toContain("<span title={waitingLabel(a.waiting)}>{waitingLabel(a.waiting)}</span>");
  });

  it("carry their whole text on Local network's card, with the route the line draws", () => {
    // `.ap-peek-who > span` is the name, and " · Tailscale" after it when the
    // machine is reached that way.
    expect(lan).toContain('<span title={r.via === "tailscale" ? `${r.name} · Tailscale` : r.name}>');
    expect(lan).toContain('{r.name}{r.via === "tailscale" && <span className="ap-lan-via"> · Tailscale</span>}');
  });

  it("carry their whole text on the account fold's card", () => {
    expect(fold).toContain('<span className="ap-fold-name" title={p.name}>{p.name}</span>');
    // The number beside it matches `.ap-peek-who > span` too and is never cut:
    // it keeps its own width, and the name gives way.
    const state = sheetRules().filter(r => r.media == null && r.selectors.includes(".ap-fold-state")).map(r => r.body).join("\n");
    expect(state).toMatch(/flex:\s*none;/);
  });
});
