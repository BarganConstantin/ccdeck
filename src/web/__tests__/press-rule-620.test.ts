// #518 wrote the rule down in panel-press.ts and applied it to the accounts
// panel. #620 found it had been applied there and nowhere else: nine primary
// controls elsewhere in the deck still set a flag, let the flag reach
// `disabled` on the control the press had just come from, and dropped keyboard
// focus to `<body>`. The topbar sound switch, the version banner's Restart now,
// Update now and Update & restart, the usage panel's ↻, the usage-history ↻ and
// its Try again, and the add-account dialog's Continue and Import.
//
// Three of those are inside a modal and partly self-heal — useModalDismiss's
// trap sees `index < 0` for a body-focused element and sends the next Tab to
// `stops[0]`, which is the dialog's FIRST control and not where the reader was.
// The other six have no trap at all and nothing brings focus back.
//
// The point of this file is not the nine. It is the tenth: a scan over every
// .tsx under src/web that fails on any `disabled=` a busy flag reaches, so a
// control written next year cannot re-introduce the defect quietly. The nine
// are pinned individually as well, because a sweep that goes red says "somebody
// broke the rule" and a named site says where.
//
// No DOM, as everywhere else in this suite: the rule itself is pure functions
// in panel-press.ts, and the markup half is read as text.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pressAccepted, pressState, selfPressAccepted, selfPressProps } from "../panel-press";
import { lineOf, openTags, withoutComments } from "./tsx-scan";

// ── the sources, with comments blanked ──────────────────────────────────────

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** Every .tsx under src/web, tests excluded. A list rather than four names, so
 *  a component added later is swept without anybody remembering to add it. */
function tsxFiles(dir = WEB, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...tsxFiles(`${dir}/${entry.name}`, rel));
    else if (entry.name.endsWith(".tsx")) out.push(rel);
  }
  return out.sort();
}

// Comments go first, through the suite's own scanner rather than a second one:
// #513 is the whole argument for that, and this file would meet the same hazard
// — AccountsPanel.tsx quotes `disabled={reloading}` inside the comment
// explaining why it no longer says that, and a scan that read comments would
// fail on the explanation. `withoutComments` keeps every newline, so a line
// number computed on the result is the line number in the file.
const SOURCES = tsxFiles().map(rel => {
  const raw = readFileSync(`${WEB}/${rel}`, "utf8");
  return { rel, raw, code: withoutComments(raw) };
});

const lineText = (raw: string, line: number) => raw.split("\n")[line - 1] ?? "";

/** The whole of one `attr={…}` value, brace-balanced rather than up to the
 *  first `}` — an expression containing an object or a nested JSX brace would
 *  otherwise be read half-way and silently pass. */
function valueAt(code: string, open: number): { expr: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return { expr: code.slice(open + 1, i), end: i };
  }
  return null;
}

interface Site { rel: string; line: number; expr: string; text: string; }

/** Every `disabled={…}` in the client, wherever it is. */
function disabledSites(): Site[] {
  const out: Site[] = [];
  for (const { rel, raw, code } of SOURCES) {
    for (const m of code.matchAll(/disabled=\{/g)) {
      const open = m.index! + "disabled=".length;
      const value = valueAt(code, open);
      expect(value, `${rel}: unbalanced braces after disabled=`).not.toBeNull();
      const line = lineOf(code, m.index!);
      out.push({ rel, line, expr: value!.expr.replace(/\s+/g, " ").trim(), text: lineText(raw, line) });
    }
  }
  return out;
}

/** Every argument list of a `selfPressProps(…)` call. */
function selfPressCalls(): Array<Site & { args: string }> {
  const out: Array<Site & { args: string }> = [];
  for (const { rel, raw, code } of SOURCES) {
    for (const m of code.matchAll(/selfPressProps\(/g)) {
      let depth = 0, end = -1;
      for (let i = m.index! + m[0].length - 1; i < code.length; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")" && --depth === 0) { end = i; break; }
      }
      expect(end, `${rel}: unbalanced parens in selfPressProps(`).toBeGreaterThan(-1);
      const line = lineOf(code, m.index!);
      const args = code.slice(m.index! + m[0].length, end).replace(/\s+/g, " ").trim();
      out.push({ rel, line, expr: args, args, text: lineText(raw, line) });
    }
  }
  return out;
}

/**
 * The second argument of a call, split at the top-level comma.
 *
 * By hand rather than by `split(",")`: `selfPressProps(busy, !code.trim() ||
 * login.state === "registering")` has a comma-free second argument but the
 * first one need not, and a call with `{ a: 1, b: 2 }` in it would be cut in
 * the wrong place.
 */
function secondArg(args: string): string | null {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) return args.slice(i + 1).trim();
  }
  return null;
}

