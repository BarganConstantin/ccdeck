// #338: a deck in a background tab said nothing at all.
//
// index.html's <title> is static markup and `document.title` was assigned
// nowhere in src/web/, so the tab strip — the one surface of this deck that is
// on screen while the deck is not — read identically whether five sessions were
// blocked on a permission prompt or nothing had moved since lunch.
//
// Three things are pinned here, and only one of them is the arithmetic.
//
// The first is the ORDER of the title. `(2) ccdeck` and `ccdeck (2)` differ by
// nothing a reviewer would defend and by everything a user sees: browsers
// truncate a tab title from the end, so the appended form is clipped away at
// exactly the widths a deck is read at. It looks like a mistake, which means
// somebody will eventually fix it — so the count is asserted at index 0 rather
// than merely present, and that fix fails here.
//
// The second is WHAT THE ICON IS. It was a `<text>◉</text>` font glyph, then
// this repo's own drawn marks; since the brand kit it is the kit's own file
// for each state. So each state is asserted to name the kit file for the state
// it maps to, and each badge against the dark tile it is drawn on.
//
// The third is that neither write happens on a frame that changed nothing. The
// effect sits on the SSE path, where `running` churns constantly under a title
// that is not moving.
//
// The fourth is WHAT COUNTS, which is the one this file got wrong. #348
// narrowed the alarm to `permission` blocks and left `idle` out of it; this
// file kept its own hand-written copy of the old expression and was not touched
// by that commit, so from #348 until #377 the suite asserted the superseded
// counting as correct behaviour — a green test standing over exactly the
// regression it was written to catch. The copy is gone: the counting cases
// below call ambient-counts.ts, which is the same module App.tsx and
// SessionList.tsx count with, so there is nothing left here that can drift from
// what ships.
//
// Plain node, no DOM — so this tests the pure functions, reads the two source
// files as text, and drives the reducer directly for the counting.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ambientSignal, FAVICON_FALLBACK_HREF, FAVICON_HREF, type AmbientIcon } from "../ambient";
import { blockedSessions, runningSessionCount } from "../ambient-counts";
import { PRODUCT } from "../brand";
import { applyEvent, initialState, pruneOldAgents } from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** A source file with its prose removed, the way display-name.test.ts does it.
 *  The comments in ambient.ts quote the exact title format, which is the point
 *  of them being there — only the code may not spell the name out. */
const codeOf = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

describe("the title", () => {
  it("is exactly the product name when nothing is waiting", () => {
    // Not `(0) ccdeck`. Zero is the resting state and a badge that reports
    // nothing is wrong is a badge that stops being read at (1) as well.
    const title = ambientSignal({ waiting: 0, running: 0 }).title;
    expect(title).toBe(PRODUCT);
    expect(title).not.toContain("(");
    expect(title).toBe(title.trim());
  });

  it("stays exactly the product name while work is running", () => {
    // Running is not a thing to interrupt someone about. It gets the icon and
    // nothing else — a title that moves on every subagent is a title nobody
    // reads by the time it matters.
    expect(ambientSignal({ waiting: 0, running: 4 }).title).toBe(PRODUCT);
  });

  it("leads with the count, which is the entire point of the format", () => {
    // indexOf 0, not toContain: `ccdeck (2)` passes a containment check and
    // fails the user, because the tab it has to be legible in is a few
    // characters wide and browsers cut from the END.
    for (const waiting of [1, 7]) {
      const title = ambientSignal({ waiting, running: 0 }).title;
      expect(title).toBe(`(${waiting}) ${PRODUCT}`);
      expect(title.indexOf(`(${waiting})`)).toBe(0);
      expect(title.startsWith(PRODUCT)).toBe(false);
    }
  });

  it("names the deck with PRODUCT rather than a literal of its own", () => {
    // Asserted against the imported constant on purpose: a rename that reaches
    // brand.ts has to reach the tab, and a hardcoded "ccdeck" in ambient.ts
    // would keep this test green through exactly the drift it exists to catch
    // — so the source is checked too, with the prose stripped out, since the
    // comments there quote the format and are meant to.
    expect(ambientSignal({ waiting: 3, running: 0 }).title).toContain(PRODUCT);
    expect(codeOf(read("../ambient.ts"))).not.toContain(PRODUCT);
  });

  it("goes back to plain when the last block clears", () => {
    // The classic failure of this feature is a count that only ever goes up.
    expect(ambientSignal({ waiting: 1, running: 2 }).title).toBe(`(1) ${PRODUCT}`);
    expect(ambientSignal({ waiting: 0, running: 2 }).title).toBe(PRODUCT);
    expect(ambientSignal({ waiting: 0, running: 0 }).title).toBe(PRODUCT);
  });
});

