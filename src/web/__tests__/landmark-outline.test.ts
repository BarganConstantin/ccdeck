// #381: five regions, one landmark, no <h1>, and five aria-labels the
// accessibility tree was throwing on the floor.
//
// Measured on the shipped bundle, the deck answered a landmark query with one
// entry — HEADER.topbar — for an application that has a toolbar, a canvas and
// three panels. Everything else was a <div>. A screen-reader user could not
// jump to the canvas, could not jump to a panel, and could not tell one panel
// from another once they got there; the only route between them was Tab,
// through roughly a hundred and sixty-six stops.
//
// The heading outline was the same story one level down. There was no <h1> at
// all, so the document's first heading was the usage panel's <h3>Usage</h3> and
// every level under it was a skip. The only <h2> in the app was the detail
// panel's hero title, which appears when an agent is selected and not before.
//
// And the third finding, which is the one worth stating precisely because it
// looks like a non-bug in the source: `aria-label` on an element whose role
// resolves to `generic` — a <div> or a <span> with no role attribute — is
// DROPPED. It is not weakened, not a fallback; the name is discarded and the
// element stays anonymous. `.usage-panel` and `.accounts-panel` had carried one
// since they were written and neither had ever produced a name. #373 saw the
// shape and correctly called it a naming defect rather than a state one, which
// is how it arrived here.
//
// The issue counted two. A sweep of every aria-label in the bundle — the last
// test in the first block below, which is the part of this file that will
// still be doing work in a year — found five: the two panel roots and the
// three copies of the cost bar.
//
// Plain node, no DOM, so this reads the components as text the way
// manage-block.test.ts and toggle-state.test.ts do. Comments are stripped
// before any "appears nowhere" assertion, because this repo's comments quote
// the markup they replaced and a search for a retired shape would otherwise
// find the sentence explaining why it is retired.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { versionNoticeLabel } from "../version-chip";
import { openTags, withoutComments } from "./tsx-scan";

const web = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(web, "styles.css"), "utf8");