/**
 * The names a request-in-flight flag goes by in this codebase, as a substring
 * match rather than a word one: `soundBusy`, `anyLoading` and `quotaLoading`
 * have no word boundary in front of the flag word.
 *
 * This is the sweep's one soft edge and it is worth saying out loud: a flag
 * called something else entirely — `armed`, `sent`, `phase !== "idle"` — is a
 * press lock this list cannot see. What it does catch is every spelling the
 * deck actually uses, which is what the nine were.
 */
const INFLIGHT = /busy|loading|refreshing|restarting|running|saving|sending|submitting|pending|working|waiting|inflight/i;

// ── the rule, as arithmetic ─────────────────────────────────────────────────

describe("the boolean spelling is the tagged rule, not a second one", () => {
  it("never lets a control's own request reach its `disabled`", () => {
    expect(selfPressProps(false)).toEqual({ disabled: false, "aria-busy": false });
    expect(selfPressProps(true)).toEqual({ disabled: false, "aria-busy": true });
    // The property that closes #620, over every input pair: `inflight` alone
    // never disables anything, whatever else is true.
    for (const inflight of [false, true]) {
      for (const unavailable of [false, true]) {
        const p = selfPressProps(inflight, unavailable);
        expect(p["aria-busy"], `inflight=${inflight}`).toBe(inflight);
        expect(p.disabled, `inflight=${inflight} unavailable=${unavailable}`).toBe(unavailable);
      }
    }
  });

  it("still disables a control that is unavailable for some other reason", () => {
    // The half a busy mechanism must not swallow: an empty field with nothing
    // to submit, an install that has already finished. `:disabled` goes on
    // meaning what it has always meant.
    expect(selfPressProps(false, true)).toEqual({ disabled: true, "aria-busy": false });
    expect(selfPressProps(true, true)).toEqual({ disabled: true, "aria-busy": true });
  });

  it("answers exactly what the tagged pair answers for one control", () => {
    // Not a re-implementation: the same two functions, called with the only tag
    // a one-control surface has.
    for (const inflight of [false, true]) {
      const tagged = pressState(inflight ? "self" : null, "self");
      expect(selfPressProps(inflight)).toEqual({ disabled: tagged.disabled, "aria-busy": tagged.busy });
      expect(selfPressAccepted(inflight)).toBe(pressAccepted(inflight ? "self" : null));
    }
  });

  it("keeps the guard the disabling used to be", () => {
    expect(selfPressAccepted(false)).toBe(true);
    expect(selfPressAccepted(true)).toBe(false);
  });
});

// ── the sweep ───────────────────────────────────────────────────────────────

describe("no control in the client disables itself on press (#620)", () => {
  it("sweeps every .tsx, not the four the report happened to name", () => {
    // Cheap, and the reason the sweep is worth more than the nine fixes: if
    // this ever reads 0 or 1 the walk has stopped finding the components and
    // every assertion below is passing vacuously.
    const files = SOURCES.map(s => s.rel);
    expect(files.length).toBeGreaterThanOrEqual(15);
    for (const named of ["App.tsx", "components/UsagePanel.tsx", "components/UsageHistoryModal.tsx",
      "components/AddAccountDialog.tsx", "components/AccountsPanel.tsx"]) {
      expect(files, named).toContain(named);
    }
    // And that the scan can actually see markup: `disabled=` still exists in
    // the deck, on the controls that are legitimately unavailable.
    expect(disabledSites().length).toBeGreaterThan(0);
  });

  it("lets no busy flag reach a `disabled`, anywhere", () => {
    const rogue = disabledSites()
      .filter(s => INFLIGHT.test(s.expr))
      // `.ap-fix` in the accounts panel's empty state is the one deliberate
      // exclusion: #518 named it out of scope and row-state-press.test.ts pins
      // it with a written rationale. It is left exactly as it was.
      .filter(s => !(s.rel === "components/AccountsPanel.tsx" && s.text.includes('className="ap-fix"')))
      .map(s => `${s.rel}:${s.line} disabled={${s.expr}}`);
    expect(rogue).toEqual([]);
  });

  it("keeps the pinned exclusion pinned, so removing it is a decision", () => {
    const fix = disabledSites().filter(s => s.rel === "components/AccountsPanel.tsx" && INFLIGHT.test(s.expr));
    expect(fix.map(s => s.expr)).toEqual(["reloading"]);
    expect(fix[0].text).toContain('className="ap-fix"');
  });

  it("does not let the flag move into the second argument instead", () => {
    // The loophole a busy mechanism opens: `selfPressProps(false, busy)` puts
    // the flag straight back on `disabled` while looking like the fix.
    const smuggled = selfPressCalls()
      .map(c => ({ ...c, second: secondArg(c.args) }))
      .filter(c => c.second != null && INFLIGHT.test(c.second!))
      .map(c => `${c.rel}:${c.line} selfPressProps(${c.args})`);
    expect(smuggled).toEqual([]);
  });

  it("makes every surface that drops the disabling take the guard on", () => {
    // Leaving the working control enabled is only half the fix. A file that
    // spreads the props and never refuses a second press has removed a lock
    // and put nothing in its place.
    for (const { rel, code } of SOURCES) {
      if (!code.includes("selfPressProps(")) continue;
      expect(code, `${rel} spreads selfPressProps without guarding a second press`)
        .toMatch(/!selfPressAccepted\(/);
      // Off a ref, never the state: the state a handler closed over is a render
      // old, and the second press happens before the next render.
      for (const m of code.matchAll(/!selfPressAccepted\(([^)]*)\)/g)) {
        expect(m[1], `${rel}: selfPressAccepted(${m[1]}) reads state, not a ref`)
          .toMatch(/Ref\.current/);
      }
    }
  });
});