describe("which icon wins", () => {
  it("is waiting whenever anything is blocked, however much else is working", () => {
    // The tab strip is an alarm surface, not a status report: the four running
    // sessions will finish by themselves and the blocked one will not.
    expect(ambientSignal({ waiting: 1, running: 4 }).icon).toBe("waiting");
    expect(ambientSignal({ waiting: 9, running: 0 }).icon).toBe("waiting");
  });

  it("is running when work is moving and nothing needs a human", () => {
    expect(ambientSignal({ waiting: 0, running: 1 }).icon).toBe("running");
  });

  it("is idle when there is nothing to say", () => {
    expect(ambientSignal({ waiting: 0, running: 0 }).icon).toBe("idle");
  });

  it("leaves the alarm the moment the block does", () => {
    expect(ambientSignal({ waiting: 2, running: 3 }).icon).toBe("waiting");
    expect(ambientSignal({ waiting: 0, running: 3 }).icon).toBe("running");
    expect(ambientSignal({ waiting: 0, running: 0 }).icon).toBe("idle");
  });

  it("is offline the moment the stream dies, whatever the board last looked like", () => {
    // Offline outranks both, and #719 is the reasoning: while the stream is
    // down, `waiting` and `running` are frozen readings of a board that has
    // moved on without telling anyone. Running would claim work is in flight that
    // may have finished; idle would claim a quiet deck. And the alarm cannot be
    // cleared by acting on it — approving the prompt changes nothing here,
    // because nothing is arriving to say it was approved.
    for (const board of [{ waiting: 3, running: 4 }, { waiting: 0, running: 4 }, { waiting: 0, running: 0 }]) {
      expect(ambientSignal({ ...board, connected: false }).icon, JSON.stringify(board)).toBe("offline");
    }
  });

  it("goes back to reading the board the moment the stream returns", () => {
    // The mirror of the case above, and the one that would catch a `connected`
    // that had become sticky.
    expect(ambientSignal({ waiting: 3, running: 4, connected: false }).icon).toBe("offline");
    expect(ambientSignal({ waiting: 3, running: 4, connected: true }).icon).toBe("waiting");
  });

  it("assumes a connection when nobody says otherwise", () => {
    // The flag is optional so that a caller which has no opinion cannot
    // accidentally paint every tab red. Absence means "not claiming the stream
    // is down", never "the stream is down".
    expect(ambientSignal({ waiting: 0, running: 1 }).icon).toBe("running");
  });

  it("keeps the count in the title while the stream is down", () => {
    // The count is a last reading rather than a live one, and it stays: nobody
    // answered those prompts while the deck was not looking, so dropping it
    // would read as "they were dealt with". `(2)` beside a broken mark is the
    // honest pair.
    const dead = ambientSignal({ waiting: 2, running: 0, connected: false });
    expect(dead.title).toBe(ambientSignal({ waiting: 2, running: 0 }).title);
    expect(dead.icon).toBe("offline");
  });
});

// ── the mark itself ─────────────────────────────────────────────────────────

/** Every state the icon has, read from the table rather than listed here.
 *
 *  It WAS listed here — `["waiting", "running", "idle"]` — and #719 is what that
 *  cost: adding a fourth state and its mark left all eighteen cases in this file
 *  green, because every loop below iterates this array and the array had never
 *  heard of it. The new icon went unencoded, unmeasured for contrast, and
 *  unchecked for animation, and the suite reported success. A list of states
 *  maintained beside the states is the same drift `ambient-counts.ts` was
 *  written to end, one file over.
 *
 *  The cast is safe and the assertion below is what makes it so: if the table
 *  ever loses a key the type still allows, this fails naming the gap instead of
 *  quietly testing a smaller set. */
const STATES = Object.keys(FAVICON_HREF) as AmbientIcon[];

