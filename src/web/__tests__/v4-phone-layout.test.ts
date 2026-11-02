// The phone at 640 and under: Sessions is the home screen, a row opens that
// session's pane (or the Inspector), and Usage, This machine, the Inspector and
// Accounts are one sheet at a time over it. Layout only: no panel, key or
// request is new, so what is pinned here is where things sit and which existing
// path each one takes.
//
// Rules are read from the sheets by name, and held inside the phone query: a
// phone rule that leaks out of @media (max-width: 640px) would move the desktop.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OfflineCard, UNREACHABLE_SUB_MSG, lastNewsTime, unreachableSub } from "../components/ConnectionBanner";
import { en as englishCatalog } from "../i18n/en";

// CHANGED ON PURPOSE (the UI in every language): the sentence is read through
// its key now, and the English catalog holds the words.
const UNREACHABLE_SUB = englishCatalog[UNREACHABLE_SUB_MSG];
import PhoneKeys, { PHONE_KEYS, pressBegins, pressEnds } from "../components/terminal/PhoneKeys";
import {
  CLOSE_SHARE, DRAG_SLOP_PX, FLICK_SPEED, GRAB_ZONE_PX, MIN_FLICK_PX, SHEET_NAMES,
  accountsGivesPaneBack, dragOffset, dragStarts, pressSessionsDoor, releaseCloses, sheetCloseMs, sheetEase, sheetFadeMs, sheetOpenMs,
  sheetToKeep, topSheet,
  type SheetFlags,
} from "../phone-sheet";
import { PHONE_BAR_H, PHONE_HEAD_H, PHONE_KEYS_H } from "../stage-geometry";

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (s: string) => s.replace(/\s+/g, "");
const PHONE = "@media (max-width: 640px) {";

/** The [start, end) of every top-level block opened by `header`, braces matched. */
function blocksOf(css: string, header: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let at = css.indexOf(header); at >= 0; at = css.indexOf(header, at + 1)) {
    let depth = 0;
    for (let i = at + header.length - 1; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out.push([at, i + 1]); break; }
    }
  }
  return out;
}
const phoneOf = (css: string) => blocksOf(css, PHONE).map(([a, b]) => css.slice(a, b)).join("\n");
/** The sheet less every media block: what the desktop is, before any query. */
function outsideMedia(css: string): string {
  let out = css;
  for (const [a, b] of blocksOf(css, "@media").reverse()) out = out.slice(0, a) + out.slice(b);
  return out;
}

