// The integration panels as V4's Figma draws them: the modal's frame and header, the freshness
// pill, the failure note, the loading skeleton, Jira's toolbar, rows and detail, the bar for
// several chosen issues, the forge panel's toolbar, tabs, rows and branch table, and the New
// session popover. Reads the sheets and the components as text, so a drift in any of them fails
// here with the thing it drifted from; the browser pass measures the same sizes on screen.
//
// Writes to providers are parked, so this also holds the set of files that write to one: a
// restyle may not add a control that writes.
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const integrations = strip(read("styles/integrations.css"));
const jira = strip(read("styles/jira.css"));
const forgePanel = strip(read("styles/forge-panel.css"));
const forgeLists = strip(read("styles/forge-lists.css"));
const forgeDetail = strip(read("styles/forge-detail.css"));
const stage = strip(read("styles/terminal-stage.css"));

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("the modal's frame and header", () => {
  it("is 1120 x 760, held to the window as it was", () => {
    const r = rule(integrations, ".modal.ig-modal");
    expect(r).toMatch(/width:\s*min\(1120px, 90vw\)/);
    expect(r).toMatch(/height:\s*min\(760px, 90dvh\)/);
    expect(r).toMatch(/max-height:\s*90dvh/);
  });

  it("has a 44 header with the title at 14/600 and the connection name in 11px mono", () => {
    const head = rule(integrations, ".ig-head");
    expect(head).toMatch(/min-height:\s*44px/);
    expect(head).toMatch(/border-bottom:\s*1px solid var\(--line-soft\)/);
    const title = rule(integrations, ".ig-title");
    expect(title).toMatch(/font-size:\s*calc\(14px/);
    expect(title).toMatch(/font-weight:\s*600/);
    const name = rule(integrations, ".ig-head .ig-conn-name");
    expect(name).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(name).toMatch(/font-size:\s*calc\(11px/);
    expect(name).toMatch(/color:\s*var\(--muted\)/);
  });

  it("draws freshness and Refresh at the header's end, through a slot the modal makes", () => {
    const modal = read("components/IntegrationModal.tsx");
    expect(modal).toContain('className="ig-head-end"');
    expect(modal).toContain("FreshnessSlot.Provider");
    expect(read("components/IntegrationFreshness.tsx")).toContain("createPortal(line, slot)");
  });

  it("splits at a 1px divider with the list 640 beside Jira's detail and 480 beside a forge's", () => {
    expect(integrations).toMatch(/\.ig-split\[data-detail\]:not\(\[data-drill-in\]\)\s*\{[^}]*minmax\(0, 1fr\) 1px min\(var\(--ig-detail-w\), calc\(100% - 421px\)\)/);
    expect(read("integrations/layout.ts")).toMatch(/export const SPLITTER = 1;/);
    // 1120 x 0.4277 = 479 (so the list is 640); 1120 x 0.5705 = 639 (so the list is 480).
    expect(read("components/JiraPanel.tsx")).toContain("automaticDetailShare={0.4277}");
    expect(read("components/forge/ForgePanel.tsx")).toContain("automaticDetailShare={0.5705}");
    expect(Math.round(1120 * 0.4277)).toBe(479);
    expect(Math.round(1120 * 0.5705)).toBe(639);
    expect(rule(integrations, ".ig-splitter")).toMatch(/background:\s*var\(--line-soft\)/);
  });
});

describe("the freshness pill", () => {
  it("is 24 high, r6, the panel's fill on a --line edge, 12/400 in --text", () => {
    const r = rule(integrations, ".ig-fresh");
    expect(r).toMatch(/height:\s*24px/);
    expect(r).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(r).toMatch(/border-radius:\s*var\(--r-ctl\)/);
    expect(r).toMatch(/background:\s*var\(--panel\)/);
    expect(r).toMatch(/color:\s*var\(--text\)/);
    expect(r).toMatch(/font-weight:\s*400/);
  });

  it("is never amber, stale or not: amber means an agent waits", () => {
    const pillRules = integrations.split("}").filter(block => /\.ig-fresh|\.ig-freshness/.test(block));
    for (const block of pillRules) expect(block).not.toMatch(/--warn|amber/);
  });
});

describe("the failure note and the skeleton", () => {
  it("is a panel-filled note on a --line-soft edge at --r-node, 12 inside, with no mark", () => {
    const r = rule(integrations, ".ig-failure");
    expect(r).toMatch(/border:\s*1px solid var\(--line-soft\)/);
    expect(r).toMatch(/border-radius:\s*var\(--r-node\)/);
    expect(r).toMatch(/padding:\s*12px/);
    expect(r).toMatch(/gap:\s*12px/);
    const note = read("components/IntegrationFailureNote.tsx");
    expect(note).not.toContain("ErrorMark");
    expect(note).not.toContain("WarnMark");
  });

  it("writes the heading 13/600, the sentence 12px and the provider's words in 11px mono --muted", () => {
    expect(rule(integrations, ".ig-failure-title")).toMatch(/font-size:\s*calc\(13px/);
    expect(rule(integrations, ".ig-failure-body")).toMatch(/color:\s*var\(--text-secondary\)/);
    const said = rule(integrations, ".ig-failure-said");
    expect(said).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(said).toMatch(/color:\s*var\(--muted\)/);
  });

  it("keeps every reason, and asks for the certificate or the network behind it on a TLS failure", () => {
    const en = read("i18n/areas/integrations/en.ts");
    expect(en).toContain("Check the certificate on the server, or the network in between.");
    for (const kind of ["auth", "expired", "permission", "unreachable", "tls", "rate-limit", "incompatible", "not-found", "network", "unavailable", "invalid"]) {
      expect(read("integrations/failure.ts"), kind).toContain(`case "${kind}"`);
    }
  });

  it("draws five rows 28 high 12 apart, each a 14 dot and a 120 x 8 bone and a 48 x 8 bone", () => {
    expect(rule(integrations, ".ig-skeleton")).toMatch(/gap:\s*12px/);
    expect(rule(integrations, ".ig-skeleton i")).toMatch(/height:\s*28px/);
    expect(rule(integrations, ".ig-skeleton i::before")).toMatch(/width:\s*14px;\s*height:\s*14px;\s*border-radius:\s*7px/);
    expect(rule(integrations, ".ig-skeleton i b")).toMatch(/width:\s*120px;[^}]*height:\s*8px/);
    expect(rule(integrations, ".ig-skeleton i::after")).toMatch(/width:\s*48px;\s*height:\s*8px/);
    expect(integrations).toMatch(/\.ig-skeleton i::before, \.ig-skeleton i::after, \.ig-skeleton i b\s*\{[^}]*var\(--ctl-fill\)/);
  });
});

describe("Jira", () => {
  it("has a 28 board button 'Board: name' at 13/500 and 24 round chips at 12/400", () => {
    const board = rule(jira, ".jr-board-btn");
    expect(board).toMatch(/min-height:\s*28px/);
    expect(board).toMatch(/font-weight:\s*500/);
    // the colon is part of the translated word, not drawn by the sheet
    expect(read("components/JiraPanel.tsx")).toContain('t("integrations.panel.boardPrefix")');
    expect(read("i18n/areas/integrations/en.ts")).toContain('"integrations.panel.boardPrefix": "Board:"');
    expect(jira).not.toMatch(/content:\s*":"/);
    const chip = rule(jira, "button.btn.jr-chip");
    expect(chip).toMatch(/height:\s*24px/);
    expect(chip).toMatch(/border-radius:\s*var\(--r-pill\)/);
    expect(chip).toMatch(/font-size:\s*calc\(12px/);
    expect(chip).toMatch(/font-weight:\s*400/);
  });

  it("has 28 group heads and 32 rows at r8, the selected row neutral, no blue .31", () => {
    expect(rule(jira, ".jr-group-toggle")).toMatch(/min-height:\s*28px/);
    const row = rule(jira, ".jr-row");
    expect(row).toMatch(/min-height:\s*32px/);
    expect(row).toMatch(/border-radius:\s*var\(--r-panel\)/);
    expect(rule(integrations, ".modal.ig-modal") + integrations).not.toMatch(/--ig-sel-fill:\s*var\(--accent-dim\)/);
    expect(integrations).toMatch(/--ig-sel-fill:\s*var\(--selected\)/);
  });

  it("draws a checkbox on a row chosen with others, and none on the rest", () => {
    // only while the board is in selection mode with more than one chosen: a plain click that opens a row sets data-picked too
    expect(jira).toMatch(/\.jr-board\[data-multi\] \.jr-row\[data-picked\] \.jr-toggle-space::before/);
    expect(jira).not.toMatch(/(^|\})\s*\.jr-row\[data-picked\] \.jr-toggle-space::before/);
    expect(read("components/JiraBacklog.tsx")).toContain("data-multi={(selectionMode && picked.size > 1) || undefined}");
    // the square has a border of its own, in forced colours too
    expect(rule(jira, ".jr-board[data-multi] .jr-row[data-picked] .jr-toggle-space::before")).toMatch(/border:\s*1px solid/);
    expect(strip(read("styles/touch-and-forced-colours.css"))).toMatch(/\.jr-board\[data-multi\] \.jr-row\[data-picked\] \.jr-toggle-space::before\s*\{[^}]*border:\s*1px solid CanvasText/);
  });

  it("writes the key 12/400 mono --muted and the status chip 16 high at 11/500", () => {
    const key = rule(jira, ".jr-key");
    expect(key).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(key).toMatch(/font-weight:\s*400/);
    expect(key).toMatch(/color:\s*var\(--muted\)/);
    const status = rule(jira, ".jr-status, .jr-panel .jr-status.ig-chip");
    expect(status).toMatch(/padding:\s*1px 6px/);
    expect(status).toMatch(/line-height:\s*14px/);
    expect(status).toMatch(/font-weight:\s*500/);
    expect(status).toMatch(/border-radius:\s*var\(--r-tag\)/);
  });

  it("gives the detail a 24 bar, a 14/600 title, plain 28 field rows, unboxed comments and a 28 compose field", () => {
    expect(rule(integrations, ".ig-detail-bar")).toMatch(/min-height:\s*24px/);
    expect(rule(jira, ".jr-detail-title")).toMatch(/font-size:\s*calc\(14px[^;]*;\s*font-weight:\s*600/);
    expect(rule(jira, ".jr-fields")).toMatch(/grid-template-columns:\s*84px minmax\(0, 1fr\)/);
    expect(rule(jira, ".jr-field dd")).toMatch(/min-height:\s*28px/);
    expect(rule(jira, ".jr-comment")).not.toMatch(/box-shadow|border/);
    const compose = rule(jira, ".jr-comment-compose textarea");
    expect(compose).toMatch(/height:\s*28px/);
    expect(compose).toMatch(/background:\s*var\(--sunken\)/);
  });

  it("makes the status itself the control that changes it, behind the same list of workflow actions", () => {
    const t = read("components/JiraTransition.tsx");
    expect(t).toContain("jr-status-btn");
    expect(t).toContain("/transitions");
    expect(read("components/JiraIssueDetail.tsx")).toContain("status={issue.status.name}");
  });
});

describe("the bar for several chosen issues", () => {
  it("is 40 high on --selected, with the count, Move outlined and Clear a plain accent word", () => {
    const bar = rule(jira, ".jr-selection");
    expect(bar).toMatch(/min-height:\s*40px/);
    expect(bar).toMatch(/background:\s*var\(--selected\)/);
    expect(jira).toMatch(/\.jr-link-btn\s*\{[^}]*color:\s*var\(--accent\)/);
    const backlog = read("components/JiraBacklog.tsx");
    expect(backlog).toContain('className="jr-link-btn jr-selection-clear"');
    const move: Record<string, string> = { ro: "Mută", de: "Verschieben", es: "Mover", fr: "Déplacer", ja: "移動", ko: "이동", "pt-BR": "Mover", "zh-CN": "移动", "zh-TW": "移動" };
    expect(read("i18n/areas/integrations/en.ts")).toContain('"integrations.list.moveSelected": "Move"');
    for (const [loc, word] of Object.entries(move)) {
      const file = read(`i18n/areas/integrations/${loc}.ts`);
      expect(file, loc).toContain(`"integrations.list.moveSelected": "${word}"`);
      // the verb is the one that locale's own Alt+M sentence already uses
      expect(/"integrations.list.instructionsMove": "([^\n]*)"/.exec(file)?.[1], loc).toContain(word);
    }
  });

  it("writes the hint at the foot of the list with the sentence the screen-reader instructions already carry, only where Move exists, and not under a finger", () => {
    expect(read("components/JiraBacklog.tsx")).toContain('t("integrations.list.instructionsMove").trim()');
    expect(jira).toMatch(/@media \(pointer: coarse\)\s*\{[\s\S]*?\.jr-selection-hint\s*\{\s*display:\s*none/);
    expect(read("components/JiraBacklog.tsx")).toMatch(/\{canMove && selectionMode && selectedItems\.length > 0 && <p className="jr-selection-hint">/);
  });

  it("leaves Assign and Delete out", () => {
    const backlog = read("components/JiraBacklog.tsx");
    expect(backlog).not.toMatch(/Assign|Delete/);
  });
});

describe("the forge panel", () => {
  it("shows the repository's name alone in a 28 trigger, and the tabs as 24 round outlined pills at the toolbar's right", () => {
    const picker = read("components/forge/RepoPicker.tsx");
    // the group stays as a quiet prefix that gives way first, so two owners' "api" read apart
    expect(picker).toContain('<span className="fgl-repo-group">{parts.group}</span><span className="fgl-repo-name">{parts.name}</span>');
    expect(rule(forgeLists, ".fgl-repo-group")).toMatch(/flex:\s*0 1 auto/);
    expect(rule(forgeLists, ".fgl-repo-name")).toMatch(/flex:\s*none/);
    expect(rule(forgeLists, "button.btn.fgl-repo-trigger")).toMatch(/min-height:\s*28px/);
    const tabs = rule(forgePanel, ".fg-tabs .uh-range-btn");
    expect(tabs).toMatch(/height:\s*24px/);
    expect(tabs).toMatch(/border-radius:\s*var\(--r-pill\)/);
    expect(tabs).toMatch(/font-weight:\s*400/);
    expect(rule(forgePanel, ".fg-tabs")).toMatch(/margin:\s*0 0 0 auto/);
    const panel = read("components/forge/ForgePanel.tsx");
    const toolbar = panel.slice(panel.indexOf('<div className="fg-toolbar">'), panel.indexOf('<div className="fg-searchbar">'));
    expect(toolbar).toContain('className="uh-range fg-tabs"');
    expect(toolbar).toContain("<RepoPicker");
  });

  it("keeps the detail tabs' counts (nothing else shows them) as outlined pills", () => {
    expect(rule(forgeDetail, ".fd-sections .uh-range-btn")).toMatch(/border-radius:\s*var\(--r-pill\)/);
    expect(read("components/forge/ChangeDetail.tsx")).toContain("fd-section-count");
  });

  it("draws pull request rows 44 high with a leading state glyph, and detail fields as plain rows", () => {
    expect(rule(forgePanel, ".fg-row")).toMatch(/min-height:\s*44px/);
    expect(read("components/forge/ChangesTab.tsx")).toContain('className="fgl-state"');
    expect(rule(forgeDetail, ".fd-facts")).not.toMatch(/border|background/);
    expect(rule(forgeDetail, ".fd-fact")).toMatch(/grid-template-columns:\s*84px minmax\(0, 1fr\)/);
  });

  it("draws a branch as one mono line 40 high with Default, Protected and Stale chips, 'N ahead' and '#N open'", () => {
    expect(forgeLists).toMatch(/\.fg-rows > li\.fgl-branch\s*\{[^}]*min-height:\s*40px/);
    const code = rule(forgeLists, ".fgl-branch-code");
    expect(code).toMatch(/font-size:\s*calc\(13px/);
    const chip = rule(forgeLists, ".fgl-branch-name .fg-badge");
    expect(chip).toMatch(/height:\s*20px/);
    expect(chip).toMatch(/border:\s*1px solid var\(--line-soft\)/);
    const tab = read("components/forge/BranchesTab.tsx");
    expect(tab).toContain('t("forge.badge.stale")');
    expect(tab).toContain('t("forge.branches.ahead"');
    expect(tab).toContain('t("forge.branches.both"');
    expect(tab).not.toContain('join(" · ")');
    expect(forgeLists).not.toMatch(/text-transform:\s*(lowercase|capitalize)/);
    expect(tab).toContain('className="fgl-change-text"');
    const en = read("i18n/areas/forge/en.ts");
    expect(en).toContain('"forge.branches.ahead": "{n} ahead"');
  });

  it("keeps today's grouping for the branches: Mine needs the signed-in login and the client has none", () => {
    expect(read("components/forge/BranchesTab.tsx")).toContain('id="branches-stale"');
    expect(read("components/forge/BranchesTab.tsx")).not.toMatch(/"Mine"|forge\.branches\.mine/);
  });
});

describe("the New session popover", () => {
  it("is the kit's box: 12 radius, the panel's fill on a --line edge, sentence-case head", () => {
    const pop = rule(stage, ".anchored-popover.ns-pop");
    expect(pop).toMatch(/border-radius:\s*var\(--r-overlay\)/);
    expect(pop).toMatch(/border:\s*1px solid var\(--line\)/);
    expect(pop).toMatch(/background:\s*var\(--panel\)/);
    expect(rule(stage, ".ns-title")).not.toMatch(/uppercase/);
  });

  it("keeps every field and what Start does, and adds no prompt field", () => {
    const src = read("components/terminal/NewSessionPopover.tsx");
    for (const word of ["Agent", "Project", "Model", "Permissions", "In a new git worktree", "project-path"]) expect(src, word).toContain(word);
    expect(src).toContain("onStart(agent, target.cwd, options)");
    expect(src).not.toMatch(/prompt/i);
  });
});

describe("no write to a provider was added", () => {
  function sources(dir: string): string[] {
    return readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? sources(`${dir}/${entry.name}`) : /\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : []);
  }
  it("keeps the same files that write: the Jira comment and status forms, and the client's own calls", () => {
    const writers = [...sources("components"), ...sources("integrations"), "jira-api.ts", "jira-write-state.ts"]
      .filter(file => /method:\s*"(POST|PUT|PATCH|DELETE)"/.test(read(file)) && /integration|jira|forge/i.test(file))
      .sort();
    expect(writers).toEqual(["components/JiraCommentForm.tsx", "components/JiraTransition.tsx", "integrations/client.ts", "jira-api.ts", "jira-write-state.ts"]);
  });
});