it("covers every icon the signal can ask for", () => {
  // The guard on the line above. `ambientSignal` returns an AmbientIcon and
  // App.tsx indexes FAVICON_HREF with it, so a state with no href is a runtime
  // `undefined` assigned to link.href — which browsers resolve against the page
  // URL and quietly render as no icon at all.
  const reachable: AmbientIcon[] = ["offline", "waiting", "running", "idle"];
  expect([...STATES].sort()).toEqual([...reachable].sort());
});

type KitState = "default" | "waiting" | "syncing" | "error";

/** The owner's mapping (2026-10-01), pinned whole: which of the kit's states
 *  each tab state wears. The kit's paused has no tab state behind it, so it is
 *  unused rather than given a meaning. */
const KIT_STATE: Record<AmbientIcon, KitState> = {
  idle: "default",
  waiting: "waiting",
  running: "syncing",
  offline: "error",
};

/** The kit's own file for each of its states, as kit.json names it, for the
 *  SVG link and for the 32px fallback beside it. */
const KIT_SVG = (state: KitState) => (state === "default" ? "05-web/favicon.svg" : `05-web/state/favicon-${state}.svg`);
const KIT_FALLBACK = (state: KitState) => (state === "default" ? "05-web/favicon.ico" : `05-web/state/favicon-${state}-32.png`);

/** assets/brand/kit.json: every kit file the repo carries and where it is. */
const kitRecord: { files: { from: string; to: string[] }[] } = JSON.parse(read("../../../assets/brand/kit.json"));
const copiesOf = (from: string) => kitRecord.files.find(f => f.from === from)?.to ?? [];
/** The public path a `src/web/public/...` copy is served at. */
const servedAt = (rel: string) => rel.replace(/^src\/web\/public/, "");