// ── the nine, one assertion each ────────────────────────────────────────────

/** file, what to look for, and how far past it the spread may be. */
const SITES: Array<[name: string, rel: string, anchor: RegExp, spread: RegExp]> = [
  // #704 took the request out from under this one: the toggle writes a
  // localStorage flag, so there is no in-flight state and nothing to be busy
  // for. It keeps its place in this list rather than leaving it, because the
  // rule is about what the control does to itself under a press and the answer
  // has to stay "nothing" — a future handler that reintroduces a request must
  // not reintroduce `disabled={...}` with it.
  // #711 turned this from a toggle into a disclosure — the click opens the
  // sound menu — and that makes the rule matter MORE here, not less. A
  // disclosure that disabled itself under its own press would drop focus off
  // the very control the popover's Escape is supposed to hand focus back to, so
  // the user would land on `<body>` with the menu gone. The anchor moves with
  // the handler; the two attributes it must carry do not.
  ["the topbar sound-menu button", "App.tsx",
    /onClick=\{\(\) => setSoundMenuOpen\(o => !o\)\}/,
    /\{\.\.\.selfPressProps\(false\)\}/],
  ["the version banner's Restart now", "App.tsx",
    /onClick=\{\(\) => askRestart\(\)\}/,
    /\{\.\.\.selfPressProps\(restarting\)\}/],
  ["the version banner's Update now", "App.tsx",
    /onClick=\{startUpgrade\}/,
    /\{\.\.\.selfPressProps\(upgradeState === "running", upgradeState === "done"\)\}/],
  ["the version banner's Update & restart", "App.tsx",
    /onClick=\{\(\) => askRestart\(\{ upgrade: true \}\)\}/,
    /\{\.\.\.selfPressProps\(restarting\)\}/],
  ["the usage panel's ↻", "components/UsagePanel.tsx",
    /className="glyph-btn up-refresh-btn"/,
    /\{\.\.\.selfPressProps\(anyLoading\)\}/],
  ["the usage-history ↻", "components/UsageHistoryModal.tsx",
    /className="glyph-btn uh-reload"/,
    /\{\.\.\.selfPressProps\(loading\)\}/],
  ["the usage-history Try again", "components/UsageHistoryModal.tsx",
    /className="btn uh-retry"/,
    /\{\.\.\.selfPressProps\(loading\)\}/],
  ["the add-account Continue", "components/AddAccountDialog.tsx",
    /onClick=\{submitCode\}/,
    /\{\.\.\.selfPressProps\(busy, !code\.trim\(\) \|\| login\.state === "registering"\)\}/],
  ["the add-account Import", "components/AddAccountDialog.tsx",
    /onClick=\{submitBlob\}/,
    /\{\.\.\.selfPressProps\(busy, !blob\.trim\(\)\)\}/],
];

