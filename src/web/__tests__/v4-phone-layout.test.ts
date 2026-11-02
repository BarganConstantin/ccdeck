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
import { OfflineCard, UNREACHABLE_SUB, lastNewsTime, unreachableSub } from "../components/ConnectionBanner";
import PhoneKeys, { PHONE_KEYS } from "../components/terminal/PhoneKeys";
import {
  CLOSE_SHARE, FLICK_SPEED, GRAB_ZONE_PX, SHEET_CLOSE_MS, SHEET_EASE, SHEET_NAMES, SHEET_OPEN_MS,
  dragOffset, releaseCloses, sheetToKeep, type SheetFlags,
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
    expect(markup).toContain("onPointerDown={keepFocus}");
    expect(markup).toContain("e.preventDefault()");
  });

  it("the row is wired to the session's own input: press() is the terminal's onInput, and no new transport is touched", () => {
    const session = read("use-terminal-session.ts");
    expect(session).toContain("press(bytes) { events.onInput(bytes); },");
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

  it("a release closes over 0.11 px/ms whatever the distance, else past 40% of the height", () => {
    expect(FLICK_SPEED).toBe(0.11);
    expect(CLOSE_SHARE).toBe(0.4);
    expect(releaseCloses(10, 400, 30, 100)).toBe(true);
    expect(releaseCloses(10, 400, 10, 100)).toBe(false);
    expect(releaseCloses(161, 400, 1, 100)).toBe(true);
    expect(releaseCloses(159, 400, 1, 100)).toBe(false);
  });

  it("a drag follows the finger 1:1 on the way down and a pull up resists without a stop", () => {
    expect(dragOffset(0)).toBe(0);
    expect(dragOffset(37)).toBe(37);
    expect(Math.abs(dragOffset(-40))).toBeLessThan(40);
    expect(Math.abs(dragOffset(-200))).toBeGreaterThan(Math.abs(dragOffset(-40)));
    expect(Math.abs(dragOffset(-200))).toBeLessThan(24);
  });

  it("opens in 280 ms and closes in 200, both on the stage's curve, from the tokens", () => {
    const tokens = read("styles/tokens.css");
    expect(SHEET_OPEN_MS).toBe(280);
    expect(SHEET_CLOSE_MS).toBe(200);
    expect(SHEET_EASE).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
    expect(tokens).toContain(`--dur-stage-in: ${SHEET_OPEN_MS}ms;`);
    expect(tokens).toContain(`--dur-stage-out: ${SHEET_CLOSE_MS}ms;`);
    expect(tokens).toContain(`--ease-stage: ${SHEET_EASE};`);
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
    expect(read("use-phone-sheets.ts")).toContain("SHEET_FADE_MS");
  });

  it("every sheet carries the handle, and the drag starts on the strip or the header, never on a control", () => {
    for (const file of ["UsagePanel", "MachinePanel", "DetailAside", "Inspector", "AccountsPanel", "CodexAccountsPanel"]) {
      expect(read(`components/${file}.tsx`), file).toContain("<SheetHandle />");
    }
    const hook = read("use-phone-sheets.ts");
    expect(GRAB_ZONE_PX).toBe(44);
    expect(hook).toContain("target.closest(CONTROL)");
    expect(hook).toContain('e.key !== "Escape"');
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
    expect(lastNewsTime(at)).toBe("14:02");
    expect(unreachableSub(at)).toBe("Agents may still be running. Last news 14:02, so what you see may be old.");
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
    expect(read("use-event-stream.ts")).toContain("setLastNewsAt(heardRef.current)");
  });
});

describe("the dock has five doors, and the rest are in More", () => {
  const app = read("App.tsx");

  it("Accounts, Sessions, Usage and Machine, then More; Settings and the rest are in More", () => {
    expect(app).toContain("items={[...rails.left, ...rails.right[0]]");
    expect(app).toContain("more={[rails.search, ...rails.capacity, ...rails.right.slice(1).flat(), ...rails.integrations, ...rails.explore, ...rails.utilities]}");
  });

  it("one door is active at a time: Sessions gives way while Accounts, Usage or Machine is up over it", () => {
    expect(app).toContain('item.id === "session-list" && sheets.sheet != null && sheets.sheet !== "inspector" ? { ...item, open: false } : item');
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
});

describe("the desktop layout is unchanged: no phone rule is outside the phone query", () => {
  const sheets: Array<[string, RegExp[]]> = [
    ["styles/phone-sheet.css", [/phone-scrim/, /sheet-handle/, /dock-more-pop/, /sl-empty-notice/, /\.accounts-panel/, /--topbar-h/]],
    ["styles/stage-shell.css", [/\.ts-key\b/, /\.ts-more/, /ts-keyrow/]],
    ["styles/edge-rails.css", [/rail-offline-dot/]],
    ["styles/session-list.css", [/sl-header \{ position: relative/]],
    ["styles/search-and-banners.css", [/\.session-list \.conn-banner-phone/]],
  ];

  for (const [path, needles] of sheets) {
    it(`${path}: what the phone adds is held by the query, the desktop part carries no such declaration`, () => {
      const css = strip(read(path));
      const desktop = outsideMedia(css);
      for (const needle of needles) {
        const hits = [...desktop.matchAll(new RegExp(needle.source, "g"))];
        // Only a rule that hides a phone-only part at desktop width may be outside the query.
        for (const hit of hits) {
          const line = desktop.slice(Math.max(0, hit.index! - 60), hit.index! + 120);
          expect(line, `${path}: ${needle}`).toMatch(/display: none/);
        }
      }
    });
  }

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