/** The SVG a browser will actually parse for this state. */
function svgFor(icon: AmbientIcon): string {
  return read(`../public${FAVICON_HREF[icon]}`);
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => {
    const n = parseInt(hex.slice(i, i + 2), 16) / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The tab's mark was this file's own drawing until the brand kit (#338, #719):
// a ring, a ring around a dot, a solid disc and a broken ring, in four fills
// tuned for 3:1 on a white and a #1f1f1f strip, which told the states apart by
// silhouette for a dichromat viewer at 16px. The kit's rule is that status is
// an overlay on an unchanged mark, never a recolouring or a reshaping of it,
// and the kit ships each state as a file — its favicon with a corner badge cut
// into it — so the cases below pin the new contract: each state is the kit's
// file for the state it maps to, nothing drawn here. The whole-mark silhouette
// guarantee is dropped on purpose; what is left of it is that the four files
// still differ in shape with every colour stripped, and the title's `(n)`
// still carries the alarm on its own.
describe("the favicon", () => {
  it("wears the kit's file for each state, SVG and fallback alike", () => {
    for (const icon of STATES) {
      const state = KIT_STATE[icon];
      expect(copiesOf(KIT_SVG(state)).map(servedAt), `${icon} is not the kit's ${state} SVG`).toContain(FAVICON_HREF[icon]);
      expect(copiesOf(KIT_FALLBACK(state)).map(servedAt), `${icon}'s fallback is not the kit's ${state} raster`)
        .toContain(FAVICON_FALLBACK_HREF[icon]);
    }
  });

  it("rests on the kit's favicon itself, the files index.html links", () => {
    expect(FAVICON_HREF.idle).toBe("/favicon.svg");
    expect(FAVICON_FALLBACK_HREF.idle).toBe("/favicon.ico");
  });

  it("ships every file it names", () => {
    // An href to a file that is not there is resolved by the SPA fallback to
    // index.html, which a browser cannot draw: the tab silently keeps the icon
    // it had.
    for (const href of [...Object.values(FAVICON_HREF), ...Object.values(FAVICON_FALLBACK_HREF)]) {
      expect(href.startsWith("/"), `${href} is not a path the deck serves`).toBe(true);
      expect(() => read(`../public${href}`), `${href} does not ship`).not.toThrow();
    }
  });

  it("tells the states apart by shape, not only by colour", () => {
    // What is left of #338's silhouette rule. Hue is the channel a dichromat
    // viewer does not get, so with every colour stripped the four must still be
    // four different drawings: the mark alone, a dot, an open ring, a bang.
    const geometry = STATES.map(icon => svgFor(icon).replace(/#[0-9a-f]{3,8}\b/gi, "").replace(/\bid="[^"]*"|url\(#[^)]*\)/g, ""));
    expect(new Set(geometry).size, "two states are the same drawing once colour is gone").toBe(STATES.length);
  });

  it("is drawn, not typed — no font decides the shape on any platform", () => {
    // It was a `<text>◉</text>` glyph until #338: a font-dependent shape that
    // renders at three weights on three platforms and as tofu where the
    // codepoint is missing, which a state cannot survive.
    for (const icon of STATES) {
      expect(svgFor(icon), `${icon} draws with a glyph`).not.toMatch(/<text|font-|◉/);
    }
  });

  it("puts each state's badge on the kit's dark tile, where it reads at 3:1", () => {
    // The page cannot ask what colour the tab strip is. The old marks had a
    // transparent ground, so their fills had to clear 3:1 on a white strip and
    // on a #1f1f1f one at once. The kit's favicon brings its own dark tile, and
    // the badge is drawn on it: 1.4.11's 3:1 is measured there.
    for (const icon of STATES.filter(i => KIT_STATE[i] !== "default")) {
      const svg = svgFor(icon);
      const tile = /<rect [^>]*fill="(#[0-9a-f]{6})"/i.exec(svg)?.[1];
      const badge = /<path fill="(#[0-9a-f]{6})"[^>]*\/><\/svg>\s*$/i.exec(svg)?.[1];
      expect(tile, `${icon} has no tile`).toBeTruthy();
      expect(badge, `${icon} has no badge after its mark`).toBeTruthy();
      expect(contrastRatio(badge!, tile!), `${icon}'s badge ${badge} vanishes on the tile ${tile}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("never animates", () => {
    // A pulsing favicon re-fetches and re-rasterises an icon for the life of
    // the tab, and is the most hated pattern in this genre.
    for (const icon of STATES) {
      expect(svgFor(icon)).not.toMatch(/<animate|animation|keyframes|dur=/i);
    }
  });

  const links = [...read("../index.html").matchAll(/<link\b[^>]*>/g)].map(m => m[0]);
  const iconLinks = links.filter(tag => /\brel\s*=\s*"[^"]*\bicon\b[^"]*"/.test(tag));

  it("keeps the boot icons in index.html identical to the resting state", () => {
    // index.html is parsed before any module runs, so these hrefs cannot be
    // derived. Drift means the tab changes icon between the first frame and the
    // second.
    const svgLink = iconLinks.find(tag => /\btype="image\/svg\+xml"/.test(tag));
    const fallback = iconLinks.find(tag => /\bsizes="32x32"/.test(tag));
    expect(svgLink, "index.html links no SVG icon").toContain(`href="${FAVICON_HREF.idle}"`);
    expect(fallback, "index.html links no 32x32 fallback").toContain(`href="${FAVICON_FALLBACK_HREF.idle}"`);
  });

  it("hangs the state on exactly the two links the writer asks for", () => {
    // #378: the href was pinned and the SELECTOR was not, and the selector is
    // what the feature is. Renaming the link `rel="shortcut icon"` once left
    // every test green while the icon stopped changing state for the life of
    // the tab. A second `rel="icon"` link is not null but the WRONG node:
    // querySelector returns the first in document order.
    //
    // The kit's head has two `rel="icon"` links, so the writer asks for each by
    // what tells it apart — the SVG by its type, the fallback by its size — and
    // this holds both ends: the icon links are exactly the kit's three, each
    // selector matches exactly one of them, and the writer runs those two.
    const rels = iconLinks.map(tag => /\brel="([^"]+)"/.exec(tag)?.[1]).sort();
    expect(rels, "the icon links are no longer the kit's ICO, SVG and touch icon").toEqual(["apple-touch-icon", "icon", "icon"]);
    const svg = iconLinks.filter(tag => /\brel="icon"/.test(tag) && /\btype="image\/svg\+xml"/.test(tag));
    const fallback = iconLinks.filter(tag => /\brel="icon"/.test(tag) && /\bsizes="32x32"/.test(tag));
    expect(svg, "the SVG selector does not find exactly one link").toHaveLength(1);
    expect(fallback, "the fallback selector does not find exactly one link").toHaveLength(1);
    expect(svg[0]).not.toBe(fallback[0]);
    const writer = read("../use-tab-ambient.ts");
    expect(writer, "the tab's write stopped asking for the SVG link index.html declares")
      .toMatch(/querySelector<HTMLLinkElement>\(\s*'link\[rel="icon"\]\[type="image\/svg\+xml"\]'\s*\)/);
    expect(writer, "the tab's write stopped asking for the fallback link index.html declares")
      .toMatch(/querySelector<HTMLLinkElement>\(\s*'link\[rel="icon"\]\[sizes="32x32"\]'\s*\)/);
    expect(writer).toMatch(/\.href = FAVICON_HREF\[next\.icon\]/);
    expect(writer).toMatch(/\.href = FAVICON_FALLBACK_HREF\[next\.icon\]/);
  });

  it("never lets the ICO fallback outrank the SVG the state is written to", () => {
    // Measured in Chrome 154 on 2026-10-01, from the icon Chrome stored for
    // the page: with the ICO declared `sizes="any"` the tab shows the ICO, and
    // still shows it after the SVG link's href is rewritten, so every state
    // change is lost without a word. Declared at its real 32x32, the ICO stays
    // a fallback: the tab shows the SVG and follows each write to it. The kit's
    // snippet says 32x32 too since its 1.1.
    const ico = iconLinks.find(tag => /\bhref="\/favicon\.ico"/.test(tag));
    expect(ico, "index.html no longer links the ICO fallback").toBeTruthy();
    expect(ico, "the ICO claims `any` size, and Chromium then shows it over the stateful SVG").not.toMatch(/\bsizes="[^"]*\bany\b/);
    expect(ico).toMatch(/\bsizes="32x32"/);
  });
});

describe("what App.tsx does with it", () => {
  // The tab's DOM write moved to use-tab-ambient.ts, which App.tsx calls; the
  // two are read as one, so a negative here holds in either.
  const app = read("../App.tsx") + "\n" + read("../use-tab-ambient.ts");

  it("compares before it writes, on both surfaces", () => {
    // The effect recomputes on every SSE frame and both counts churn under a
    // title that is standing still — a subagent spawning moves `running` on a
    // deck whose title is plain and whose icon is already blue. Assigning an
    // identical title is a write the browser answers by re-rendering the tab.
    //
    // Matched as a pattern rather than as a line of source (#378). The old form
    // was the exact 62 characters including the trailing semicolon, so wrapping
    // the body in braces — which changes nothing a user or a browser can see —
    // failed it, and a test that fails on a reformat is a test somebody deletes
    // the next time it does. What has to hold is the comparison guarding the
    // write, and that is what this now says: remove either guard and the
    // assignment no longer sits behind a `!==` on its own previous value.
    expect(app, "the tab title is written without comparing it first")
      .toMatch(/if\s*\(\s*prev\?\.title\s*!==\s*next\.title\s*\)\s*\{?\s*document\.title\s*=\s*next\.title\s*;/);
    expect(app, "the favicon href is rewritten without comparing the state first")
      .toMatch(/if\s*\(\s*prev\?\.icon\s*!==\s*next\.icon\s*\)\s*\{/);
  });

  it("counts through the shared module rather than spelling the rule out again", () => {
    // Not style policing. The rule was inline here once, a copy of it was
    // inline in SessionList.tsx and a third copy was inline in THIS file, and
    // #348 reached two of the three — which is how the suite ended up
    // certifying the counting it was supposed to forbid. One call site per
    // surface, one definition, and the cases below exercise the definition.
    expect(app, "App.tsx counts blocked sessions inline again")
      .toContain("blockedSessions(stateRef.current.agents.values())");
    expect(app, "App.tsx counts running sessions inline again")
      .toContain("runningSessionCount(stateRef.current.agents.values())");
    // The counts are derived per frame from the map the canvas draws from.
    // pruneOldAgents evicts agents outright, so a tally maintained alongside it
    // would outlive the thing it was counting; the eviction case below proves
    // the behaviour, and this keeps a tally from creeping back in beside it —
    // or into the topbar's readout group, which shows the waiting count and
    // moved out of App.tsx to components/TopbarReadouts.tsx.
    expect(app + "\n" + read("../components/TopbarReadouts.tsx")).not.toMatch(/set(Waiting|Running)Count/);
  });

  it("hands the signal the connection, and re-runs when it changes", () => {
    // Two halves, and the second is the one that goes missing silently (#719).
    // Passing `connected` without adding it to the dependency array gives an
    // effect that reads the flag once and never again: the deck drops its
    // stream, the counts stop moving because nothing is arriving, so nothing in
    // the array changes, so the effect never re-runs and the tab keeps whatever
    // mark it was wearing. That is the exact failure the offline state exists
    // to fix, reintroduced by an omission a reviewer's eye slides over.
    expect(app, "ambientSignal is no longer told whether the stream is alive")
      .toMatch(/ambientSignal\(\s*\{[^}]*connected:\s*live[^}]*\}\s*\)/);
    expect(app, "the ambient effect does not re-run when the connection changes")
      .toMatch(/\}\s*,\s*\[\s*waitingSessions\.length\s*,\s*runningSessions\s*,\s*live\s*\]\s*\)/);
  });
});

// ── the counts, driven through the reducer ──────────────────────────────────
//
// The two numbers the signal is given come from the agents map, and the map is
// the thing that forgets. These cases are the edges #338 named — an evicted
// session must not leave a phantom in the title, and a replay must land on the
// truth rather than on the sum of what it replayed — plus the one #348 added,
// which is that only a permission block is an alarm at all.
//
// Real hook payloads through the real reducer into the real counters, so the
// whole path from "CC sent a notification" to "the tab says (1) ccdeck" is
// pinned end to end and no step of it is a restatement of another step.

const PERMISSION = { notification_type: "permission_prompt", message: "Claude needs your permission" };
const IDLE = { notification_type: "idle_prompt", message: "Claude is waiting for your input" };

let seq = 0;
function send(state: GraphState, session: string, payload: HookPayload, receivedAt?: number): GraphState {
  seq++;
  const env: HookEnvelope = {
    seq,
    receivedAt: receivedAt ?? 1_000 + seq,
    source: "hook",
    payload: { session_id: session, ...payload },
  };
  return applyEvent(state, env);
}

/** What App.tsx's two memos compute — by calling them, not by restating them.
 *
 *  This used to be a hand-written loop under the comment "exactly what App.tsx's
 *  two memos compute", and the comment was true when it was written and false
 *  ten commits later: #348 narrowed the alarm to permission blocks in App.tsx
 *  and SessionList.tsx, and a mirror nobody knew to update went on counting
 *  every block. A mirror is a promise the compiler does not check, so there is
 *  no mirror any more — `blockedSessions` and `runningSessionCount` here are the
 *  functions the app itself runs, which makes reverting the rule a change these
 *  cases fail on rather than one they bless. */
function counts(state: GraphState): { waiting: number; running: number } {
  return {
    waiting: blockedSessions(state.agents.values()).length,
    running: runningSessionCount(state.agents.values()),
  };
}

describe("the counts the signal is handed", () => {
  it("follows a session from started to blocked to answered", () => {
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    expect(ambientSignal(counts(state))).toEqual({ title: PRODUCT, icon: "running" });

    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
    expect(ambientSignal(counts(state))).toEqual({ title: `(1) ${PRODUCT}`, icon: "waiting" });

    // Answering it is the case that matters: a count that only goes up is the
    // classic failure here, and the icon has to fall back to running rather
    // than to idle because the session is still mid-turn.
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "yes" });
    expect(ambientSignal(counts(state))).toEqual({ title: PRODUCT, icon: "running" });

    state = send(state, "s1", { hook_event_name: "Stop" });
    expect(ambientSignal(counts(state))).toEqual({ title: PRODUCT, icon: "idle" });
  });

  it("counts each blocked session once and adds them up", () => {
    seq = 0;
    let state = initialState();
    for (const s of ["s1", "s2", "s3"]) {
      state = send(state, s, { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    }
    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
    state = send(state, "s2", { hook_event_name: "Notification", ...PERMISSION });
    expect(ambientSignal(counts(state)).title).toBe(`(2) ${PRODUCT}`);
  });

  it("says nothing at all for a session that merely ended its turn", () => {
    // #348, and the case this file used to assert the opposite of. CC sends an
    // idle_prompt about a minute after Stop on every session that finishes and
    // is not picked straight back up, which on the log #348 was measured
    // against outnumbered permission prompts 16 to 5 — so counting it lit the
    // title and the favicon amber for roughly three quarters of the time they
    // were lit at all, over sessions whose nodes already read `done`. Three
    // surfaces worth having only while they are rare.
    seq = 0;
    let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/repo" });
    state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
    state = send(state, "s1", { hook_event_name: "Stop" }, 3_000);
    state = send(state, "s1", { hook_event_name: "Notification", ...IDLE }, 4_000);
    expect(ambientSignal(counts(state))).toEqual({ title: PRODUCT, icon: "idle" });
    // Not a claim that the block was dropped: it is on the root, it prints on
    // the card and it sorts the sidebar above the running rows. It just does
    // not shout, and this asserts both halves so a fix that quiets idle by
    // discarding it fails here.
    expect(state.agents.get("s1")?.waiting?.kind).toBe("idle");
  });

  it("adds up only the permission blocks when both kinds are on the board", () => {
    // The mixed board is the one that separates "counts the right kind" from
    // "counts nothing", and a suite that only ever shows it one kind at a time
    // passes under either mistake.
    seq = 0;
    let state = initialState();
    for (const s of ["s1", "s2", "s3"]) {
      state = send(state, s, { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    }
    state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
    state = send(state, "s2", { hook_event_name: "Notification", ...IDLE });
    state = send(state, "s3", { hook_event_name: "Notification", ...IDLE });
    expect(counts(state).waiting).toBe(1);
    expect(ambientSignal(counts(state))).toEqual({ title: `(1) ${PRODUCT}`, icon: "waiting" });
  });

  it("leaves no phantom in the title when an old session is evicted", () => {
    // Two finished sessions, each sitting on a permission prompt raised before
    // the turn ended — done, blocked, and therefore both counted AND evictable.
    // pruneOldAgents drops the oldest out of the map once it is over cap, so a
    // title kept as a running tally would report a session that is no longer
    // anywhere on the canvas, with nothing left to click through to.
    //
    // Stop lands BEFORE the notification so the roots keep `state: "done"` and
    // an `endedAt`, which is what makes them prunable at all — Notification does
    // not touch either field, so the block rides on a finished session the way
    // an unanswered prompt does when the human walks away mid-turn. The kind is
    // orthogonal to the eviction property being tested here; it is permission
    // because permission is what the count is of, and a case built on idle
    // proves nothing about a counter that correctly ignores idle.
    seq = 0;
    let state = initialState();
    for (const s of ["s1", "s2"]) {
      state = send(state, s, { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, s, { hook_event_name: "UserPromptSubmit", prompt: "go" });
      state = send(state, s, { hook_event_name: "Stop" }, 3_000);
      state = send(state, s, { hook_event_name: "Notification", ...PERMISSION }, 4_000);
    }
    expect(ambientSignal(counts(state))).toEqual({ title: `(2) ${PRODUCT}`, icon: "waiting" });

    expect(pruneOldAgents(state, 1_000_000, 1, 0)).toBe(true);
    expect(state.agents.size).toBe(1);
    expect(ambientSignal(counts(state)).title).toBe(`(1) ${PRODUCT}`);
  });

  it("lands on the truth after a replay, not on the sum of it", () => {
    // The SSE stream reconnects and replays from the log. The same block
    // arriving twice is one block, and a block that cleared while the tab was
    // disconnected has to come back cleared.
    seq = 0;
    const replay = (upTo: number) => {
      let state = send(initialState(), "s1", { hook_event_name: "SessionStart", cwd: "/repo" });
      state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "go" });
      state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
      if (upTo > 0) state = send(state, "s1", { hook_event_name: "Notification", ...PERMISSION });
      if (upTo > 1) state = send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "yes" });
      return state;
    };
    expect(ambientSignal(counts(replay(1))).title).toBe(`(1) ${PRODUCT}`);
    expect(ambientSignal(counts(replay(2))).title).toBe(PRODUCT);
  });
});