describe("each of the nine, by name", () => {
  it("is nine sites and no fewer", () => {
    expect(SITES.length).toBe(9);
  });

  for (const [name, rel, anchor, spread] of SITES) {
    it(`${name} stays focusable while its own request is out`, () => {
      const src = SOURCES.find(s => s.rel === rel);
      expect(src, rel).toBeDefined();
      // openTags, not a `<`…`>` slice: the `>` in `onClick={() => askRestart()}`
      // is not the end of the tag, which is the whole of #378 and #513.
      const tags = openTags(src!.raw, ["button"]).filter(t => anchor.test(t.attrs));
      expect(tags.length, `${name}: the anchor matches ${tags.length} tags in ${rel}, not 1`).toBe(1);
      const tag = tags[0];
      expect(tag.ranAway, `${name} (${rel}:${tag.line}): the tag scan ran away`).toBe(false);
      expect(tag.attrs.replace(/\s+/g, " "),
        `${name} (${rel}:${tag.line}) does not take the two attributes`).toMatch(spread);
      expect(tag.attrs,
        `${name} (${rel}:${tag.line}) still writes its own disabled=`).not.toMatch(/disabled=/);
    });
  }
});

// ── the guards that replaced the disabling ──────────────────────────────────

describe("a second press is refused by the handler, not by the browser", () => {
  const codeOf = (rel: string) => SOURCES.find(s => s.rel === rel)!.code;

  it("needs no lock on the sound switch, because the press no longer leaves the tab", () => {
    // This used to pin a busy ref shared by two writers posting to
    // /api/sound-hook. #704 deleted the endpoint: the toggle flips a flag and
    // writes localStorage, both synchronous, so a double press is idempotent
    // rather than racy. The assertion is that the lock is GONE — a re-added
    // request without a re-added guard is the regression this now watches for.
    const app = codeOf("App.tsx");
    expect(app).not.toMatch(/soundBusyRef/);
    expect(app).not.toMatch(/setSoundBusy/);
    expect(app, "the toggle must stay synchronous").toMatch(/const toggleSound = useCallback\(\(\) => \{/);
    expect(app).not.toMatch(/fetch\("\/api\/sound-hook"/);
  });

  it("holds one restart ask at a time", () => {
    // This guard predates #620 — it was `if (restartAskedRef.current) return`.
    // What changed is that it is now the ONLY thing refusing the second press.
    expect(codeOf("App.tsx")).toMatch(/if \(!selfPressAccepted\(restartAskedRef\.current\)\) return;/);
  });

  it("holds one upgrade at a time, across the gap before the poll answers", () => {
    const app = codeOf("App.tsx");
    // `running` is the server's answer and does not arrive until the next
    // /api/version, so the ref covers the window in which nothing else says a
    // run started — and is released once the poll has been awaited.
    expect(app).toMatch(/if \(!selfPressAccepted\(upgradeAskedRef\.current \|\| upgradeState === "running"\)\) return;/);
    expect(app).toMatch(/await loadVersion\(\);\s*\n\s*upgradeAskedRef\.current = false;/);
    expect(app).toMatch(/return fetch\(force \? "\/api\/version\?refresh=1" : "\/api\/version"\)/);
  });

  it("holds one forced quota read at a time, per hook, and never blocks the poll", () => {
    const panel = codeOf("components/UsagePanel.tsx");
    // Both hooks, and both gated on `forceRefresh`: a poll is not a press and
    // must not be refused by one.
    expect([...panel.matchAll(/if \(forceRefresh && !selfPressAccepted\(busyRef\.current\)\) return;/g)].length).toBe(2);
    expect([...panel.matchAll(/const busyRef = useRef\(false\);/g)].length).toBe(2);
  });

  it("holds one forced ccusage run at a time, and hands the lock to the newest request", () => {
    const modal = codeOf("components/UsageHistoryModal.tsx");
    expect(modal).toMatch(/if \(force && !selfPressAccepted\(busyRef\.current\)\) return;/);
    // `busyRef.current = force`, not `= true`: a range change starts an
    // unforced load that supersedes the forced one, whose `finally` will not
    // run under `isCurrent` any more. Without this the ↻ would stay dead for
    // the life of the modal.
    expect(modal).toMatch(/const isCurrent = guard\.begin\(\);\s*\n\s*busyRef\.current = force;/);
    expect(modal).toMatch(/if \(isCurrent\(\)\) \{ busyRef\.current = false; setLoading\(false\); \}/);
  });

  it("holds one admin call at a time in the add-account dialog", () => {
    const dialog = codeOf("components/AddAccountDialog.tsx");
    // start, submitCode, submitBlob and — since #723 — the "update anyway" on
    // an import result row: one `busy`, one lock, four writers. The fourth is
    // why the count is here rather than left implied: it ran without touching
    // `busy` at first, which left the Import button on the paste form looking
    // idle while refusing every press.
    expect([...dialog.matchAll(/if \(!selfPressAccepted\(busyRef\.current\)\) return;/g)].length).toBe(4);
    expect([...dialog.matchAll(/busyRef\.current = false;\s*\n\s*setBusy\(false\);/g)].length).toBe(4);
  });
});