describe("the deck opens on Sessions, full width, with no panel open", () => {
  const left = read("use-left-column.ts");
  const right = read("use-right-panels.ts");

  it("a phone load opens the list whatever was stored, without writing that over the desktop's choice", () => {
    expect(left).toMatch(/if \(loadsOnPhone\(\)\) \{ phoneOpenedRef\.current = !wanted; return true; \}/);
    expect(left).toMatch(/if \(phoneOpenedRef\.current\) \{ phoneOpenedRef\.current = false; return; \}/);
  });

  it("Accounts, Usage and This machine wait for their doors on a phone, and the stored flags are untouched", () => {
    expect(left).toMatch(/if \(wanted && loadsOnPhone\(\)\) \{ accountsHeldRef\.current = true; return false; \}/);
    expect(right).toMatch(/if \(wanted && loadsOnPhone\(\)\) \{ usageHeldRef\.current = true; return false; \}/);
    expect(right).toMatch(/if \(wanted && loadsOnPhone\(\)\) \{\s*machineHeldRef\.current = true;/);
  });

  it("opening Accounts on a phone does not take the list's place, and the list does not evict it", () => {
    expect(left.match(/!loadsOnPhone\(\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the Sessions panel is the width of the screen between the top bar and the dock", () => {
    const css = strip(read("styles/left-column.css"));
    expect(phoneOf(css)).toContain(".left-column:not(.closing) { width: 100vw; }");
    const shell = strip(read("styles/phone-sheet.css"));
    expect(phoneOf(shell)).toContain(":root:root { --topbar-h: 50px; }");
    expect(phoneOf(strip(read("styles/edge-rails.css")))).toContain("--dock-h: 58px");
  });
});

describe("a row opens the session's pane when the deck has a terminal for it, else the Inspector", () => {
  const app = read("App.tsx");
  const pick = app.slice(app.indexOf("const pickSession"), app.indexOf("// Back from the pane"));

  it("with the Command Panel on, a phone row opens the pane and gives the screen to it", () => {
    expect(pick).toContain("if (phone && stage.enabled)");
    expect(pick).toContain("openInPane(sessionId)");
    expect(pick).toContain("closeSessionListToCanvas()");
  });

  it("without one it is the Inspector, a sheet, and the list stays under it", () => {
    expect(pick).toMatch(/openSession\(sessionId\);\s*\}, \[/);
    expect(pick.indexOf("openSession(sessionId)")).toBeGreaterThan(pick.indexOf("return;"));
    expect(pick).not.toMatch(/openSession\(sessionId\);\s*if \(phone\)/);
  });

  it("leaving the pane brings Sessions back", () => {
    expect(app).toMatch(/if \(back && !sessionListOpen\) toggleSessionList\(\)/);
  });

  it("no Workspace switch is drawn on a phone, and no Chat | Term switch is in the pane header", () => {
    expect(app).toContain("{!phone && stage.workspaceOffered && <ViewSwitch");
    expect(read("components/terminal/TerminalStage.tsx")).not.toMatch(/view=\{\s*\{/);
  });
});

describe("the pane's header and footer as the phone frame draws them", () => {
  const stage = strip(read("styles/stage-shell.css"));
  const phone = squash(phoneOf(stage));

  it("a header 56 high with a back 32 by 44, the title in two rows, and the ⋯ at a 44 target", () => {
    expect(PHONE_HEAD_H).toBe(56);
    expect(phone).toContain(squash(".ts-stage[data-takeover] .ts-head { height: 56px; }"));
    expect(phone).toContain(squash(".ts-stage[data-takeover] .ts-head > .glyph-btn { width: 32px; height: 44px; }"));
    expect(phone).toContain(squash("padding: 0 12px 0 4px;"));
    expect(phone).toContain(squash(".ts-stage[data-takeover] .ts-id > .ts-name { grid-column: -2; grid-row: 1; }"));
    expect(phone).toContain(squash(".ts-stage[data-takeover] .ts-id > .ts-meta { grid-column: -2; grid-row: 2; }"));
    expect(phone).toContain(squash("width: 44px; height: 44px;"));
  });

  it("the three 24px controls are in the ⋯ menu, not gone", () => {
    const header = read("components/terminal/StageHeader.tsx");
    expect(phone).toContain(squash(".ts-stage[data-takeover] .ts-ctl { display: none; }"));
    expect(header).toContain("...(p.canType ? [{ id: \"keys\", label: keysLabel, run: p.onKeys }] : [])");
    expect(header).toContain("{ id: \"expand\", label: expandLabel, run: p.onExpand }");
    expect(header).toContain("{ id: \"close\", label: closeLabel, run: p.onClose }");
  });

  it("the note is --bg-soft under a --line-soft rule, and the key row under it is 55 high", () => {
    expect(PHONE_BAR_H).toBe(52);
    expect(PHONE_KEYS_H).toBe(55);
    expect(phone).toContain(squash(".ts-stage[data-takeover] .ts-bar { background: var(--bg-soft); border-top: 1px solid var(--line-soft); }"));
    const row = phone.slice(phone.indexOf(squash(".ts-stage[data-takeover] .ts-keyrow {")));
    expect(row).toContain("height:55px;");
    expect(row).toContain("gap:6px;");
    expect(row).toContain("padding:8px;");
    expect(row).toContain("border-top:1pxsolidvar(--line);");
  });

  it("each key is 38 high with the frame's radius, fill and edge, a 44 target, and presses on the way down", () => {
    expect(phone).toContain(".ts-key{flex:110;min-width:0;height:38px;}");
    // The look is the key's own, outside the query (the row is not drawn there at all):
    // the frame's literal 7 is held to the radius ladder as --r-panel (8).
    const own = squash(outsideMedia(stage));
    expect(own).toContain("border-radius:var(--r-panel);");
    expect(own).toContain("background:var(--bg-soft);");
    expect(own).toContain("color:var(--text-secondary);");
    expect(phone).toContain(squash(".ts-key::after { content: \"\"; position: absolute; inset: -3px 0; }"));
    expect(phone).toContain(squash(".ts-key:active:not(:disabled) { transform: scale(var(--press)); background: var(--selected); color: var(--text); }"));
  });

  it("the key row and the ⋯ are drawn at a phone's width only", () => {
    const outside = squash(outsideMedia(stage));
    expect(outside).toContain(squash(".ts-keyrow { display: none; }"));
    expect(outside).toContain(squash(".ts-head > .ts-more.glyph-btn { display: none; }"));
    expect(outside).not.toContain("height:55px");
    expect(outside).not.toContain("height:38px");
  });
});

describe("the key row sends through the pane's existing terminal input", () => {
  const buttons = (el: ReactElement<{ children: ReactElement<{ onClick(): void; disabled: boolean; "aria-label": string; "data-key": string }>[] }>) =>
    el.props.children;

  it("six keys, left to right, as the bytes a terminal sends for them", () => {
    expect(PHONE_KEYS.map(k => k.cap)).toEqual(["Esc", "Tab", "↑", "↓", "Ctrl+C", "⏎"]);
    expect(PHONE_KEYS.map(k => k.bytes)).toEqual(["\x1b", "\t", "\x1b[A", "\x1b[B", "\x03", "\r"]);
  });

  it("a press hands its bytes to onKey, and nothing else", () => {
    const sent: string[] = [];
    const tree = PhoneKeys({ canType: true, onKey: b => sent.push(b) }) as ReactElement<never>;
    const keys = buttons(tree as never);
    keys.forEach(k => k.props.onClick());
    expect(sent).toEqual(PHONE_KEYS.map(k => k.bytes));
  });

  it("while the pane cannot take keys they are disabled, and the row is hidden with the bar when there is no pane", () => {
    const tree = PhoneKeys({ canType: false, onKey: () => {} }) as ReactElement<never>;
    expect(buttons(tree as never).every(k => k.props.disabled)).toBe(true);
    const hidden = renderToStaticMarkup(createElement(PhoneKeys, { canType: true, paneless: true, onKey: () => {} }));
    expect(hidden).toContain("hidden");
    expect(renderToStaticMarkup(createElement(PhoneKeys, { canType: true, onKey: () => {} }))).not.toContain("hidden");
  });

  it("a press does not take the focus off the terminal", () => {
    const markup = read("components/terminal/PhoneKeys.tsx");
    // CHANGED ON PURPOSE (the phone layout): the pointerdown also notes whether
    // the terminal holds the focus (the click may find it already gone); it
    // still cancels the focus change.
    expect(markup).toContain("onPointerDown={e => { pressBegins(holdsFocus); keepFocus(e); }}");
    expect(markup).toContain("e.preventDefault()");
  });

  it("the focus the terminal held when the press began is what the key is sent with, at the click", () => {
    const sent: Array<[string, boolean | undefined]> = [];
    const onKey = (b: string, held?: boolean) => { sent.push([b, held]); };
    // Pointer: the terminal holds the focus at pointerdown; by the click it has gone.
    let focus = true;
    pressBegins(() => focus);
    focus = false;
    pressEnds(onKey, "\t");
    // Pointer, the terminal did not hold it.
    pressBegins(() => false);
    pressEnds(onKey, "\t");
    // A click with no start seen (a click made by other means): unknown.
    pressEnds(onKey, "\t");
    // A press is one: what was noted is spent.
    pressBegins(() => true);
    pressEnds(onKey, "\t");
    pressEnds(onKey, "\t");
    expect(sent).toEqual([["\t", true], ["\t", false], ["\t", undefined], ["\t", true], ["\t", undefined]]);
  });

  it("the row notes the start at pointerdown and at the keydown of a keyboard press, and sends at the click", () => {
    const sent: Array<boolean | undefined> = [];
    const row = PhoneKeys({ canType: true, onKey: (_b, held) => { sent.push(held); }, holdsFocus: () => true }) as ReactElement<never>;
    const first = buttons(row as never)[0] as unknown as {
      props: { onPointerDown(e: unknown): void; onKeyDown(e: { key: string }): void; onClick(): void };
    };
    first.props.onPointerDown({ preventDefault() {} });
    first.props.onClick();
    first.props.onKeyDown({ key: "a" });
    first.props.onClick();
    first.props.onKeyDown({ key: "Enter" });
    first.props.onClick();
    expect(sent, "pointerdown noted it; a letter's keydown does not start a press; Enter does").toEqual([true, undefined, true]);
  });

  it("the row is wired to the session's own input: press() is the terminal's onInput, and no new transport is touched", () => {
    const session = read("use-terminal-session.ts");
    // CHANGED ON PURPOSE (the phone layout): the press is still the terminal's
    // onInput, but an arrow follows the terminal's cursor-key mode and a view
    // scrolled back comes to the bottom, as a typed key does (use-terminal-
    // session.test.ts runs both).
    expect(session).toContain("events.onInput(term?.applicationCursorKeys() ? applicationArrow(bytes) : bytes);");
    expect(read("components/terminal/TerminalStage.tsx")).toContain("onKey={session.press}");
    expect(read("components/terminal/PhoneKeys.tsx")).not.toMatch(/fetch|WebSocket|sendInput|terminal-api|terminal-protocol/);
  });

  it("the rows fitted above the footer count the key row's height", () => {
    const stage = read("components/terminal/TerminalStage.tsx");
    expect(stage).toContain('useDrawnHeight(rootRef, ".ts-bar", p.onBarH, ".ts-keyrow");');
    expect(read("use-stage.ts")).toContain("PHONE_BAR_H + PHONE_KEYS_H");
  });
});

describe("one sheet at a time, closed by Esc or a flick", () => {
  const none: SheetFlags = { accounts: false, usage: false, machine: false, inspector: false };

  it("the four panels are the four sheets", () => {
    expect([...SHEET_NAMES]).toEqual(["accounts", "usage", "machine", "inspector"]);
  });

  it("opening one while another is up keeps the new one; with none new, the one already up", () => {
    expect(sheetToKeep(none, none)).toBeNull();
    expect(sheetToKeep(none, { ...none, usage: true })).toBe("usage");
    expect(sheetToKeep({ ...none, usage: true }, { ...none, usage: true, machine: true })).toBe("machine");
    expect(sheetToKeep({ ...none, usage: true, machine: true }, { ...none, machine: true })).toBe("machine");
  });

  it("the sheet on top is the last in paint order (Accounts, Usage, This machine, the Inspector); with none new, that is the one kept", () => {
    expect(topSheet(none)).toBeNull();
    expect(topSheet({ ...none, accounts: true, usage: true })).toBe("usage");
    expect(topSheet({ ...none, usage: true, machine: true, inspector: true })).toBe("inspector");
    const both = { ...none, accounts: true, usage: true };
    expect(sheetToKeep(both, both), "nothing newly opened: the top one, not the first by name").toBe("usage");
    // The order the page draws them in is the order the rule reads.
    const app = read("App.tsx");
    const at = (needle: string) => app.indexOf(needle);
    expect(at("{phone && accountsNodes}")).toBeLessThan(at("<UsagePanel"));
    expect(at("<UsagePanel")).toBeLessThan(at("<MachinePanel"));
    expect(at("<MachinePanel")).toBeLessThan(app.lastIndexOf("<DetailAside"));
  });

  it("Accounts asked for with a pane up gives the pane back first, on a phone, once, on the render it turns open", () => {
    const base = { phone: true, accountsOpen: true, accountsWasOpen: false, paneOpen: true };
    expect(accountsGivesPaneBack(base)).toBe(true);
    expect(accountsGivesPaneBack({ ...base, phone: false }), "off a phone Accounts is a column").toBe(false);
    expect(accountsGivesPaneBack({ ...base, paneOpen: false }), "no pane to give back").toBe(false);
    expect(accountsGivesPaneBack({ ...base, accountsWasOpen: true }), "already open: not again").toBe(false);
    expect(accountsGivesPaneBack({ ...base, accountsOpen: false }), "closing is not asking").toBe(false);
  });

  // The App's effect cannot be run here, so what it does with the answer is
  // pinned beside the function that is tested.
  it("App asks that function in a layout effect and hands the pane back when it says so", () => {
    const app = read("App.tsx");
    expect(app).toContain("const give = accountsGivesPaneBack({ phone, accountsOpen: accountsPanelOpen, accountsWasOpen: accountsWasOpen.current, paneOpen });");
    expect(app).toContain("if (give) giveRightBack();");
    expect(app).toMatch(/useLayoutEffect\(\(\) => \{\s*const give = accountsGivesPaneBack/);
  });

  it("the L key and Quick Open's Sessions row take the door's path; the doors of the page are mapped for both", () => {
    const app = read("App.tsx");
    expect(app).toContain("toggleSessionList: pressSessionsKey");
    expect(app).toContain("sessionsKeyRef.current = () => pressSessionsDoor({");
    expect(app).toContain("rails: quickRails");
    expect(app).toContain("left: rails.left.map(sessionsDoorUnderSheet),");
    expect(app).toContain("right: rails.right.map(group => group.map(sessionsDoorUnderSheet)),");
    // The door's own press must not call the key's wrapper (it would loop):
    // the rails are built with the plain toggle.
    expect(app).toMatch(/railItems\(\{\s*providers, sessionListOpen, toggleSessionList,/);
  });

  // CHANGED ON PURPOSE (the phone layout): a flick needs the speed AND 12px of
  // downward travel, so a tap whose finger moved a pixel or two in a frame
  // (2px in 16ms is 0.125 px/ms, over the speed) does not close the sheet. The
  // first and last pins below are the ones the old test held; the middle ones
  // are the new rule.
  it("a release closes over 0.11 px/ms once it went 12px down, else past 40% of the height", () => {
    expect(FLICK_SPEED).toBe(0.11);
    expect(MIN_FLICK_PX).toBe(12);
    expect(CLOSE_SHARE).toBe(0.4);
    expect(releaseCloses(30, 400, 30, 100)).toBe(true);
    expect(releaseCloses(30, 400, 10, 100)).toBe(false);
    expect(releaseCloses(161, 400, 1, 100)).toBe(true);
    expect(releaseCloses(159, 400, 1, 100)).toBe(false);
  });

  it("a tap with a little jitter is not a flick: 2px in 16ms never closes, a fast 30px does", () => {
    expect(releaseCloses(2, 400, 2, 16)).toBe(false);
    expect(releaseCloses(11, 400, 11, 16)).toBe(false);
    expect(releaseCloses(12, 400, 12, 16)).toBe(true);
    expect(releaseCloses(30, 400, 30, 100)).toBe(true);
    // Fast but upward is no flick either.
    expect(releaseCloses(-30, 400, -30, 100)).toBe(false);
  });

  it("a press becomes a drag only after 8px of vertical travel, either way", () => {
    expect(DRAG_SLOP_PX).toBe(8);
    expect(dragStarts(0)).toBe(false);
    expect(dragStarts(6)).toBe(false);
    expect(dragStarts(-7.9)).toBe(false);
    expect(dragStarts(8)).toBe(true);
    expect(dragStarts(-8)).toBe(true);
  });

  it("a drag follows the finger 1:1 on the way down and a pull up resists without a stop", () => {
    expect(dragOffset(0)).toBe(0);
    expect(dragOffset(37)).toBe(37);
    expect(Math.abs(dragOffset(-40))).toBeLessThan(40);
    expect(Math.abs(dragOffset(-200))).toBeGreaterThan(Math.abs(dragOffset(-40)));
    expect(Math.abs(dragOffset(-200))).toBeLessThan(24);
  });

  it("opens in 280 ms and closes in 200, both on the stage's curve, from the tokens", () => {
    // CHANGED ON PURPOSE (the phone layout): the times and the curve are read
    // from the tokens at run time (rail-motion.ts motionToken), no longer
    // restated as constants. With no page to read them from they fall back to
    // tokens.css's own values, which this pins to the sheet.
    const tokens = read("styles/tokens.css");
    expect(sheetOpenMs()).toBe(280);
    expect(sheetCloseMs()).toBe(200);
    expect(sheetFadeMs()).toBe(200);
    expect(sheetEase()).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
    expect(tokens).toContain(`--dur-stage-in: ${sheetOpenMs()}ms;`);
    expect(tokens).toContain(`--dur-stage-out: ${sheetCloseMs()}ms;`);
    expect(tokens).toContain(`--dur-base: ${sheetFadeMs()}ms;`);
    expect(tokens).toContain(`--ease-stage: ${sheetEase()};`);
    const motion = read("rail-motion.ts");
    expect(motion).toContain('"--dur-stage-in": "280ms", "--dur-stage-out": "200ms"');
    const phoneSheet = read("phone-sheet.ts");
    expect(phoneSheet).toContain('tokenMs("--dur-stage-in")');
    expect(phoneSheet).toContain('tokenMs("--dur-stage-out")');
    expect(phoneSheet).toContain('motionToken("--ease-stage")');
  });

  it("the sheet is --panel with --r-overlay on its top corners, full width, up from the bottom edge, over a scrim", () => {
    const css = strip(read("styles/phone-sheet.css"));
    const phone = squash(phoneOf(css));
    expect(phone).toContain("background:var(--panel);");
    expect(phone).toContain("border-radius:var(--r-overlay)var(--r-overlay)00;");
    expect(phone).toContain("width:100%;");
    expect(phone).toContain("bottom:var(--sheet-bottom);");
    expect(phone).toContain("transition:transformvar(--dur-stage-in)var(--ease-stage);");
    expect(phone).toContain("transform:translateY(100%)");
    expect(phone).toContain("transition:transformvar(--dur-stage-out)var(--ease-stage);");
    expect(phone).toContain("background:var(--scrim);");
    expect(phone).toContain("width:32px;height:3px;");
  });

  it("reduced motion: no slide, a crossfade", () => {
    const css = strip(read("styles/phone-sheet.css"));
    const reduced = css.slice(css.indexOf("@media (max-width: 640px) and (prefers-reduced-motion: reduce)"));
    expect(squash(reduced)).toContain("transition:opacityvar(--dur-base)var(--ease);");
    expect(squash(reduced)).toContain("transform:none;");
    // CHANGED ON PURPOSE (the phone layout): the crossfade's length is the
    // token, read by sheetFadeMs, and App holds the panel for it.
    expect(read("phone-sheet.ts")).toContain('tokenMs("--dur-base")');
    expect(read("App.tsx")).toContain("sheetFadeMs()");
  });

  it("the Claude | Codex switch does not replay the slide: the starting style exempts the side shown again", () => {
    const css = strip(read("styles/phone-sheet.css"));
    const starting = blocksOf(css, "@starting-style {").map(([a, b]) => squash(css.slice(a, b)));
    expect(starting.length).toBe(2);
    // CHANGED ON PURPOSE (the phone layout): the exemption names a side the
    // switch showed again (data-switched), not every side (data-side), so the
    // sheet's first rise still plays on a deck with both CLIs.
    // Open: the same sheet slide, but the switch's side keeps its place.
    expect(starting[0]).toContain(squash(".app.app.app .accounts-panel[data-switched] { transform: none; }"));
    // Reduced motion: no fade on the switch either.
    expect(starting[1]).toContain(squash(".app.app.app .accounts-panel[data-switched] { transform: none; opacity: 1; }"));
    expect(starting.join("")).not.toContain("accounts-panel[data-side]");
    // Both sides set the mark only after they were hidden once.
    for (const f of ["components/AccountsPanel.tsx", "components/CodexAccountsPanel.tsx"]) {
      expect(read(f)).toContain('if (side === "hidden") wasHidden.current = true;');
      expect(read(f)).toContain('data-switched={wasHidden.current && side !== "hidden" ? "" : undefined}');
    }
    // And the desktop's own exemption is still there, untouched.
    expect(squash(strip(read("styles/left-column.css")))).toContain(squash(".left-column > .accounts-panel[data-side] { opacity: 1; }"));
  });

  it("the Inspector's leaving state is the other sheets', and its box is written once", () => {
    const sheet = squash(strip(read("styles/phone-sheet.css")));
    expect(sheet).toContain(".app.app.app.detail.leaving,");
    const detail = strip(read("styles/detail-panel.css"));
    expect(squash(phoneOf(detail))).not.toContain("position:fixed");
    expect(squash(phoneOf(detail))).not.toContain("--sheet-bottom");
  });

  it("every header of a sheet is part of the grab zone, the Accounts one too", () => {
    const css = strip(read("styles/phone-sheet.css"));
    expect(css).toContain(".up-header, .sd-top, .insp-h, .ap-header { touch-action: none; }");
  });

  it("the four sheets' own containers draw no focus ring for their programmatic focus, on a phone only; the controls inside keep theirs", () => {
    const css = strip(read("styles/phone-sheet.css"));
    const rule = squash(`
      .app.app.app .usage-panel[tabindex="-1"]:focus-visible,
      .app.app.app .sysdetail[tabindex="-1"]:focus-visible,
      .app.app.app .detail[tabindex="-1"]:focus-visible,
      .app.app.app .accounts-panel[tabindex="-1"]:focus-visible { outline: none; }`);
    expect(squash(phoneOf(css))).toContain(rule);
    const outside = blocksOf(css, PHONE).reduceRight((s, [a, b]) => s.slice(0, a) + s.slice(b), css);
    expect(outside, "nothing of it leaks past the phone query").not.toContain("focus-visible");
    // Nothing on a control inside: only the four containers are named.
    expect(squash(phoneOf(css))).not.toMatch(/button[^{]*:focus-visible\{outline:none/);
  });

  it("every sheet carries the handle, and the drag starts on the strip or the header, never on a control", () => {
    for (const file of ["UsagePanel", "MachinePanel", "DetailAside", "Inspector", "AccountsPanel", "CodexAccountsPanel"]) {
      expect(read(`components/${file}.tsx`), file).toContain("<SheetHandle />");
    }
    const hook = read("use-phone-sheets.ts");
    expect(GRAB_ZONE_PX).toBe(44);
    expect(hook).toContain("target.closest(CONTROL)");
    // CHANGED ON PURPOSE (the phone layout): Esc has one owner, the deck's own
    // handler, asked through the dismiss stack the sheet is on while it is up;
    // the hook has no key listener (use-phone-sheets-run.test.ts runs it).
    expect(hook).toContain('modalStack.push(() => dismissRef.current(), 0, "popover")');
    expect(hook).not.toContain('"keydown"');
    expect(hook).toContain("pointerdown");
    expect(strip(read("styles/phone-sheet.css"))).toContain("touch-action: none;");
  });

  it("App asks for the hook with the four panels, and Esc leaves a dialog's Esc to the dialog", () => {
    const app = read("App.tsx");
    expect(app).toContain("usePhoneSheets({");
    expect(app).toMatch(/open: \{ accounts: accountsDrawn && accountsPanelOpen, usage: usageRail\.shown, machine: machineRail\.shown, inspector: detailShown \}/);
    expect(read("use-phone-sheets.ts")).toContain("modalOpenRef?.current || document.querySelector(OVER)");
  });

  it("Accounts is drawn outside the column on a phone, so no stacking layer holds it under the scrim", () => {
    const app = read("App.tsx");
    expect(app).toContain("{phone && accountsNodes}");
    expect(app).toContain("{!phone && accountsNodes}");
  });
});

describe("the offline card is inside Sessions, with the last news time", () => {
  it("the card says when the last news was, in the frame's words, and keeps the plain sentence when none came", () => {
    expect(unreachableSub(null)).toBe(UNREACHABLE_SUB);
    const at = new Date(2026, 10, 2, 14, 2).getTime();
    expect(lastNewsTime(at, at)).toBe("14:02");
    expect(unreachableSub(at, at)).toBe("Agents may still be running. Last news 14:02, so what you see may be old.");
    const out = renderToStaticMarkup(createElement(OfflineCard, { lastNewsAt: at }));
    expect(out).toContain('class="conn-banner conn-banner-phone" role="alert"');
    expect(out).toContain("Last news 14:02");
  });

  it("the list draws it under its header, ahead of the rows, so nothing can cover it", () => {
    const list = read("components/SessionList.tsx");
    expect(list.indexOf("{offline}")).toBeGreaterThan(list.indexOf('className="sl-header"'));
    expect(list.indexOf("{offline}")).toBeLessThan(list.indexOf('<ul className="sl-rows"'));
    const app = read("App.tsx");
    expect(app).toContain("offline={phone && everConnected && !live && !restart.restarting ? <OfflineCard lastNewsAt={lastNewsAt} /> : undefined}");
    expect(read("components/DeckBanner.tsx")).toContain("phone && cardInList && !restarting ? null");
  });

  it("the card sits 14 under the header and 12 in from each side, and the dock's Machine door wears the red dot", () => {
    const banners = strip(read("styles/search-and-banners.css"));
    expect(squash(phoneOf(banners))).toContain(squash(".session-list .conn-banner-phone { flex: none; margin: 14px 12px 0; }"));
    const dock = squash(phoneOf(strip(read("styles/edge-rails.css"))));
    expect(dock).toContain("width:7px;height:7px;border-radius:4px;background:var(--err);");
    expect(read("components/EdgeRails.tsx")).toContain('offlineDot={offline && item.id === "machine"}');
    // CHANGED ON PURPOSE (the phone layout): the last news is the moment the
    // link dropped, taken from the stream's own open and error (last-news.ts).
    const stream = read("use-event-stream.ts");
    expect(stream).toContain("linkRef.current = linkDropped(linkRef.current, Date.now());");
    expect(stream).toContain("setLastNewsAt(linkRef.current.droppedAt);");
    expect(stream).not.toContain("heardRef");
  });
});

describe("the dock has five doors, and the rest are in More", () => {
  const app = read("App.tsx");

  it("Accounts, Sessions, Usage and Machine, then More; Settings and the rest are in More", () => {
    expect(app).toContain("items={[...rails.left, ...rails.right[0]]");
    expect(app).toContain("more={[rails.search, ...rails.capacity, ...rails.right.slice(1).flat(), ...rails.integrations, ...rails.explore, ...rails.utilities]}");
  });

  // CHANGED ON PURPOSE (the phone layout): Sessions reads not pressed while ANY
  // sheet is up over it (the Inspector too), and its press then means "go to
  // Sessions" (the sheet closes, the list stays) instead of toggling the list
  // shut under the sheet.
  it("one door is active at a time: Sessions gives way while a sheet is up over it, and its press then goes to Sessions", () => {
    expect(app).toContain('item.id === "session-list" && sheets.sheet != null');
    expect(app).toContain("{ ...item, open: false, onPress: () => pressSessionsDoor({");
    expect(app).toContain("items={[...rails.left, ...rails.right[0]].map(sessionsDoorUnderSheet)}");
  });

  it("pressing the Sessions door with a sheet up closes the sheet and leaves the list open, never toggling it shut", () => {
    const calls: string[] = [];
    const press = (sheet: "usage" | null, listOpen: boolean) => pressSessionsDoor({
      sheet, listOpen, closeSheet: () => calls.push("closeSheet"), toggleList: () => calls.push("toggleList"),
    });
    press("usage", true);
    expect(calls, "the list is open: only the sheet closes").toEqual(["closeSheet"]);
    calls.length = 0;
    press("usage", false);
    expect(calls, "the list was shut: the sheet closes and Sessions opens").toEqual(["closeSheet", "toggleList"]);
    calls.length = 0;
    press(null, true);
    expect(calls, "no sheet: the door is its plain toggle").toEqual(["toggleList"]);
  });

  it("each door is the dock's whole height, 14px glyphs, the word --muted and --text when active, no fill", () => {
    const dock = squash(phoneOf(strip(read("styles/edge-rails.css"))));
    expect(dock).toContain("padding:12px00;");
    expect(dock).toContain(".rail-btn-dock.glyph{width:14px;height:14px;}");
    expect(dock).toContain(".rail-btn-dock[aria-expanded=\"true\"]{background:transparent;}");
    expect(dock).toContain("align-items:stretch;");
  });

  it("More opens from its trigger corner on Base with the kit's scale", () => {
    const css = strip(read("styles/phone-sheet.css"));
    expect(squash(css)).toContain("transform-origin:rightbottom;animation:dock-more-invar(--dur-base)var(--ease);");
    expect(squash(css)).toContain("@keyframesdock-more-in{from{opacity:0;transform:scale(var(--enter-scale));}}");
    expect(read("components/EdgeRails.tsx")).toContain('className="ap-pop dock-more-pop"');
  });
});

describe("targets are 44", () => {
  it("the dock's cells are the dock's whole height and an equal share of its width", () => {
    const dock = squash(phoneOf(strip(read("styles/edge-rails.css"))));
    expect(dock).toContain("flex:110;");
    expect(dock).toContain("min-height:44px;");
  });

  it("the sheet's header buttons, the Inspector's tabs, the waiting count and the board's controls reach 44 through ::after", () => {
    const sheet = squash(phoneOf(strip(read("styles/phone-sheet.css"))));
    expect(sheet).toContain(".glyph-btn::after{content:\"\";position:absolute;inset:-10px;}");
    expect(sheet).toContain(".insp-tab::after{content:\"\";position:absolute;inset:-12px-2px;}");
    expect(sheet).toContain(".react-flow__controls-button::after{content:\"\";position:absolute;inset:-8px-1px;}");
    const bar = squash(phoneOf(strip(read("styles/topbar.css"))));
    expect(bar).toContain(".topbar.counts.count-pill.waiting-stat::after{content:\"\";position:absolute;inset:-8px-4px;}");
    expect(bar).toContain("align-self:stretch;");
  });

  it("the pane's ⋯ and back are 44 high, and the keys reach 44 over their 38", () => {
    const stage = squash(phoneOf(strip(read("styles/stage-shell.css"))));
    expect(stage).toContain(".ts-head>.glyph-btn{width:32px;height:44px;}");
    expect(stage).toContain("inset:-3px0;");
  });
});

describe("the phone's top bar and empty states", () => {
  it("the wordmark is drawn, 8 beside the mark, and the waiting count is a 28 pill", () => {
    const bar = strip(read("styles/topbar.css"));
    const phone = squash(phoneOf(bar));
    expect(phone).not.toContain("clip-path:inset(50%)");
    expect(phone).toContain(".topbar.brand{gap:8px;}");
    expect(phone).toContain("height:28px;");
  });

  it("the empty-board notice is the width of the panel it is in less 8 a side, and is in the list on a phone", () => {
    const css = squash(phoneOf(strip(read("styles/phone-sheet.css"))));
    expect(css).toContain(".empty-hero.empty-notice{width:calc(100%-16px);}");
    expect(squash(read("App.tsx"))).toContain("{!heroInList&&emptyHero(phone?0:railInsetRef.current)}");
    expect(css).toContain("margin:8px;");
    const list = read("components/SessionList.tsx");
    expect(list).toContain('className="sl-empty sl-empty-notice"');
    expect(read("App.tsx")).toContain("emptyNotice={heroInList ? emptyHero(0) : undefined}");
  });

  it("the Sessions rows are 8 in from each edge and 62 high", () => {
    const list = squash(phoneOf(strip(read("styles/session-list.css"))));
    expect(list).toContain(".session-list.sl-rows{padding-inline:8px;}");
    expect(list).toContain(".session-list.sl-row{min-height:62px;}");
  });

  it("a Sessions row names its session at 14/20 on a phone, 13/20 above it", () => {
    const sheet = strip(read("styles/session-list.css"));
    expect(squash(phoneOf(sheet))).toContain(".session-list.sl-label{font-size:calc(14px+var(--ui-text-increase,0px));}");
    const base = squash(sheet.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, ""));
    expect(base).toMatch(/\.session-list\.sl-label\{[^}]*font-size:calc\(13px\+var\(--ui-text-increase,0px\)\);[^}]*line-height:20px;/);
  });
});

describe("the desktop layout is unchanged: no phone rule is outside the phone query", () => {
  const KEY_LOOK = `.ts-key { position: relative; padding: 0; border: 1px solid var(--line); border-radius: var(--r-panel); background: var(--bg-soft); color: var(--text-secondary); font: 500 12px/16px var(--font-mono); transition: transform var(--dur-fast) var(--ease); }`;
  // CHANGED ON PURPOSE (the phone layout): the old guard let a rule outside the
  // query pass when "display: none" happened to stand within 60 characters
  // before it, so a rule next to a hide passed on its neighbour's account. Now
  // the rules a sheet may carry outside the query are listed, exactly, and each
  // is a hide of a phone-only part. Anything else that names a phone selector
  // outside the query fails.
  const sheets: Array<[string, RegExp[], string[]]> = [
    ["styles/phone-sheet.css", [/phone-scrim/, /sheet-handle/, /dock-more-pop/, /sl-empty-notice/, /\.accounts-panel/, /--topbar-h/],
      [".sheet-handle { display: none; }"]],
    // The key's own look is the one rule that is not a hide: a button's look is
    // not left to a query (control-appearance.test.ts reads it outside), and the
    // row it is in is display: none above 640, so it draws nothing there.
    ["styles/stage-shell.css", [/\.ts-key\b/, /\.ts-more/, /ts-keyrow/],
      [".ts-keyrow { display: none; }", ".ts-head > .ts-more.glyph-btn { display: none; }", KEY_LOOK]],
    ["styles/edge-rails.css", [/rail-offline-dot/], []],
    ["styles/session-list.css", [/\.sl-header\{position:relative/], []],
    ["styles/search-and-banners.css", [/\.session-list\.conn-banner-phone/], []],
  ];

  for (const [path, needles, allowed] of sheets) {
    it(`${path}: what the phone adds is held by the query, and outside it only ${allowed.length === 0 ? "nothing" : "the listed hides"}`, () => {
      for (const rule of allowed) expect(rule, "an allowed rule is a hide (or the key's look)").toSatisfy((r: string) => /\{ display: none; \}$/.test(r) || r === KEY_LOOK);
      const desktop = outsideMedia(strip(read(path)));
      const rules = [...desktop.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selector: m[1].trim(), text: squash(`${m[1]}{${m[2]}}`) }));
      for (const needle of needles) {
        for (const r of rules.filter(r => needle.test(r.text))) {
          expect(allowed.map(squash), `${path}: ${needle} outside the query: ${r.text}`).toContain(r.text);
        }
      }
    });
  }

  it("the More menu's keyframes are used only inside the phone query", () => {
    const css = strip(read("styles/phone-sheet.css"));
    expect(css).toContain("@keyframes dock-more-in {");
    expect(squash(outsideMedia(css).replace(/@keyframes dock-more-in \{[\s\S]*?\}\s*\}/, ""))).not.toContain("dock-more-in");
    expect(squash(phoneOf(css))).toContain("animation:dock-more-invar(--dur-base)var(--ease);");
  });

  it("desktop rules the phone work touched keep their numbers", () => {
    const edge = squash(outsideMedia(strip(read("styles/edge-rails.css"))));
    expect(edge).toContain(".edge-dock{display:none;}");
    const shell = squash(outsideMedia(strip(read("styles/stage-shell.css"))));
    expect(shell).not.toContain("min-height:52px");
    const tokens = read("styles/tokens.css");
    expect(tokens).toContain("--topbar-h: 44px;");
    expect(tokens).toContain("--dock-h: 56px;");
  });

  it("the sheet's media queries are all the one phone query", () => {
    const css = strip(read("styles/phone-sheet.css"));
    for (const [a] of blocksOf(css, "@media")) {
      expect(css.slice(a, a + 70)).toMatch(/^@media \(max-width: 640px\)/);
    }
  });
});
