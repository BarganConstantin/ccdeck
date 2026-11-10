// The Jira panel's dialog, menus and issue page, and the shared integration
// surfaces they sit on, as V4's Figma draws them: the dialog on the panel, the
// sunk search field, the Integrations glyph, the row menu and Move, the bar for
// several chosen issues, the active sprint's lozenge, Show more, Clear filters,
// sub-tasks, section heads, Flagged and Priority, attachments, a comment's age
// and the write band. Reads the sheets and the components as text; the
// contrast of every new bed is measured in every theme.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { jiraInstant } from "../jira-board";
import { THEMES, color, contrast, over, panelOf, scopeOf } from "./integrations-palette";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const integrations = strip(read("styles/integrations.css"));
const jira = strip(read("styles/jira.css"));

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\})\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}
/** True when the named markers appear in `src` in this order. */
const inOrder = (src: string, markers: string[]) => {
  const at = markers.map(m => src.indexOf(m));
  return at.every(i => i >= 0) && at.every((i, n) => n === 0 || i > at[n - 1]);
};

describe("the dialog", () => {
  it("fills the whole dialog, list column too, with the panel, and sinks the search field into it at 12px", () => {
    expect(rule(integrations, ".modal.ig-modal")).toMatch(/background:\s*var\(--panel\)/);
    const search = rule(integrations, ".ig-search-input");
    expect(search).toMatch(/background:\s*var\(--sunken\)/);
    expect(search).toMatch(/font-size:\s*calc\(12px \+ var\(--ui-text-increase, 0px\)\)/);
  });

  it("marks every provider's dialog with the Integrations glyph", () => {
    const modal = read("components/IntegrationModal.tsx");
    expect(modal).toContain('<span className="ig-title-glyph" aria-hidden><KitIcon name="integrations" /></span>{def.label}');
    expect(modal).not.toContain("<Glyph />");
  });
});

