// V4's banners (its Figma): the strip under the top bar and the two notices on
// the empty canvas. Every banner starts with a 14px kit icon in the tone's
// colour, spans the window with its dismiss at the right edge, and says what
// it says in the words V4 writes. An update is two rows: the message, then the
// command in a box of its own with Copy. The question is a 40px row of
// outlined pills with an outlined "Not now". The "never reached" and "too many
// tabs" notices are a 360px block with a 24px icon.
//
// What the stylesheet and the markup say is pinned here; the measured sizes in
// a browser are in the change's notes. Nothing a banner offers went away: the
// actions, the version number and the command are all still asserted.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";
import shellEn from "../i18n/areas/shell/en";
import boardEn from "../i18n/areas/board/en";
import VersionBanner from "../components/VersionBanner";
import RatingBanner from "../components/RatingBanner";
import OldNameBanner from "../components/OldNameBanner";
import ConnectionBanner from "../components/ConnectionBanner";
import { TabCapHero, EmptyHero } from "../components/EmptyHero";

const read = (...p: string[]) => readFileSync(new URL(`../${p.join("/")}`, import.meta.url), "utf8");
const sheet = sheetText().replace(/\/\*[\s\S]*?\*\//g, "");

function body(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`, "m").exec(sheet);
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1];
}
const decl = (selector: string, prop: string): string | undefined => {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(body(selector));
  return m?.[1].replace(/\s+/g, " ");
};
const TEXT_INC = "calc(12px + var(--ui-text-increase, 0px))";

const noop = () => {};
const versionProps = (over: Record<string, unknown> = {}, notice = { kind: "upgrade" as const, from: "3.51.0", to: "3.52.0" }) => ({
  notice,
  version: { command: "npm install -g ccdeck@3.52.0", canRestart: true, upgradeMode: "install", ...over } as never,
  dismissNotice: noop,
  upgradeState: "idle" as const,
  startUpgrade: noop,
  copyCommand: noop,
  cmdCopied: false,
  autoRestart: false,
  toggleAutoRestart: noop,
  askRestart: noop,
  restartCopy: { label: "Restart now", clause: "nothing is running" } as never,
  restartFuseMs: null,
  restarting: false,
});
const html = (props: ReturnType<typeof versionProps>) => renderToStaticMarkup(createElement(VersionBanner, props));

describe("every banner starts with a 14px kit icon, not a dot", () => {
  it("draws the mark in the tone's colour and nothing of the old dot is left", () => {
    const mark = ":is(.ver-banner, .conn-banner) .banner-mark";
    expect(decl(mark, "width")).toBe("14px");
    expect(decl(mark, "height")).toBe("14px");
    for (const f of ["components/VersionBanner.tsx", "components/ConnectionBanner.tsx", "components/OldNameBanner.tsx",
      "components/RatingBanner.tsx", "components/DeckBanner.tsx"]) {
      expect(read(f), f).not.toMatch(/ver-dot|conn-dot/);
    }
    expect(sheet).not.toMatch(/\.ver-dot|\.conn-dot/);
  });

  it("uses the lost-connection icon, the info icon, the done check and the error mark where V4 draws them", () => {
    expect(read("components/ConnectionBanner.tsx")).toContain('<BannerMark glyph="unreachable" tone="err" />');
    expect(read("components/OldNameBanner.tsx")).toContain('<BannerMark glyph="info" tone="info" />');
    expect(read("components/DeckBanner.tsx")).toContain('<BannerMark glyph="done" tone="ok" />');
    expect(read("components/VersionBanner.tsx")).toContain('glyph={failed ? "error" : update ? "update" : "restart"}');
    const lost = renderToStaticMarkup(createElement(ConnectionBanner, { restarting: false, restartMode: null as never, live: false, paused: false }));
    expect(lost).toContain('class="conn-banner"');
    expect(lost).toContain('class="banner-mark err"');
    expect(lost).toContain("Lost connection to the ccdeck server. Reconnecting…");
  });
});

describe("the strip spans the window and the dismiss is pinned at its right edge", () => {
  it("is 32 high with its rule, on --panel, across all the columns", () => {
    expect(decl(".conn-banner", "min-height")).toBe("var(--ctl-h-lg)");
    expect(decl(".ver-banner", "min-height")).toBe("var(--ctl-h-lg)");
    expect(decl(".app.app.app :is(.ver-banner, .conn-banner:has(> .banner-mark))", "grid-column")).toBe("1 / -1");
  });

  it("makes the dismiss 24 x 24 with the control corner, pushed to the end of the row", () => {
    const c = ".ver-banner .ver-close";
    expect(decl(c, "width")).toBe("24px");
    expect(decl(c, "height")).toBe("24px");
    expect(decl(c, "border-radius")).toBe("var(--r-ctl)");
    expect(decl(c, "margin-left")).toBe("auto");
  });

  it("keeps its label and what it does, in the version banner, the old-name notice and the thanks", () => {
    const update = html(versionProps());
    expect(update).toMatch(/<button[^>]*aria-label="Dismiss"[^>]*class="ver-close"|<button[^>]*class="ver-close"[^>]*aria-label="Dismiss"/);
    expect(read("components/VersionBanner.tsx")).toContain("onClick={dismissNotice}");
    expect(read("components/OldNameBanner.tsx")).toContain("onClick={dismissOldName}");
    expect(read("components/RatingBanner.tsx")).toContain("onClick={() => leave(onClose)}");
  });
});

describe("an update is two rows: the message, then the command in a box with Copy", () => {
  it("lays the box out as V4 draws it: 32 high, --sunken, the control corner, a 40px row", () => {
    expect(decl(".ver-banner .ver-cmdrow", "padding")).toBe("0 12px 8px");
    const box = ".ver-banner .ver-cmd";
    expect(decl(box, "height")).toBe("32px");
    expect(decl(box, "background")).toBe("var(--sunken)");
    expect(decl(box, "border-radius")).toBe("var(--r-ctl)");
    // 1px transparent edge + 3px 3px 3px 7px = V4's 4 4 4 8 inside; the edge is painted only in forced colours.
    expect(decl(box, "padding")).toBe("3px 3px 3px 7px");
    expect(decl(box, "border")).toBe("1px solid transparent");
    expect(decl(box, "gap")).toBe("8px");
    expect(decl(box, "cursor")).toBe("pointer");
  });

  it("sets the command in mono 12 on 16, on one line with an ellipsis", () => {
    const code = ".ver-banner .ver-cmd code";
    expect(decl(code, "font-family")).toBe("var(--font-mono)");
    expect(decl(code, "font-size")).toBe(TEXT_INC);
    expect(decl(code, "line-height")).toBe("16px");
    expect(decl(code, "white-space")).toBe("nowrap");
    expect(decl(code, "text-overflow")).toBe("ellipsis");
  });

  it("makes Copy a 24 x 24 icon button at the box's end", () => {
    const copy = ".ver-banner .ver-copy";
    expect(decl(copy, "width")).toBe("24px");
    expect(decl(copy, "height")).toBe("24px");
    expect(decl(copy, "border-radius")).toBe("var(--r-ctl)");
    expect(body(".ver-banner.ver-stack > .ver-row")).toMatch(/border-bottom:\s*1px solid var\(--line\)/);
    expect(body(".ver-banner.ver-stack")).toMatch(/border-bottom:\s*0/);
  });

  it("renders the version, the install action and the command with Copy, still", () => {
    const out = html(versionProps());
    expect(out).toContain("v3.52.0 is out");
    expect(out).toContain("you are on v3.51.0");
    expect(out).toContain(">Update now<");
    expect(out).toContain("ver-banner ver-stack");
    expect(out).toMatch(/<div class="ver-cmd"[^>]*><code>npm install -g ccdeck@3.52.0<\/code>/);
    expect(out).toMatch(/<button[^>]*class="ver-copy"[^>]*aria-label="Copy to clipboard"/);
  });

  it("copies from the whole box, once, and says \"copied\" in the status region", () => {
    const src = read("components/VersionBanner.tsx");
    // The box has the press; the Copy button has none of its own (its click bubbles up), so it runs once.
    expect(src).toMatch(/className="ver-cmd" onClick=\{copyBox\}/);
    expect(src).not.toMatch(/className="ver-copy"[^>]*onClick/);
    expect(src).toContain("window.getSelection()?.toString()");
    const idle = html(versionProps());
    expect(idle).toContain('<span class="vis-hidden"></span>');
    const done = renderToStaticMarkup(createElement(VersionBanner, { ...versionProps(), cmdCopied: true }));
    expect(done).toContain('<span class="vis-hidden">copied</span>');
    expect(done).toMatch(/role="status"/);
    expect(shellEn["shell.banner.copiedHint"]).toBe("copied");
  });

  it("says the install failed in V4's words, keeps the retry and the command, and the version", () => {
    const out = renderToStaticMarkup(createElement(VersionBanner, {
      // The server's real command is `@latest`: it names no version, so the version line has to be on the row.
      ...versionProps({ upgradeMode: "npx", canRestart: true, command: "npx -y ccdeck@latest", upgrade: { state: "failed", command: null, error: "EACCES" } }),
      upgradeState: "failed" as const,
    }));
    expect(out).toContain("Update failed: EACCES. Run it yourself:");
    expect(out).toContain('class="banner-mark err"');
    expect(out).toContain(">Retry update<");
    expect(out).toContain("<code>npx -y ccdeck@latest</code>");
    // Visible on the row, not only in a title.
    expect(out).toContain('<span class="ver-sub">ccdeck v3.52.0 is out \u2014 you are on v3.51.0.</span>');
    expect(shellEn["shell.banner.failedLine"]).toBe("{what}: {error}. Run it yourself:");
    expect(shellEn["shell.banner.installFailed"]).toBe("Install failed");
    expect(out).not.toContain("ver-sub fail");
    expect(out).toContain("Update failed: EACCES. Run it yourself:</strong>");
  });

  it("says a checkout pulls instead in the words every language already has, keeps the version, and gives the command in the box", () => {
    const out = html(versionProps({ upgradeMode: null, upgradeBlocked: "git_checkout", command: "git pull && npm run build" }));
    expect(out).toContain("<strong>ccdeck v3.52.0 is out \u2014 you are on v3.51.0.</strong>");
    expect(out).toContain('<span class="ver-sub">' + shellEn["shell.banner.block.git_checkout"] + "</span>");
    expect(out).toContain("<code>git pull &amp;&amp; npm run build</code>");
    expect(out).not.toContain("Click to copy");
    expect(Object.keys(shellEn)).not.toContain("shell.banner.gitCheckout");
    expect(Object.keys(shellEn)).not.toContain("shell.banner.copyHint");
  });

  it("lets a long npm error shrink to an ellipsis instead of pushing the dismiss off the strip", () => {
    expect(decl(".ver-banner strong", "min-width")).toBe("0");
    expect(decl(".ver-banner strong", "overflow")).toBe("hidden");
    expect(decl(".ver-banner strong", "text-overflow")).toBe("ellipsis");
    const long = "EACCES: permission denied, mkdir '" + "/usr/local/lib/node_modules/".repeat(12) + "ccdeck'";
    const out = renderToStaticMarkup(createElement(VersionBanner, {
      ...versionProps({ upgradeMode: "install", upgrade: { state: "failed", command: null, error: long } }),
      upgradeState: "failed" as const,
    }));
    // The full text is in the title and on the row; the dismiss and the command are still there.
    expect(out).toContain('title="Install failed: ' + long.replace(/'/g, "&#x27;"));
    expect(out).toContain('class="ver-close"');
    expect(out).toContain("ver-cmdrow");
  });

  it("keeps the restart banner a single row with every action it has", () => {
    const out = html(versionProps({}, { kind: "restart" as never, from: "3.51.0", to: "3.52.0" }));
    expect(out).not.toContain("ver-stack");
    expect(out).toContain("Restart now");
    expect(out).toContain('role="switch"');
    expect(out).toContain("v3.52.0 is installed");
  });
});

describe("the old name is two sentences with full stops", () => {
  it("reads as V4 writes it, with the server's own second sentence kept", () => {
    expect(shellEn["shell.banner.oldName"]).toBe("{old} still works. The deck is called {product} now.");
    const out = renderToStaticMarkup(createElement(OldNameBanner, {
      oldName: "agents-deck", version: { renameFix: "next time: npx ccdeck" } as never, dismissOldName: noop,
    }));
    expect(out).toContain("agents-deck still works. The deck is called ccdeck now.");
    expect(out).toContain("next time: npx ccdeck");
    expect(out).toContain('class="banner-mark info"');
  });
});

describe("the rating ask is a 40px row of outlined pills", () => {
  const ask = ".ver-banner.rating-ask";
  it("is 40 high, padded 6 12, 12 apart, with no mark and no dismiss", () => {
    expect(decl(ask, "min-height")).toBe("40px");
    expect(decl(ask, "padding")).toBe("6px 12px");
    expect(decl(ask, "column-gap")).toBe("12px");
    const out = renderToStaticMarkup(createElement(RatingBanner, {
      phase: "asking", score: null, onAnswer: noop, onLater: noop, onClose: noop, onFeedback: noop, onHold: noop,
    }));
    expect(out).not.toContain("banner-mark");
    expect(out).not.toContain("ver-close");
    expect(out).toContain("rating-ask");
  });

  it("sets the question at 12 / 500", () => {
    expect(decl(".rating-ask > strong", "font-size")).toBe(TEXT_INC);
    expect(decl(".rating-ask > strong", "font-weight")).toBe("500");
  });

  it("draws the pills 23 x 24, the 10 pill 30 wide, round, outlined, labelled 12 / 400 in the secondary tier", () => {
    const pick = ".rating-banner .rating-pick";
    expect(decl(pick, "width")).toBe("23px");
    expect(decl(pick, "height")).toBe("24px");
    expect(decl(".rating-banner .rating-pick.ten", "width")).toBe("30px");
    expect(decl(pick, "border-radius")).toBe("var(--r-pill)");
    expect(decl(pick, "background")).toBe("none");
    expect(decl(pick, "font-size")).toBe(TEXT_INC);
    expect(decl(pick, "font-weight")).toBe("400");
    expect(decl(pick, "color")).toBe("var(--text-secondary)");
  });

  it("draws \"Not now\" as an outlined 28px button with the radius 8 at the right edge", () => {
    const later = ".rating-banner .rating-later";
    expect(decl(later, "height")).toBe("28px");
    expect(decl(later, "border-radius")).toBe("8px");
    expect(decl(later, "padding")).toBe("4px 12px");
    expect(decl(later, "margin-left")).toBe("auto");
    expect(decl(later, "background")).toBe("none");
    expect(decl(later, "font-weight")).toBe("500");
  });

  it("keeps all eleven scores, what picking one does, the ends and Not now", () => {
    const out = renderToStaticMarkup(createElement(RatingBanner, {
      phase: "asking", score: null, onAnswer: noop, onLater: noop, onClose: noop, onFeedback: noop, onHold: noop,
    }));
    const picks = [...out.matchAll(/class="rating-pick(?: ten)?"[^>]*>(\d+)<\/button>/g)].map(m => m[1]);
    expect(picks).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(out).toContain('class="rating-pick ten"');
    expect(out).toContain("0 not at all · 10 extremely");
    expect(out).toMatch(/<button[^>]*class="rating-later"[^>]*>Not now<\/button>/);
    const src = read("components/RatingBanner.tsx");
    expect(src).toContain("onAnswer(n)");
    expect(src).toContain("leave(onLater)");
  });

  it("keeps the thanks a 32px banner with a done mark, its offer and its dismiss", () => {
    const out = renderToStaticMarkup(createElement(RatingBanner, {
      phase: "thanks", score: 3, onAnswer: noop, onLater: noop, onClose: noop, onFeedback: noop, onHold: noop,
    }));
    expect(out).toContain('class="banner-mark ok"');
    expect(out).toContain("Tell us what would make it better");
    expect(out).toContain('class="ver-close"');
  });
});

describe("the two notices on the empty canvas are a 360px block with a 24px icon", () => {
  it("sizes the block, the icon, the title and the body as V4 draws them", () => {
    const block = ".empty-hero.empty-notice";
    expect(decl(block, "width")).toBe("min(360px, calc(100% - 48px))");
    expect(decl(block, "padding")).toBe("16px");
    expect(decl(block, "gap")).toBe("4px");
    expect(decl(".empty-hero.empty-notice .empty-symbol", "width")).toBe("24px");
    expect(decl(".empty-hero.empty-notice .empty-symbol", "height")).toBe("24px");
    expect(decl(".empty-hero.empty-notice h2", "font-size")).toBe("calc(14px + var(--ui-text-increase, 0px))");
    expect(decl(".empty-hero.empty-notice h2", "line-height")).toBe("20px");
    expect(decl(".empty-hero.empty-notice p", "line-height")).toBe("20px");
    expect(decl(".empty-hero p", "font-size")).toBe("calc(13px + var(--ui-text-increase, 0px))");
  });

  it("puts both on that block, with a 24px icon, and leaves the waiting hero as it was", () => {
    const tabs = renderToStaticMarkup(createElement(TabCapHero, {}));
    expect(tabs).toContain("empty-hero empty-notice");
    expect(tabs).toContain('width="24" height="24"');
    expect(tabs).toContain("Too many ccdeck tabs are open");
    const offline = renderToStaticMarkup(createElement(EmptyHero, {
      live: false, everConnected: false, providers: {} as never, workspace: null, onTour: noop,
    }));
    expect(offline).toContain("empty-hero empty-notice");
    expect(offline).toContain("Server unreachable");
    expect(offline).toContain("This page cannot reach <code>ccdeck</code>. Check that it is still running in your terminal. The page picks up again on its own.");
    const waiting = renderToStaticMarkup(createElement(EmptyHero, {
      live: true, everConnected: true, providers: {} as never, workspace: null, onTour: noop,
    }));
    expect(waiting).not.toContain("empty-notice");
    expect(waiting).toContain("Take the tour");
    expect(waiting).toContain('width="32" height="32"');
  });

  it("writes the 'too many tabs' body as it was and the 'lost' body with full stops", () => {
    expect(boardEn["board.hero.tabsBody"]).toBe("This browser keeps at most six live connections to one address, and other {product} tabs are holding them. Close one and this tab connects on its own.");
    expect(boardEn["board.hero.lost"]).not.toContain("—");
    expect(boardEn["board.hero.cannotReach"]).not.toContain("—");
  });
});

describe("the strip height", () => {
  it("is mounted by the component that mounts the banners", () => {
    const src = read("components/DeckBanner.tsx");
    expect(src).toContain('import { StripHeight } from "../use-strip-height";');
    expect(src).toContain("<StripHeight />");
  });

  it("starts every fixed sheet under the strip, not under the top bar alone", () => {
    const below = "calc(var(--topbar-h) + var(--rating-h, 0px))";
    // The Inspector sheet (1100-1319) and the sessions sheet (under 1100) in Workspace, and the sessions sheet on a phone.
    expect(sheet).toContain(`.app[data-view="workspace"] .detail {\n    position: fixed;\n    top: ${below};`);
    expect(sheet).toContain(`.app[data-view="workspace"] .left-column {\n    position: fixed;\n    top: ${below};`);
    expect(sheet).toMatch(new RegExp(`\\.left-column \\{\\s*position: fixed;\\s*top: ${below.replace(/[()+]/g, "\\$&")}`));
  });

  it("puts a banner's phone corrections on every banner with a mark, so a rating row is not the only one that gets them", () => {
    const all = sheet.match(/\.app:has\(\.banner-mark, \.rating-banner\) \.(usage-panel|sysdetail|detail) \{[^}]*\}/g) ?? [];
    expect(all.some(r => r.includes(".sysdetail") && /top:\s*auto/.test(r))).toBe(true);
    expect(all.some(r => r.includes(".usage-panel") && r.includes("var(--dock-h) / 2 - var(--rating-h, 0px)"))).toBe(true);
    expect(all.some(r => r.includes(".detail") && r.includes("var(--rating-h, 0px)"))).toBe(true);
    expect(sheet).not.toMatch(/\.app:has\(\.rating-banner\) \.(usage-panel|sysdetail|detail)/);
  });

  it("keeps the rating row's own row gap on a phone: only the column gap is set on the ask", () => {
    expect(decl(".ver-banner.rating-ask", "column-gap")).toBe("12px");
    expect(decl(".ver-banner.rating-ask", "gap")).toBeUndefined();
  });
});

describe("the two notices still hide on a narrow canvas", () => {
  it("is in the container rule the hero has always had, so a 32px notice never shows", () => {
    expect(sheet).toMatch(/@container \(max-width: 260px\) \{\s*\.empty-hero, \.empty-hero\.empty-notice \{ display: none; \}/);
  });
});