/** Every .tsx that ends up in the bundle. The suite's own files are not markup. */
function components(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : components(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

const FILES = components(web);
const source = (name: string) => readFileSync(FILES.find(p => p.endsWith(name))!, "utf8");

/** The same text with its comments gone — the only form an "appears nowhere"
 *  assertion may read. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
}

const app = source("App.tsx");
const usage = source("UsagePanel.tsx");
const accounts = source("AccountsPanel.tsx");
const sessions = source("SessionList.tsx");
const history = source("UsageHistoryModal.tsx");
const summary = source("SessionSummary.tsx");
// The stacked cost bar, which was written out in three of the files above until
// #374 gave it a file of its own.
const costBar = source("CostBar.tsx");

/** Every file in the bundle, as [name, comment-stripped text]. The separator is
 *  normalised because two of the assertions below name a file inside
 *  components/, and join() spells that with a backslash on Windows. */
const BUNDLE: Array<[string, string]> = FILES.map(p =>
  [p.slice(web.length).replace(/\\/g, "/"), code(readFileSync(p, "utf8"))]);

/**
 * Every file in the bundle again, comment-free the way `./tsx-scan` means it —
 * the form the two tag sweeps below read.
 *
 * `code` above drops a whole line that begins with `//` and every `/* *\/`
 * block, which is enough for the "appears nowhere" assertions it was written
 * for. It is not enough for a scanner: a comment written after code on the same
 * line survives it, and #513 is the whole story of what a stray apostrophe in
 * one of those does to a tag scan. `withoutComments` is quote-aware and takes
 * both kinds, and it is what `openTags` runs on internally — so passing it in
 * first also makes each tag's `end` an index into a string this file holds.
 */
const BARE: Array<[string, string]> = FILES.map(p =>
  [p.slice(web.length).replace(/\\/g, "/"), withoutComments(readFileSync(p, "utf8"))]);

// ── how the two tag sweeps read markup (#655) ───────────────────────────────
//
// They used to share an anchored regex — `<(tag)((?:[^<>]|\{[^{}]*\})*?)\/?>` —
// and the `[^<>]` in it is the defect: it refuses a `>` anywhere in an
// attribute, so the FIRST `>` inside a brace ends the tag. `\{[^{}]*\}` covers
// one flat braced value, which is why `{cond ? "a" : "b"}` worked and gave the
// pattern its reputation, but an arrow function nests — `onClick={() => f({…})}`
// — and that alternative cannot match a brace pair with a brace pair inside it.
// The scan falls back to `[^<>]`, meets the `>` of the `=>`, and stops there.
//
// Measured on the bundle: of 68 `<button` openings the paired form of that
// pattern matched 43, and 79 tags of all kinds came back with their attributes
// cut short at an arrow. Both are silent — a sweep over the survivors reports
// green, and a truncated attribute list simply does not contain the attribute
// being looked for.
//
// So both sweeps take their tags from `openTags` now, rather than from a third
// tokenizer written here: it counts braces, tracks quotes, and says when a scan
// ran off the end instead of handing back something that looks like a short
// tag. That is the same scanner control-edges.test.ts and
// control-appearance.test.ts read the app's controls with.

/** The HTML elements whose implicit role is `generic`, which is the role that
 *  cannot be named. Not a complete list of such elements — a complete list is
 *  not the point — but every one of them this deck actually renders. */
const GENERIC = [
  "div", "span", "p", "b", "i", "strong", "em", "small", "code", "pre",
  "li", "ul", "ol", "table", "tr", "td", "th", "tbody", "thead",
];

// ── the regions ─────────────────────────────────────────────────────────────

describe("the deck's five regions are five landmarks (#381)", () => {
  it("puts the canvas in the one <main> a document is allowed", () => {
    expect(code(app)).toMatch(/<main\n\s+id="canvas"\n\s+tabIndex=\{-1\}\n\s+className=\{`canvas-wrap/);
    const mains = BUNDLE.flatMap(([name, src]) =>
      [...src.matchAll(/<main[\s>]/g)].map(() => name));
    expect(mains).toEqual(["App.tsx"]);
    // The shape it replaced, gone rather than merely outnumbered.
    expect(code(app)).not.toMatch(/<div\s*\n?\s*className=\{`canvas-wrap/);
  });

  it("keeps the topbar the banner it already was", () => {
    // A <header> that is not inside an article or a section IS the banner
    // landmark, with no role attribute needed. This one is a direct child of
    // .app, which is a plain grid <div>, so it always has been.
    expect(code(app)).toMatch(/<header className="topbar">/);
  });

  it("makes every panel an <aside>, and every <aside> carry its own name", () => {
    // complementary is what all four of these are: content beside the canvas
    // that can be closed without changing what the canvas shows. The name is
    // what makes the rotor's four entries tellable apart — "complementary,
    // complementary, complementary" is a list nobody can navigate.
    const named: Array<[string, string, string]> = [
      ["UsagePanel.tsx", "usage-panel", "Usage"],
      ["AccountsPanel.tsx", "accounts-panel", "Claude accounts"],
      ["SessionList.tsx", "session-list", "Sessions"],
    ];
    for (const [file, cls, label] of named) {
      expect(code(source(file)), file)
        .toMatch(new RegExp(`<aside className="${cls}" id="${cls}" aria-label="${label}">`));
    }
    // The detail panel was already an <aside> and was the unnamed one.
    expect(code(app)).toMatch(/<aside className="detail" aria-label="Detail">/);
  });

  it("has no <div> left wearing one of those class names", () => {
    // The exact two shapes the issue measured, which is the assertion that
    // fails if somebody re-opens one of these files and reaches for a <div>.
    expect(code(usage)).not.toMatch(/<div className="usage-panel"/);
    expect(code(accounts)).not.toMatch(/<div className="accounts-panel"/);
  });

  it("invents no landmark for a region the deck does not have", () => {
    // The failure mode on the other side of this issue: a rotor padded out
    // with regions nobody would ever navigate to is no more usable than an
    // empty one. There is no navigation on this deck — the session list moves
    // the camera, it does not move the user between documents — and the filter
    // box is a single input the rotor already lists by its own aria-label.
    for (const [name, src] of BUNDLE) {
      expect(src, name).not.toMatch(/<nav[\s>]/);
      expect(src, name).not.toMatch(/role="(navigation|search|banner|main|complementary|contentinfo)"/);
    }
  });

  it("leaves no aria-label on an element whose role is generic", () => {
    // The sweep, and the general form of the issue's third finding. A name on
    // a roleless <div> or <span> is not a weak name, it is no name: the
    // accessibility tree drops it. Five of these shipped — the two panel roots
    // and the three copies of the cost bar — and every one of them read, in
    // source, exactly like a labelled element.
    const offenders: string[] = [];
    const runaways: string[] = [];
    let seen = 0;
    for (const [name, src] of BARE) {
      for (const tag of openTags(src, GENERIC)) {
        seen++;
        // A tag whose attributes the scan never finished is not a tag this
        // sweep may report on either way — see #513. Named rather than skipped.
        if (tag.ranAway) { runaways.push(`${name}:${tag.line} <${tag.name}`); continue; }
        if (!/\baria-label(?:ledby)?=/.test(tag.attrs)) continue;
        if (/\brole=/.test(tag.attrs)) continue;
        offenders.push(`${name}:${tag.line} <${tag.name} ${tag.attrs.trim().split(/\s+/)[0]}>`);
      }
    }
    expect(runaways, "a tag scan ran away — its attributes belong to something else").toEqual([]);
    expect(offenders).toEqual([]);
    // #655's floor for this sweep. The old regex reached the tag NAME of all
    // 592 of these and then cut 14 of their attribute lists short at the `>` of
    // an arrow function, so a name declared after a handler was invisible to
    // the filter above and the sweep passed by not looking. A count taken
    // straight out of the source is what says the scan is still reaching them.
    const openings = BARE.reduce((n, [, src]) =>
      n + [...src.matchAll(new RegExp(`<(?:${GENERIC.join("|")})\\b`, "g"))].length, 0);
    expect(seen, "the generic-tag scan is seeing fewer tags than the bundle opens").toBe(openings);
    expect(openings).toBeGreaterThan(400);
  });

  it("gave the cost bar the role that makes its label exist", () => {
    // It was three copies of one component in three files when #381 landed, so
    // the fix had to be made three times and this assertion had to name three
    // files. #374 removed the duplication: the bar is components/CostBar.tsx
    // now, both of its class spellings carry the role, and the three panels
    // import it. The assertion got stronger rather than narrower — it is no
    // longer possible for one surface to have the role and another not.
    expect(code(costBar)).toMatch(/className=\{large \? "cost-bar cost-bar-lg" : "cost-bar"\} role="img" aria-label="Cost breakdown"/);
    for (const [file, src] of [["App.tsx", app], ["UsagePanel.tsx", usage], ["SessionSummary.tsx", summary]] as const) {
      expect(code(src), `${file} imports the bar`).toMatch(/import CostBar from "\.(\/components)?\/CostBar";/);
      expect(code(src), `${file} draws no bar of its own`).not.toMatch(/className="cost-bar/);
    }
  });
});

// ── the outline ─────────────────────────────────────────────────────────────

describe("the heading outline starts at level 1 and skips nothing (#381)", () => {
  it("has exactly one <h1>, and it is the wordmark already on the page", () => {
    const h1s = BUNDLE.flatMap(([name, src]) => [...src.matchAll(/<h1[\s>]/g)].map(() => name));
    expect(h1s).toEqual(["App.tsx"]);
    expect(code(app)).toMatch(/<h1>\{PRODUCT\}<\/h1>/);
  });

  it("did not hide it, because the name it carries is already visible", () => {
    // A .vis-hidden <h1> was the other option and would have made a screen
    // reader say "ccdeck" twice — once as the heading, once as the wordmark two
    // pixels to its right. The class exists (#373) and is deliberately not used
    // here; marking up the text that is already on screen is what 1.3.1 asks.
    expect(code(app)).toMatch(/<h1>/);
    expect(code(app)).not.toMatch(/<h1 className="vis-hidden"/);
    expect(code(app)).not.toMatch(/<h1[^>]*aria-hidden/);
  });

  it("keeps the <h1> out of the version chip's accessible name", () => {
    // The chip is a sibling of the heading and not a child of it. Inside, its
    // whole sentence about npm would become part of the heading's name — the
    // rotor's entry for this page would be a paragraph.
    const brand = code(app).slice(code(app).indexOf('<div className="brand">'));
    expect(brand).toContain("<h1>");
    expect(brand.indexOf("<h1>")).toBeLessThan(brand.indexOf("{notice ?"));
    expect(brand).not.toMatch(/<h1>[\s\S]*?<button[\s\S]*?<\/h1>/);
  });

  it("heads every persistent region with an <h2>", () => {
    expect(code(usage)).toMatch(/<h2>Usage<\/h2>/);
    expect(code(accounts)).toMatch(/<h2>Accounts<\/h2>/);
    expect(code(sessions)).toMatch(/<h2>Sessions <span className="sl-count">/);
    // The detail panel, in both of its states: the agent's name when one is
    // selected, and the panel's own word when none is.
    expect(code(app)).toMatch(/<h2 className="hero-title"/);
    expect(code(app)).toMatch(/<h2>Detail<\/h2>/);
  });

  it("steps the usage panel's sections from h4 to h3, under that h2", () => {
    expect([...code(usage).matchAll(/<h3 className="up-section-title">/g)]).toHaveLength(4);
    expect(code(usage)).not.toMatch(/<h4/);
  });

  it("leaves <h4> only inside the dialogs, which are their own naming context", () => {
    // aria-modal="true" prunes everything outside the dialog from the tree, and
    // all six of these dialogs name themselves with aria-label or
    // aria-labelledby rather than with a heading — so their internal levels are
    // a separate question from the page's outline, and re-levelling them is not
    // this issue's change. Pinned so the scope-out is a decision on the record
    // rather than something that was missed.
    const withH4 = BUNDLE.filter(([, src]) => /<h4[\s>]/.test(src)).map(([name]) => name).sort();
    expect(withH4).toEqual([
      "components/AddAccountDialog.tsx",
      "components/BrowserWatchModal.tsx",
      "components/SessionSummary.tsx",
      "components/ShareAccountsDialog.tsx",
      "components/ToolModal.tsx",
    ]);
  });
});

describe("promoting the headings changed no pixels (#381)", () => {
  /** The last declaration of `prop` in the rule for `selector`. */
  function decl(selector: string, prop: string): string | null {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(m => m[1].split(",").some(s => s.replace(/\s+/g, " ").trim() === selector));
    if (!rules.length) return null;
    const body = rules.map(m => m[2]).join(";");
    const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
    return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
  }

  it("keeps every panel caption off the UA sheet's default", () => {
    // An <h2> arrives from the UA sheet at 1.5em where an <h3> arrives at
    // 1.17em, so a caption with no font-size of its own would have grown by a
    // third. That is what this issue was guarding and it still holds; what
    // changed is that all three now say the same thing rather than 13px, 12px
    // and the 1.17em below. #380 reconciled them — see panel-rhythm.test.ts,
    // which is where the "all three agree" assertion lives now.
    expect(decl(".up-header h2", "font-size")).toBe("13px");
    expect(decl(".ap-header h2", "font-size")).toBe("13px");
    expect(decl(".up-header h3", "font-size")).toBeNull();
    expect(decl(".ap-header h3", "font-size")).toBeNull();
  });

  it("no longer leaves the one that did depend on it at the UA sheet's number", () => {
    // This was pinned at 1.17em — the UA sheet's h3 written down — precisely so
    // that #381 changed no pixels, with a comment saying reconciling the three
    // captions was #380's change. It is that value now: a declared 13px, not a
    // multiple of whatever <body> happens to be set at.
    expect(decl(".session-list .sl-header h2", "font-size")).toBe("13px");
    expect(decl(".session-list .sl-header h2", "font-size")).not.toMatch(/em$/);
    expect(decl(".session-list .sl-header h3", "margin")).toBeNull();
  });

  it("styles the detail panel's h2 without catching the agent's name in it", () => {
    // `.detail-hero .hero-title` is an <h2> too, and it is a title rather than
    // a caption. A bare `.detail h2` would set it in 11px uppercase grey.
    //
    // The hero title was pinned at 17px here; #379 moved it to 18px, joining
    // `.empty-hero h2` rather than sitting one pixel under it. What this test is
    // guarding is unchanged and is the reason the number is still asserted at
    // all: the two selectors must not converge. The child combinator on
    // `.detail > h2` is what keeps the caption rule off the agent's name, and it
    // would still be doing that if the title were any size — so the assertion
    // below is that the title is a title, several steps clear of the 11px
    // caption, not that it is one particular number.
    expect(decl(".detail > h2", "font-size")).toBe("11px");
    expect(decl(".detail > h2", "text-transform")).toBe("uppercase");
    expect(decl(".detail-hero .hero-title", "font-size")).toBe("18px");
    expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/(^|[,\s])\.detail h2\b/);
  });

  it("holds the wordmark at 14px against the UA sheet's 2em", () => {
    expect(decl(".topbar .brand h1", "font")).toBe("inherit");
    expect(decl(".topbar .brand h1", "margin")).toBe("0");
    expect(decl(".topbar .brand", "font-size")).toBe("14px");
  });
});

// ── the skip link ───────────────────────────────────────────────────────────

describe("the route past a hundred and sixty-six tab stops (#381)", () => {
  function decl(selector: string, prop: string): string | null {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(m => m[1].split(",").some(s => s.replace(/\s+/g, " ").trim() === selector));
    if (!rules.length) return null;
    const body = rules.map(m => m[2]).join(";");
    const all = [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:([^;]*)`, "g"))];
    return all.length ? all[all.length - 1][1].replace(/\s+/g, " ").trim() : null;
  }

  it("is the first thing in the document and points at the canvas", () => {
    const bare = code(app);
    const start = bare.indexOf('<div className="app">');
    const link = bare.indexOf('<a className="skip-link" href="#canvas">', start);
    const topbar = bare.indexOf('<header className="topbar">', start);
    expect(link).toBeGreaterThan(start);
    expect(link).toBeLessThan(topbar);
    // The href and the id are the same word, and the element that carries the
    // id is the element the link means to reach.
    expect(bare).toMatch(/<main\n\s+id="canvas"/);
  });

  it("gives that target a negative tabIndex, because a fragment must be focusable to be focused", () => {
    // Without it the browser scrolls to the element and leaves focus where it
    // was, which for a skip link is the whole failure.
    expect(code(app)).toMatch(/<main\n\s+id="canvas"\n\s+tabIndex=\{-1\}/);
  });

  it("is out of flow, or it would take the topbar's grid cell", () => {
    // .app auto-places its children. An in-flow first child claims row 1
    // column 1 and pushes the 52px bar into row 2.
    expect(decl(".skip-link", "position")).toBe("fixed");
    expect(decl(".app", "display")).toBe("grid");
  });

  it("hides without leaving the tab order, and comes back on focus", () => {
    // display:none and visibility:hidden both remove an element from the tab
    // order and the accessibility tree — a skip link nothing can focus is the
    // one thing it must never be. And it is not .vis-hidden either: that class
    // is a 1px clipped box, and this has to become readable.
    expect(decl(".skip-link", "display")).toBeNull();
    expect(decl(".skip-link", "visibility")).toBeNull();
    expect(decl(".skip-link", "transform")).toMatch(/translateY/);
    expect(decl(".skip-link:focus", "transform")).toBe("none");
    expect(code(app)).not.toMatch(/className="skip-link vis-hidden"/);
  });

  it("shows the reader where they landed", () => {
    // A programmatic focus target with no ring is a jump to nowhere. Inset,
    // because .canvas-wrap runs to the window edge and the shared outward
    // offset would draw two of its sides off screen.
    expect(decl(":focus-visible", "outline")).toMatch(/2px solid var\(--accent\)/);
    expect(decl(".canvas-wrap:focus-visible", "outline-offset")).toBe("-3px");
  });
});

// ── the names that were only ever tooltips ──────────────────────────────────

describe("no control is named by its title attribute alone (#381)", () => {
  /** Every string a button body can render, or null when the body is not
   *  purely text — an <svg> child is a different question and `aria-hidden`
   *  answers it. */
  function rendered(body: string): string[] | null {
    if (!body.includes("{")) return [body.trim()];
    const literals = [...body.matchAll(/"([^"]*)"/g)].map(m => m[1].trim());
    const syntax = body.replace(/"[^"]*"/g, "").replace(/[?:{}\s]/g, "");
    // Anything left is an identifier being rendered, whose length nothing here
    // can know.
    if (/[A-Za-z0-9_]/.test(syntax)) return null;
    return literals;
  }

  /**
   * Every `<button>` in a file, with the text between its tags.
   *
   * The body is the run from the tag's own `>` up to the next `<`. When that
   * next `<` is not `</button>` the button has element children — an `<svg>`,
   * a `<span>` — and `rendered` is not the question to ask of it, so the body
   * comes back null and the caller skips it. That is the same line the paired
   * regex drew with `([^<>]*)`, drawn where the tokenizer can see it.
   */
  function buttons(src: string): Array<{ attrs: string; body: string | null; line: number }> {
    return openTags(src, ["button"]).map(tag => {
      if (tag.ranAway) return { attrs: "", body: null, line: tag.line };
      // `<button … />` has no body at all, and the text after it belongs to
      // whatever comes next.
      if (/\/\s*$/.test(tag.attrs)) return { attrs: tag.attrs, body: null, line: tag.line };
      const after = src.slice(tag.end + 1);
      const next = after.indexOf("<");
      const body = next < 0 ? null : after.slice(0, next);
      return {
        attrs: tag.attrs,
        body: after.slice(next).startsWith("</button>") ? body : null,
        line: tag.line,
      };
    });
  }

  it("leaves no glyph-only button whose only name is a tooltip", () => {
    // `title` is a valid last-resort name source, so 4.1.2 was technically
    // met — and a touch user never sees a tooltip, and a screen reader can be
    // configured never to read one. Two of the app's sixty-odd icon buttons
    // were in this state: the usage panel's ↻ and the accounts panel's +.
    //
    // "Sixty-odd" is what the comment claimed and 43 is what the regex under it
    // reached (#655). The 25 it missed were every button whose attribute list
    // holds a `>` inside nested braces — `onClick={() => f({…})}`, the ordinary
    // spelling — because the pattern's `[^<>]` ended the tag at the arrow.
    //
    // Read with the tokenizer all 68 are examined and all 68 pass, so what the
    // hole was hiding was the absence of a check and not a defect behind it:
    // the short-bodied buttons among the 25 are named already — the accounts
    // row's `⋯` and the version chip by an `aria-label`, the history modal's
    // `{p}d` range chips and the dialog's `{t.label}` tabs by the text they
    // render, which is a name.
    const offenders: string[] = [];
    for (const [name, src] of BARE) {
      for (const { attrs, body, line } of buttons(src)) {
        if (body === null) continue;
        const texts = rendered(body);
        if (texts === null || texts.length === 0) continue;
        if (texts.some(t => t.length > 2)) continue;
        if (/\baria-label(?:ledby)?=/.test(attrs)) continue;
        offenders.push(`${name}:${line} ${body.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches every button the bundle opens, which is what it used to claim (#655)", () => {
    // The floor, taken from the bundle rather than written down. `<button` is
    // a string the source cannot hide: count it, and the sweep above has to
    // have examined that many. A pattern that goes back to ending a tag at the
    // first `>` fails here with both numbers instead of quietly sweeping the
    // survivors.
    //
    // First, the assumption the bodies rest on. Each tag's `end` indexes the
    // string `openTags` scanned, which is `withoutComments(source)` — so `BARE`
    // has to be a fixed point of that function, or every body is sliced from
    // the wrong offset and the count below would not notice.
    for (const [name, src] of BARE) expect(withoutComments(src), name).toBe(src);
    const openings = BARE.reduce((n, [, src]) => n + [...src.matchAll(/<button\b/g)].length, 0);
    const scanned = BARE.flatMap(([, src]) => buttons(src));
    expect(scanned.length, `the bundle opens ${openings} buttons; the scan reached ${scanned.length}`)
      .toBe(openings);
    // And not vacuously: this deck really does have sixty-odd of them.
    expect(openings).toBeGreaterThan(60);
    // Of those, the ones with a plain text body are the sweep's actual input —
    // floored too, because a `buttons()` that started returning null for
    // everything would satisfy the count above and examine nothing.
    expect(scanned.filter(b => b.body !== null).length).toBeGreaterThan(40);
    // The shape the old pattern could not read, asserted directly rather than
    // only through the totals. Both of these end at the wrong `>` under
    // `[^<>]`, and both are real spellings from the bundle.
    const fixture = [
      '<button onClick={() => setOpen({ id: 1 })} aria-label="Open">×</button>',
      '<button title="x" onClick={e => f(e as React.MouseEvent<HTMLButtonElement>)}>ok</button>',
    ].join("\n");
    expect(buttons(fixture).map(b => b.body)).toEqual(["×", "ok"]);
    expect(buttons(fixture)[0].attrs).toContain('aria-label="Open"');
  });

  it("names the ↻ with the same sentence its tooltip shows", () => {
    // One string for both, which keeps 2.5.3 satisfied by construction: the
    // words a voice-control user says are the words on screen. It is per
    // provider, so it never promises a section the panel is not rendering.
    expect(code(usage)).toMatch(/aria-label=\{refreshLabel\}\n\s+title=\{refreshLabel\}/);
    expect(code(usage)).toMatch(/providers\.claude && providers\.codex\s*\n?\s*\? "Refresh Claude \+ Codex quota"/);
  });

  it("names the + and keeps its longer tooltip as the hint", () => {
    expect(code(accounts)).toMatch(/aria-label="Add an account"/);
    expect(code(accounts)).toMatch(/title="Sign in to another Claude account/);
  });
});

// ── the chip that had news and said less than the one that did not ──────────

describe("the version chip's drift branch says what drifted (#381)", () => {
  it("named itself with its own text, which was the healthy chip's text", () => {
    // The regression this guards: the notice branch renders `v{notice.from}`
    // and an aria-hidden dot, so with no aria-label its accessible name was
    // the version string — byte for byte what the healthy chip announces. The
    // branch carrying the news was the quieter of the two.
    expect(code(app)).toMatch(/aria-label=\{versionNoticeLabel\(\{ \.\.\.notice, open: noticeOpen \}\)\}/);
  });

  it("says which way the drift goes, in both kinds", () => {
    expect(versionNoticeLabel({ kind: "upgrade", from: "1.35.2", to: "1.36.0", open: false }))
      .toBe("Version v1.35.2, v1.36.0 is available on npm — show what's new and the notice");
    expect(versionNoticeLabel({ kind: "restart", from: "1.35.2", to: "1.36.0", open: false }))
      .toBe("Version v1.35.2, v1.36.0 is installed and waiting for a restart — show what's new and the notice");
  });

  it("describes the next click rather than the current state", () => {
    // #715 turned this from a toggle into a reveal, and the lesson survives the
    // change: the name is still what the next press DOES. What moved is that
    // the notice is promised only while it is not already there — promising to
    // show something the reader can see is how a name stops being trusted — and
    // the release notes, which the press opens either way, are named in both.
    const open = versionNoticeLabel({ kind: "upgrade", from: "1.0.0", to: "1.1.0", open: true });
    expect(open).toMatch(/show what's new$/);
    expect(open).not.toMatch(/and the notice/);
    // Never "hide": this chip cannot put the banner away any more, and a name
    // offering that would be describing the × further down the page.
    expect(open).not.toMatch(/hide/);
  });

  it("is a way into the release notes in the state that lasts longest (#715)", () => {
    // The amber chip is drawn for as long as the deck is behind, which can be
    // weeks. #712's dialog is safe to dismiss only because it is reachable
    // again, so this branch has to offer it too or that reachability lapses for
    // exactly as long as the drift does.
    for (const open of [true, false]) {
      expect(versionNoticeLabel({ kind: "restart", from: "1.35.2", to: "1.36.0", open }), String(open))
        .toContain("show what's new");
    }
  });

  it("carries the visible text inside the accessible name (2.5.3)", () => {
    // The chip reads `v1.35.2` on screen; a name that did not contain that
    // string would leave a voice-control user with nothing to say.
    for (const open of [true, false]) {
      expect(versionNoticeLabel({ kind: "upgrade", from: "1.35.2", to: "1.36.0", open }))
        .toContain("v1.35.2");
    }
  });
});

// ── the chart that hid its own buttons ──────────────────────────────────────

describe("the usage-history chart stopped hiding the days inside it (#381)", () => {
  it("is a group, not an image", () => {
    // role="img" makes the whole subtree presentational — and does nothing at
    // all to the tab order, so what it produced was up to ninety focusable
    // buttons that announced nothing when they took focus. Same shape as the
    // tool-bubble finding in #367: reachable and silent.
    // The `ref` in front of the class list is #539's — the chart is a scroller
    // now and something has to park it on today — so the match allows the
    // attributes before `className` while still pinning the role and the name.
    expect(code(history)).toMatch(/<div [^>]*className="uh-chart" role="group" aria-label="Daily cost by model">/);
    expect(code(history)).not.toMatch(/role="img"/);
  });

  it("names each day with the figure its tooltip already carried", () => {
    expect(code(history)).toMatch(/const dayLabel = `\$\{d\.period\}, \$\{fmtCost\(d\.totalCost\)\}`/);
    expect(code(history)).toMatch(/aria-label=\{dayLabel\}/);
    expect(code(history)).toMatch(/aria-pressed=\{isSel\}/);
  });

  it("stopped promising a tab widget's keyboard on the range strip", () => {
    // role="tab" means one tab stop for the set, arrows between the members,
    // and a tabpanel each. The strip has none of the three. A radiogroup —
    // which is what the issue proposed — carries exactly the same unmet
    // contract, so the swap is to group + aria-pressed, which is the shape the
    // canvas category chips already use.
    expect(code(history)).toMatch(/<div className="uh-range" role="group" aria-label="Range">/);
    expect(code(history)).not.toMatch(/role="tab(list)?"/);
    expect(code(history)).not.toMatch(/aria-selected/);
  });

  it("hands the one real tab set over to the test that can hold it (#581)", () => {
    // This used to assert role="tablist" was present here and nowhere else,
    // under a comment scoping the missing arrow keys, aria-controls and
    // tabpanels out of a landmarks issue — "pinned so the scope-out stays a
    // decision." It asked WHERE the role was and never whether it was
    // honoured, so a green assertion sat on top of the defect until #581 went
    // and looked. The scope-out has been taken back out: the dialog now
    // implements the widget, and tablist-contract.test.ts holds the whole
    // contract for any file that carries the role, so nothing here needs to
    // name a file or pin the role's presence again.
    //
    // What stays is the landmarks question, which is the one this file is
    // about: a tab in this deck belongs inside a tablist and nowhere else,
    // because a stray role="tab" is an orphan in the accessibility tree
    // whatever its keyboard does.
    const strips = BUNDLE.filter(([, src]) => /\brole="tab"/.test(src));
    // The floor, and it sits outside the loop on purpose (#627). This was a
    // `continue` inside the loop, which meant a client with no role="tab" left
    // ran the assertion zero times and reported green — so half-removing the
    // role from the one file that has it silenced this case along with the five
    // in tablist-contract.test.ts, which had the identical hole. That file now
    // also holds the inverse, that nothing carries a tablist or a tabpanel with
    // no tab inside it, which is the shape a half-removal actually leaves.
    expect(strips.length, 'no role="tab" anywhere — the assertion below would run zero times').toBeGreaterThan(0);
    for (const [name, src] of strips) {
      expect(`${name} ${src.includes('role="tablist"')}`).toMatch(/true$/);
    }
  });
});
