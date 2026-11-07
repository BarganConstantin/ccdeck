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
import { afterEach, describe, expect, it } from "vitest";
import { sheetText } from "./sheet-source";
import shellEn from "../i18n/areas/shell/en";
import boardEn from "../i18n/areas/board/en";
import VersionBanner from "../components/VersionBanner";
import RatingBanner from "../components/RatingBanner";
import OldNameBanner from "../components/OldNameBanner";
import ConnectionBanner from "../components/ConnectionBanner";
import { TabCapHero, EmptyHero } from "../components/EmptyHero";
import BannerMark from "../components/BannerMark";
import { sentences } from "../banner-sentences";
import { setLanguage, t, type MessageKey } from "../i18n";

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
  askRestart: noop,
  restartCopy: { label: "Restart now", clause: "Nothing is running.", risky: false } as never,
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
    // CHANGED ON PURPOSE (V4's Figma): a version banner is news, in the Info tone; Waiting only where
    // an agent would lose something, and a failed install takes the Unreachable mark in Error.
    expect(read("components/VersionBanner.tsx")).toContain('glyph={failed ? "unreachable" : risky ? "warning" : "info"} tone={failed ? "err" : risky ? "warn" : "info"}');
    const lost = renderToStaticMarkup(createElement(ConnectionBanner, { restarting: false, restartMode: null as never, live: false, paused: false }));
    expect(lost).toContain('class="conn-banner"');
    expect(lost).toContain('class="banner-mark err"');
    expect(lost).toContain("Lost connection to the ccdeck server. Reconnecting…");
    // A restart the reader asked for is news: the Info mark in muted, not the error one.
    const restarting = renderToStaticMarkup(createElement(ConnectionBanner, { restarting: true, restartMode: null as never, live: false, paused: false }));
    expect(restarting).toContain('class="banner-mark info"');
    expect(restarting).toContain("Restarting ccdeck…");
  });
});