describe("the backlog", () => {
  it("opens a 220-wide row menu of 28-high items: Open, Move…, a rule, Copy link, and no parked write", () => {
    expect(rule(jira, ".jr-actions-pop")).toMatch(/width:\s*min\(220px/);
    const item = rule(jira, ".jr-action-item");
    expect(item).toMatch(/min-height:\s*var\(--row-table\)/);
    expect(item).toMatch(/padding:\s*0 8px/);
    expect(item).toMatch(/border-radius:\s*var\(--r-tag\)/);
    expect(item).toMatch(/font-weight:\s*400/);
    expect(rule(jira, ".jr-action-sep")).toMatch(/height:\s*1px/);
    const pop = read("components/JiraMovePopover.tsx");
    expect(inOrder(pop, ["integrations.rowMenu.open", "integrations.movePop.move\"", "jr-action-sep", "integrations.rowMenu.copyLink"])).toBe(true);
    // Open and Copy link belong to one issue's menu; several chosen get Move only.
    expect(pop).toContain("{single && onOpen &&");
    expect(pop).toContain("{single && onCopyLink &&");
    // Its comment names the writes it waits on; the code draws none of them.
    expect(pop.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")).not.toMatch(/assign|delete|sub-?task|transition/i);
    expect(en["integrations.rowMenu.open"]).toBe("Open");
    expect(en["integrations.rowMenu.copyLink"]).toBe("Copy link");
    const backlog = read("components/JiraBacklog.tsx");
    expect(backlog).toContain("onOpen={() => pick(moveMenu.issue.key, { ctrlKey: false, metaKey: false, shiftKey: false })}");
    expect(backlog).toContain("const ok = await copyText(issue.url);");
  });

  it("draws Move as a 320 popover: the title 600, the label 500, the field 28 on --sunken", () => {
    expect(rule(jira, ".jr-move-pop")).toMatch(/width:\s*min\(320px/);
    expect(rule(jira, ".jr-move-pop h3")).toMatch(/font-weight:\s*600/);
    expect(rule(jira, ".jr-move-pop label")).toMatch(/font-weight:\s*500/);
    const select = rule(jira, ".jr-move-pop select");
    expect(select).toMatch(/height:\s*28px/);
    expect(select).toMatch(/background:\s*var\(--sunken\)/);
    expect(select).toMatch(/border:\s*1px solid var\(--ctl-edge\)/);
  });

  it("puts the selection's actions at the bar's end with Clear last, in the accent at 12/500", () => {
    expect(rule(jira, ".jr-selection-actions")).toMatch(/margin-left:\s*auto/);
    const clear = rule(jira, ".jr-selection .jr-selection-clear");
    expect(clear).toMatch(/color:\s*var\(--accent\)/);
    expect(clear).toMatch(/font-size:\s*calc\(12px/);
    expect(clear).toMatch(/font-weight:\s*500/);
    const backlog = read("components/JiraBacklog.tsx");
    const bar = backlog.slice(backlog.indexOf('<span className="jr-selection-actions">'));
    expect(inOrder(bar, ["integrations.list.moveSelected", "integrations.list.removeBlocked", "integrations.list.clear\")"])).toBe(true);
  });

  it("puts the active sprint's lozenge 16 high at 11/500 on the panel's tint", () => {
    const badge = rule(jira, ".jr-badge");
    expect(badge).toMatch(/line-height:\s*calc\(16px/);
    expect(badge).toMatch(/font-weight:\s*500/);
    expect(badge).toMatch(/color-mix\(in srgb, var\(--accent\) 14%, var\(--panel\)\)/);
  });

  it("keeps the open issue's key at the key's own weight", () => {
    expect(jira).not.toMatch(/\.jr-row\[data-current\][^{]*\.jr-key\s*\{/);
  });

  it("writes Show more as quiet words, 12/400 in --muted, with no edge", () => {
    expect(read("components/JiraBacklog.tsx")).toContain('<button type="button" className="jr-more"');
    const more = rule(jira, ".jr-more");
    expect(more).toMatch(/border:\s*0/);
    expect(more).toMatch(/color:\s*var\(--muted\)/);
    expect(more).toMatch(/font-size:\s*calc\(12px/);
    expect(more).toMatch(/font-weight:\s*400/);
    expect(more).toMatch(/min-height:\s*28px/);
  });

  it("does not count Hide done as a filter Clear filters clears", () => {
    const panel = read("components/JiraPanel.tsx");
    expect(panel).toContain('const clearable = mine || attention || quick.length > 0 || search.trim() !== "";');
    expect(panel).toContain('{clearable && <button type="button" className="jr-link-btn jr-clear"');
    const clear = /const clearFilters = \(\) => \{([^}]*)\}/.exec(panel)![1];
    expect(clear).not.toContain("setHideDone");
  });
});

describe("an issue's page", () => {
  it("lists sub-tasks as single 32-high rows with no box, one line at the default detail width", () => {
    expect(rule(jira, ".jr-detail-subtasks")).not.toMatch(/border|overflow/);
    expect(jira).not.toMatch(/\.jr-detail-subtasks li \+ li/);
    const sub = rule(jira, ".jr-detail-sub");
    expect(sub).toMatch(/min-height:\s*32px/);
    expect(sub).toMatch(/padding:\s*0 8px/);
    // CHANGED ON PURPOSE (owner 2026-11-10 critique: type scale 11/12/13/16/22, radii 4/8/pill): a list row is a control, at 4.
    expect(sub).toMatch(/border-radius:\s*var\(--r-ctl\)/);
    expect(jira).toContain("@container jira-detail (max-width: 360px)");
    expect(jira).not.toContain("@container jira-detail (max-width: 440px)");
  });

  it("sets section heads 12/600 in --text-secondary, counts in mono 11 and the description in --text-secondary", () => {
    const head = rule(jira, ".jr-detail-section h3");
    expect(head).toMatch(/font-size:\s*calc\(12px/);
    expect(head).toMatch(/font-weight:\s*600/);
    expect(head).toMatch(/color:\s*var\(--text-secondary\)/);
    const count = rule(jira, ".jr-count");
    expect(count).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(count).toMatch(/font-size:\s*calc\(11px/);
    expect(rule(jira, ".jr-detail-desc > .jr-html")).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(read("components/JiraIssueDetail.tsx")).toContain('className="jr-detail-section jr-detail-desc"');
  });

  it("shows Flagged as a neutral chip beside the status, and Priority as a field after Reporter, Estimate before Due", () => {
    const chip = rule(jira, ".jr-flag-chip");
    expect(chip).toMatch(/background:\s*var\(--ctl-fill\)/);
    expect(chip).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(chip).toMatch(/font-weight:\s*500/);
    expect(chip).toMatch(/line-height:\s*16px/);
    const detail = read("components/JiraIssueDetail.tsx");
    const start = detail.indexOf('<p className="jr-detail-state">');
    const state = detail.slice(start, detail.indexOf("</p>", start));
    expect(state).toContain('<span className="jr-flag-chip">{t("integrations.flagged")}</span>');
    expect(state).not.toMatch(/PriorityIcon|FlagGlyph/);
    const fields = ["assignee", "reporter", "priority", "sprint", "epic", "fixVersions", "labels", "components", "estimate", "time", "due"];
    expect(inOrder(detail, fields.map(f => `t("integrations.field.${f}")`))).toBe(true);
    expect(en["integrations.field.priority"]).toBe("Priority");
  });

  it("lists an attachment with the 14 file glyph and its size in mono 11, its date in the size's title", () => {
    const detail = read("components/JiraIssueDetail.tsx");
    expect(detail).toContain('<KitIcon name="file" className="jr-file-glyph" />');
    expect(detail).toContain('<span className="jr-file-size" title={jiraDate(a.created) || undefined}>{fileSize(a.size)}</span>');
    const size = rule(jira, ".jr-file-size");
    expect(size).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(size).toMatch(/font-size:\s*calc\(11px/);
  });

  it("says when a comment was written as an age, the moment itself in its title", () => {
    const detail = read("components/JiraIssueDetail.tsx");
    expect(detail).toContain("<CommentTime iso={c.created} />");
    expect(detail).toContain('<time className="jr-dim" dateTime={iso} title={full}>{at == null ? full : agoText(Date.now() - at, t)}</time>');
    // Jira's own offsets carry no colon; the moment is still read.
    expect(jiraInstant("2026-11-05T21:37:00.000+0300")).toBe(Date.UTC(2026, 10, 5, 18, 37));
    expect(jiraInstant("not a time")).toBeNull();
    expect(jiraInstant(null)).toBeNull();
  });

  it("keeps the empty board's sentence rule off the failure note's heading, which is 13 at 16 in --text", () => {
    expect(jira).toMatch(/\.jr-state > p\s*\{/);
    expect(jira).not.toMatch(/\.jr-state p\s*\{/);
    const title = rule(integrations, ".ig-failure-title");
    expect(title).toMatch(/color:\s*var\(--text\)/);
    expect(title).toMatch(/line-height:\s*16px/);
  });

  it("puts an unconfirmed comment in the shared write band, I checked inside it, and Add comment is primary", () => {
    const band = rule(integrations, ".ig-write-band");
    expect(band).toMatch(/padding:\s*6px 8px/);
    expect(band).toMatch(/border-radius:\s*var\(--r-panel\)/);
    expect(band).toMatch(/font-size:\s*calc\(12px/);
    expect(band).toMatch(/background:\s*color-mix\(in srgb, var\(--warn\) 16%, var\(--panel\)\)/);
    expect(rule(integrations, ".ig-write-band-actions .btn")).toMatch(/--ctl-h:\s*28px/);
    const form = read("components/JiraCommentForm.tsx");
    expect(form).toContain('className="btn primary"');
    expect(form).toContain("<IntegrationWriteBand message=");
    expect(en["integrations.comment.checkedShort"]).toBe("I checked");
  });
});

describe("the new beds keep their words readable", () => {
  for (const theme of THEMES) {
    it(`${theme}: band, chip, lozenge, Clear, Show more, the field and the Explore notes clear 4.5:1, the band's glyph 3:1`, () => {
      const scope = scopeOf(theme);
      const panel = panelOf(scope);
      const ink = (fg: string, bg: string) => {
        const bed = over(color(bg, scope), panel);
        return contrast(over(color(fg, scope), bed), bed);
      };
      const bandBg = /background:\s*([^;]+);/.exec(rule(integrations, ".ig-write-band"))![1].trim();
      const failures: string[] = [];
      const check = (what: string, ratio: number, floor = 4.5) => {
        if (Math.round(ratio * 100) / 100 < floor) failures.push(`${what}: ${ratio.toFixed(2)}`);
      };
      check("band words", ink("var(--text)", bandBg));
      check("band glyph", ink("var(--warn)", bandBg), 3);
      check("Flagged chip", ink("var(--text-secondary)", "var(--ctl-fill)"));
      check("Active lozenge", ink("var(--text)", "color-mix(in srgb, var(--accent) 14%, var(--panel))"));
      check("Clear on the selection bar", ink("var(--accent)", "var(--selected)"));
      check("Explore note", ink("var(--text-secondary)", "var(--ctl-fill)"));
      check("Explore failure", ink("var(--text)", "var(--err-12)"));
      check("Show more", ink("var(--muted)", "var(--panel)"));
      check("search placeholder", ink("var(--muted)", "var(--sunken)"));
      expect(failures).toEqual([]);
    });
  }
});