describe("the strip spans the window and the dismiss is pinned at its right edge", () => {
  it("is 32 high with its rule, on --panel, across all the columns", () => {
    expect(decl(".conn-banner", "min-height")).toBe("var(--ctl-h-lg)");
    expect(decl(".ver-banner", "min-height")).toBe("var(--ctl-h-lg)");
    // CHANGED ON PURPOSE (V4's motion rules): every banner is drawn in one holder whose height eases
    // in and out, so the holder is what spans the columns, for the same banners as before.
    expect(decl(".app.app.app > .banner-strip:has(.ver-banner, .conn-banner > .banner-mark)", "grid-column")).toBe("1 / -1");
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
    // 1px transparent edge + V4's 4 4 4 8 less that edge = V4's 4 4 4 8 inside; the edge is painted only in forced colours.
    expect(decl(box, "padding")).toBe("calc(4px - 1px) calc(4px - 1px) calc(4px - 1px) calc(8px - 1px)");
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

  // CHANGED ON PURPOSE (V4's Figma): under a working "Update now" the banner is one 32px row and
  // the button is the way; the command it runs is still in its title. The box is for a command the
  // reader has to run.
  it("renders the version and the install action on one row, with the command in the button's title", () => {
    const out = html(versionProps());
    expect(out).toContain("<strong>ccdeck v3.52.0 is out. You are on v3.51.0.</strong>");
    expect(out).toContain(">Update now<");
    expect(out).not.toContain("ver-stack");
    expect(out).not.toContain("ver-cmd");
    expect(out).toContain('title="Runs npm install -g ccdeck@3.52.0 here, then restarts once nothing is running."');
  });

  it("copies from the whole box, once, and says \"copied\" in the status region", () => {
    const src = read("components/VersionBanner.tsx");
    // The box has the press; the Copy button has none of its own (its click bubbles up), so it runs once.
    expect(src).toMatch(/className="ver-cmd" onClick=\{copyBox\}/);
    expect(src).not.toMatch(/className="ver-copy"[^>]*onClick/);
    expect(src).toContain("window.getSelection()?.toString()");
    // CHANGED ON PURPOSE (V4's Figma): the box is drawn where the reader runs the command, here an
    // install directory this user cannot write.
    const blocked = { upgradeMode: null, upgradeBlocked: "not_writable", command: "sudo npm install -g ccdeck@3.52.0" };
    const idle = html(versionProps(blocked));
    expect(idle).toContain('<span class="vis-hidden"></span>');
    const done = renderToStaticMarkup(createElement(VersionBanner, { ...versionProps(blocked), cmdCopied: true }));
    expect(done).toContain('<span class="vis-hidden">copied</span>');
    expect(done).toMatch(/role="status"/);
    expect(shellEn["shell.banner.copiedHint"]).toBe("copied");
  });

  // CHANGED ON PURPOSE (V4's Figma): the failed row says what failed and the command to run,
  // nothing more; the release line it carried under the failure is gone from it.
  it("says the install failed in V4's words, and keeps the retry and the command", () => {
    const out = renderToStaticMarkup(createElement(VersionBanner, {
      // The server's real command is `@latest`.
      ...versionProps({ upgradeMode: "npx", canRestart: true, command: "npx -y ccdeck@latest", upgrade: { state: "failed", command: null, error: "EACCES" } }),
      upgradeState: "failed" as const,
    }));
    expect(out).toContain("Update failed: EACCES. Run it yourself:");
    expect(out).toContain('class="banner-mark err"');
    expect(out).toContain(">Retry update<");
    expect(out).toContain("<code>npx -y ccdeck@latest</code>");
    expect(out).toContain(renderToStaticMarkup(createElement(BannerMark, { glyph: "unreachable", tone: "err" })));
    expect(out).not.toContain("is out");
    expect(out).not.toContain("ver-sub");
    expect(shellEn["shell.banner.failedLine"]).toBe("{what}: {error}. Run it yourself:");
    expect(shellEn["shell.banner.installFailed"]).toBe("Install failed");
    expect(out).not.toContain("ver-sub fail");
    expect(out).toContain("Update failed: EACCES. Run it yourself:</strong>");
  });

  // CHANGED ON PURPOSE (V4's Figma): a checkout says only that, as a sentence of its own; a pull
  // takes whatever the branch has, not this release, so the release line is not on the row.
  it("says a checkout pulls instead in V4's words alone, and gives the command in the box", () => {
    const out = html(versionProps({ upgradeMode: null, upgradeBlocked: "git_checkout", command: "git pull && npm run build" }));
    expect(out).toContain("<strong>" + shellEn["shell.banner.blockSentence.git_checkout"] + "</strong>");
    expect(shellEn["shell.banner.blockSentence.git_checkout"]).toBe("This deck runs from a git checkout. Pull instead:");
    expect(out).not.toContain("is out");
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
    // CHANGED ON PURPOSE (V4's Figma): no auto-restart switch in the banner; the preference is in
    // Settings › Updates, and a countdown is said in the sentence.
    expect(out).not.toContain('role="switch"');
    expect(out).toContain("<strong>v3.52.0 is installed. This deck still runs v3.51.0. Nothing is running.</strong>");
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

// ── the row's order, its tone, its command and its words (V4's Figma) ───────

const mark = (glyph: string, tone: string) => renderToStaticMarkup(createElement(BannerMark, { glyph: glyph as never, tone: tone as never }));
const RESTART = { kind: "restart" as never, from: "3.51.0", to: "3.52.0" };
const NPX = { upgradeMode: "npx", command: "npx -y ccdeck@latest" };
const CHECKOUT = { upgradeMode: null, upgradeBlocked: "git_checkout", command: "git pull && npm run build" };
const failedInstall = () => renderToStaticMarkup(createElement(VersionBanner, {
  ...versionProps({ upgrade: { state: "failed", command: null, error: "EACCES" } }), upgradeState: "failed" as const,
}));
const withCopy = (copy: { label: string; clause: string; risky: boolean }, fuse: number | null = null) =>
  renderToStaticMarkup(createElement(VersionBanner, { ...versionProps({}, RESTART), restartCopy: copy as never, restartFuseMs: fuse as never }));

describe("the row reads mark, message, space, action, ×", () => {
  it("puts the space before the action, so the action sits just before the dismiss", () => {
    expect(decl(".ver-banner .ver-act", "margin-left")).toBe("auto");
    expect(decl(".ver-banner .ver-act ~ .ver-close", "margin-left")).toBe("0");
    // With no action the dismiss takes the space itself.
    expect(decl(".ver-banner .ver-close", "margin-left")).toBe("auto");
  });

  it("draws the action after the message and before the ×, on every row that has one", () => {
    for (const out of [html(versionProps()), html(versionProps({}, RESTART)), html(versionProps(NPX))]) {
      expect(out).toMatch(/<\/strong><button[^>]*class="ver-act"[^>]*>[^<]+<\/button><button[^>]*class="ver-close"/);
    }
  });
});

describe("a version banner is news, and waits only where an agent would lose something", () => {
  it("wears the Info mark in muted on a release, an npx re-run, a checkout and an idle restart", () => {
    for (const out of [html(versionProps()), html(versionProps(NPX)), html(versionProps(CHECKOUT)), html(versionProps({}, RESTART))]) {
      expect(out).toContain(mark("info", "info"));
    }
  });

  it("wears the Warning mark in Waiting while agents run or the canvas is paused, and drops the stale line", () => {
    const agents = withCopy({ label: "Restart anyway", clause: t("shell.banner.clauseAgents", { count: 1 }), risky: true });
    expect(agents).toContain(mark("warning", "warn"));
    expect(agents).toContain("<strong>v3.52.0 is installed. 1 agent is running: their events during the restart are lost.</strong>");
    expect(agents).toContain(">Restart anyway<");
    const paused = withCopy({ label: "Restart anyway", clause: t("shell.banner.clausePaused"), risky: true });
    expect(paused).toContain(mark("warning", "warn"));
    expect(paused).toContain("<strong>v3.52.0 is installed. The canvas is paused: running agents cannot be seen.</strong>");
  });

  it("wears the Unreachable mark in Error when an install failed", () => {
    const out = failedInstall();
    expect(out).toContain(mark("unreachable", "err"));
    expect(out).toContain('<strong title="Install failed: EACCES. Run it yourself:">Install failed: EACCES. Run it yourself:</strong>');
  });
});

describe("a restart counting down says so in its sentence", () => {
  it("shows the seconds, gives a reader a sentence that does not tick, and arms the mark", () => {
    const out = withCopy({ label: "Restart now", clause: t("shell.banner.clauseIdle"), risky: false }, 18_000);
    expect(out).toContain('<strong><span aria-hidden="true">v3.52.0 is installed. Restarting by itself in 18 s.</span>'
      + '<span class="vis-hidden">v3.52.0 is installed. Restarting by itself when idle.</span></strong>');
    expect(out).toContain('class="banner-mark info armed"');
    expect(out).not.toContain('role="switch"');
  });

  it("keeps the paused clause in front of the clock", () => {
    const out = withCopy({ label: "Restart anyway", clause: t("shell.banner.clausePaused"), risky: true }, 30_000);
    expect(out).toContain("v3.52.0 is installed. The canvas is paused: running agents cannot be seen. Restarting by itself in 30 s.");
  });
});

describe("the command has a row of its own only where the reader has to run it", () => {
  it("draws the box for npx, a failed install, a checkout and a copy this deck cannot write over", () => {
    const blocked = { upgradeMode: null, upgradeBlocked: "not_writable", command: "sudo npm install -g ccdeck@3.52.0" };
    for (const out of [html(versionProps(NPX)), failedInstall(), html(versionProps(CHECKOUT)), html(versionProps(blocked))]) {
      expect(out).toContain('class="ver-cmdrow"');
    }
  });

  it("draws none under a working Update now, or on a restart", () => {
    for (const out of [html(versionProps()), html(versionProps({}, RESTART))]) expect(out).not.toContain("ver-cmdrow");
  });

  it("says npx's re-run as V4 writes it, and keeps the press that does it", () => {
    const out = html(versionProps(NPX));
    expect(out).toContain("<strong>ccdeck v3.52.0 is out. npx cannot upgrade in place, so the deck re-runs:</strong>");
    expect(out).toContain(">Update &amp; restart</button>");
    expect(out).toContain("<code>npx -y ccdeck@latest</code>");
  });
});

describe("the strip's other rows", () => {
  const own = (restartMode: unknown, paused = false, restarting = true) =>
    renderToStaticMarkup(createElement(ConnectionBanner, { restarting, restartMode: restartMode as never, live: false, paused }));

  it("says a restart the reader asked for, and the npx fetch, under the Info mark", () => {
    expect(own(null)).toContain(mark("info", "info"));
    expect(own(null)).toContain("Restarting ccdeck…");
    expect(own("npx")).toContain(mark("info", "info"));
    expect(own("npx")).toContain("Fetching the new version with npx. This can take a minute…");
  });

  it("says a loss while paused in one run, under the error mark", () => {
    const out = own(null, true, false);
    expect(out).toContain(mark("unreachable", "err"));
    expect(out).toContain("Lost connection. The canvas is paused as well: Space resumes it, but nothing new arrives until the stream is back.");
    expect(out).not.toContain("conn-sub");
  });

  it("gives the finished restart its dismiss", () => {
    const src = read("components/DeckBanner.tsx");
    expect(src).toContain('className="ver-close" onClick={dismissRestarted}');
    expect(src).toContain('sentences(t("shell.banner.restartedTo", { version: restartedTo }), t("shell.banner.replayed"))');
    expect(read("use-auto-restart.ts")).toContain("const dismissRestarted = useCallback(() => setRestartedTo(null), []);");
  });
});

describe("every banner's words are sentences with their own stops, in all ten languages", () => {
  afterEach(() => setLanguage("en"));
  const LANGS = ["en", "ro", "de", "fr", "es", "pt-BR", "ja", "ko", "zh-CN", "zh-TW"];
  const SAID = [
    "shell.banner.installedStale", "shell.banner.isInstalled", "shell.banner.isOut", "shell.banner.isOutShort",
    "shell.banner.restartingIn", "shell.banner.restartingWhenIdle", "shell.banner.clausePaused", "shell.banner.clauseIdle",
    "shell.banner.clauseAgents", "shell.banner.fetchingNpx", "shell.banner.restartedTo", "shell.banner.replayed",
    "shell.banner.lostShort", "shell.banner.failedLine", "shell.banner.oldName", "shell.banner.npxRerun",
    "shell.banner.cannotInstall", "shell.banner.blockSentence.git_checkout", "shell.banner.blockSentence.npx",
    "shell.banner.blockSentence.one_off", "shell.banner.blockSentence.not_writable", "shell.banner.blockSentence.opted_out",
    "shell.banner.blockSentence.retired_name", "shell.rating.thanks", "shell.rating.better", "board.pill.outage",
  ] as MessageKey[];
  const VARS = { to: "3.52.0", from: "3.51.0", product: "ccdeck", count: 2, seconds: 30, version: "3.52.0", old: "agents-deck", what: "X", error: "EACCES" };

  it("writes no em dash between clauses, and ends each one on a stop", () => {
    for (const code of LANGS) {
      setLanguage(code);
      for (const key of SAID) {
        const said = t(key, VARS);
        expect(said, `${code} ${key}`).not.toContain("\u2014");
        expect(said, `${code} ${key}`).toMatch(/[.…:。：]$/);
      }
    }
  });

  it("sets a French colon after a no-break space", () => {
    setLanguage("fr");
    for (const key of SAID) expect(t(key, VARS), key).not.toMatch(/ :/);
  });

  it("joins two sentences with a space, and with none in Japanese and Chinese", () => {
    for (const code of LANGS) {
      setLanguage(code);
      expect(sentences("A.", "B."), code).toBe(["ja", "zh-CN", "zh-TW"].includes(code) ? "A.B." : "A. B.");
    }
    setLanguage("en");
    expect(sentences("A.", null, undefined, false, "", "B.")).toBe("A. B.");
    expect(sentences()).toBe("");
  });

  it("names the low score's short offer by the sentence it is short for", () => {
    for (const code of LANGS) {
      setLanguage(code);
      expect(t("shell.rating.better").toLocaleLowerCase(code), code).toContain(t("shell.rating.tellUs").toLocaleLowerCase(code));
    }
  });

  it("says the English rows in the words V4 draws", () => {
    setLanguage("en");
    const drawn: Array<[string, string]> = [
      [t("shell.banner.isOut", VARS), "ccdeck v3.52.0 is out. You are on v3.51.0."],
      [sentences(t("shell.banner.installedStale", VARS), t("shell.banner.clauseIdle")), "v3.52.0 is installed. This deck still runs v3.51.0. Nothing is running."],
      [sentences(t("shell.banner.isInstalled", VARS), t("shell.banner.clauseAgents", { count: 1 })), "v3.52.0 is installed. 1 agent is running: their events during the restart are lost."],
      [sentences(t("shell.banner.isInstalled", VARS), t("shell.banner.clausePaused")), "v3.52.0 is installed. The canvas is paused: running agents cannot be seen."],
      [sentences(t("shell.banner.isInstalled", VARS), t("shell.banner.restartingIn", { seconds: 30 })), "v3.52.0 is installed. Restarting by itself in 30 s."],
      [sentences(t("shell.banner.isOutShort", VARS), t("shell.banner.npxRerun")), "ccdeck v3.52.0 is out. npx cannot upgrade in place, so the deck re-runs:"],
      [t("shell.banner.failedLine", { what: t("shell.banner.installFailed"), error: "EACCES" }), "Install failed: EACCES. Run it yourself:"],
      [t("shell.banner.blockSentence.git_checkout"), "This deck runs from a git checkout. Pull instead:"],
      [sentences(t("shell.banner.lostShort"), t("board.pill.outage")), "Lost connection. The canvas is paused as well: Space resumes it, but nothing new arrives until the stream is back."],
      [t("shell.banner.fetchingNpx"), "Fetching the new version with npx. This can take a minute…"],
      [sentences(t("shell.banner.restartedTo", VARS), t("shell.banner.replayed")), "Restarted. Now running v3.52.0. The canvas replayed from the event log."],
      [t("shell.rating.thanks"), "Thanks, that helps."],
      [sentences(t("shell.rating.thanks"), t("shell.rating.better")), "Thanks, that helps. Tell us what would make it better."],
      [t("shell.rating.tellUs"), "Tell us"],
    ];
    for (const [said, want] of drawn) expect(said).toBe(want);
  });
});
