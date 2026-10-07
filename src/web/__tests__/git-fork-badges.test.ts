// The Fork look's ref badges, dates and avatars: Fork's badge order, a branch
// paired with its upstream in one badge, `origin/HEAD` never shown, the `+N`
// overflow; the date column's words; an author's initials and colour.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fkRefChips, fkChipWords, FkRefBadge, FkMoreBadge, FK_REF_BADGES, FK_FONT, type FkChip } from "../components/FkRefBadge";
import { sheetText } from "./sheet-source";
import { sourceOf } from "./client-source";
import { FkAvatar, avatarTone, initials, AVATAR_TONES } from "../components/FkAvatar";
import { forkDate, forkDateAbsolute, forkDateLong } from "../git-fork-date";
import type { LogCommit, RepoHead } from "../git-graph-layout";

type Refs = LogCommit["refs"];
const refs = (r: Partial<Refs>): Pick<LogCommit, "refs"> => ({ refs: { local: [], remote: [], tags: [], head: false, ...r } });
const onDevelop: RepoHead = { branch: "develop", detached: false, sha: "a", short: "a", unborn: false };
const detached: RepoHead = { branch: null, detached: true, sha: "a", short: "a", unborn: false };
/** Every badge in order, the folded ones after the shown ones. */
const all = (r: { chips: FkChip[]; more: string[] }) => [...r.chips.map(x => (x.upstream ? `${x.name} · ${x.upstream}` : x.name)), ...r.more];
const wide = (c: Pick<LogCommit, "refs">, head: RepoHead | null = onDevelop) => fkRefChips(c, head, 320, null);

describe("a row's ref badges", () => {
  it("puts HEAD's branch first, then branches, remote-tracking branches and tags, each by name", () => {
    const r = wide(refs({ head: true, local: ["zeta", "develop", "alpha"], remote: ["upstream/alpha", "origin/alpha", "origin/zeta"], tags: ["v1.10.0", "v1.2.0"] }));
    expect(all(r)).toEqual(["develop", "alpha", "zeta · origin/zeta", "origin/alpha", "upstream/alpha", "v1.2.0", "v1.10.0"]);
    expect(r.chips[0]).toMatchObject({ kind: "local", current: true });
  });

  it("starts with HEAD itself when HEAD is detached", () => {
    const r = wide(refs({ head: true, local: ["main"], tags: ["v0.3.0"] }), detached);
    expect(r.chips[0]).toMatchObject({ kind: "head", name: "HEAD", label: "HEAD" });
    expect(r.chips.some(x => x.current)).toBe(false);
  });

  it("never shows origin/HEAD, or any remote's HEAD", () => {
    expect(all(wide(refs({ remote: ["origin/HEAD"] })))).toEqual([]);
    expect(all(wide(refs({ remote: ["origin/HEAD", "fork/HEAD", "origin/main"] })))).toEqual(["origin/main"]);
  });

  it("pairs a branch with its configured upstream in one badge", () => {
    const r = wide(refs({ local: ["feature/x"], remote: ["origin/feature/x", "fork/feature/x"], upstream: { "feature/x": "fork/feature/x" } }));
    expect(all(r)).toEqual(["feature/x · fork/feature/x", "origin/feature/x"]);
    expect(r.chips[0].title).toContain("fork/feature/x is here too");
  });

  it("pairs by name only when no upstream is configured and exactly one remote has the name", () => {
    expect(all(wide(refs({ local: ["develop"], remote: ["origin/develop"] })))).toEqual(["develop · origin/develop"]);
    expect(all(wide(refs({ local: ["develop"], remote: ["origin/develop", "fork/develop"] })))).toEqual(["develop", "fork/develop", "origin/develop"]);
    // Its upstream is configured and is somewhere else: a same-named remote here is not it.
    expect(all(wide(refs({ local: ["develop"], remote: ["fork/develop"], upstream: { develop: "origin/develop" } })))).toEqual(["develop", "fork/develop"]);
  });

  it("folds past three badges into a +N, a pair counting once", () => {
    const r = wide(refs({ local: ["a", "b", "c"], remote: ["origin/a", "origin/z"], tags: ["t"] }));
    expect(FK_REF_BADGES).toBe(3);
    expect(r.chips.map(x => x.name)).toEqual(["a", "b"]);
    expect(r.more).toEqual(["c", "origin/z", "t"]);
    expect(all(wide(refs({ local: ["a", "b"], remote: ["origin/a", "origin/b"] })))).toEqual(["a · origin/a", "b · origin/b"]);
  });

  it("cuts a long name to the badge's room, the ticket whole, and measures the bold current branch as bold", () => {
    const measure = (text: string, bold: boolean) => text.length * (bold ? 8 : 7);
    const name = "feature/bargan/VCRM-9090-make-the-invoice-builder-understand-everything";
    const r = fkRefChips(refs({ head: true, local: [name, "develop"] }), { ...onDevelop, branch: name }, 320, measure);
    const label = r.chips[0].label;
    expect(label).toContain("VCRM-9090");
    expect(measure(label, true)).toBeLessThanOrEqual(320 - 24);
    expect(label.length).toBeLessThan(name.length);
  });

  it("says each badge in words, the pairing and the checked-out branch included", () => {
    const r = wide(refs({ head: true, local: ["develop"], remote: ["origin/develop"], tags: ["v1"] }));
    expect(r.chips.map(fkChipWords)).toEqual(["develop, checked out, with origin/develop", "tag v1"]);
  });
});

describe("a badge, as the markup builds it", () => {
  const html = (chip: FkChip) => renderToStaticMarkup(createElement(FkRefBadge, { chip }));
  it("draws a remote-tracking branch with its cloud in a cell of its own", () => {
    expect(html({ kind: "remote", name: "origin/x", label: "origin/x", title: "t" })).toMatch(/<span class="fk-ref" data-kind="remote"[^>]*><span class="fk-ref-cell"><svg class="fk-ref-glyph"/);
  });
  it("draws the checked-out branch with a check, paired with its upstream's cloud box", () => {
    const m = html({ kind: "local", name: "develop", label: "develop", title: "t", current: true, upstream: "origin/develop" });
    expect(m).toMatch(/data-current="" data-paired=""/);
    expect(m).toMatch(/<span class="fk-ref-cloud"><svg/);
    expect(m).toContain('class="fk-ref-check"');
  });
  it("draws a tag with its glyph, a plain branch with none, and +N in neutral colours", () => {
    expect(html({ kind: "tag", name: "v1", label: "v1", title: "t" })).toMatch(/data-kind="tag"[^>]*><svg class="fk-ref-glyph"/);
    expect(html({ kind: "local", name: "x", label: "x", title: "t" })).not.toContain("<svg");
    expect(renderToStaticMarkup(createElement(FkMoreBadge, { names: ["a", "b"] }))).toBe('<span class="fk-ref" data-kind="more" data-tone="neutral" title="a\nb">+2</span>');
  });
  it("draws the Commit tab's refs as the same badge in its neutral colours, each kind said in words", () => {
    const m = renderToStaticMarkup(createElement(FkRefBadge, { chip: { kind: "remote", name: "origin/x", label: "origin/x", title: "remote branch origin/x" }, tone: "neutral" }));
    expect(m).toMatch(/^<span class="fk-ref" data-kind="remote" data-tone="neutral" title="remote branch origin\/x"><span class="fk-ref-cell">/);
    expect(m).toContain('<span class="vis-hidden">remote branch </span>origin/x');
    const tab = sourceOf("components/FkCommitTab.tsx");
    expect(tab).toMatch(/import \{ FkRefBadge, type FkChip \} from "\.\/FkRefBadge";/);
    expect(tab).toMatch(/<FkRefBadge chip=\{chip\} tone="neutral" \/>/);
  });
});

describe("the date column", () => {
  // 2026-10-07 10:00 local time.
  const now = new Date(2026, 9, 7, 10, 0).getTime();
  const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).toISOString();
  it("says Today and Yesterday at the time, and the day in the locale's order before that", () => {
    expect(forkDate(at(7, 9, 38), now, "en-GB")).toBe("Today at 09:38");
    expect(forkDate(at(6, 22, 22), now, "en-GB")).toBe("Yesterday at 22:22");
    expect(forkDate(at(5, 12, 53), now, "en-GB")).toBe("5 Oct 2026 at 12:53");
    // ICU writes the space before PM as a narrow no-break space on newer releases.
    expect(forkDate(at(5, 12, 53), now, "en-US")).toMatch(/^Oct 5, 2026 at 12:53[\s ]PM$/);
  });
  it("writes a date from the future as the day, and nothing for a date that does not parse", () => {
    expect(forkDate(at(8, 9, 0), now, "en-GB")).toBe("8 Oct 2026 at 09:00");
    expect(forkDate("not a date", now)).toBe("");
    expect(forkDateAbsolute(at(7, 9, 38), "en-GB")).toBe("7 Oct 2026 at 09:38");
  });
  it("gives the Commit tab the long form, with seconds and the zone", () => {
    expect(forkDateLong(new Date(2026, 9, 5, 16, 50, 54).toISOString(), "en-GB")).toMatch(/^5 October 2026 at 16:50:54 \S+/);
  });
});

describe("an author's avatar", () => {
  it("says two initials, one for a name of one word, none of a bot's brackets", () => {
    expect(initials("Alex Morgan")).toBe("AM");
    expect(initials("Tomás Ortega")).toBe("TO");
    expect(initials("dependabot[bot]")).toBe("D");
    expect(initials("ada")).toBe("A");
    expect(initials("  ")).toBe("?");
  });
  it("keeps one colour per person, by e-mail, then by name", () => {
    expect(avatarTone("Alex Morgan", "alex@shop.co")).toBe(avatarTone("A. Morgan", "ALEX@shop.co "));
    expect(avatarTone("Mei Lin", "")).toBe(avatarTone("mei lin", ""));
    const tones = new Set(["a@x", "b@x", "c@x", "d@x", "e@x", "f@x", "g@x", "h@x", "i@x", "j@x"].map(e => avatarTone("", e)));
    expect(tones.size).toBeGreaterThan(2);
    for (const t of tones) expect(t).toBeLessThan(AVATAR_TONES);
  });
  it("is hidden from screen readers: the name beside it is the words", () => {
    expect(renderToStaticMarkup(createElement(FkAvatar, { name: "Alex Morgan", email: "a@x", size: "row" }))).toMatch(/^<span class="fkm-ava" data-size="row" data-tone="\d" aria-hidden="true">AM<\/span>$/);
  });
  it("is the one avatar the rows, the commit strip and the Commit tab draw, so one person is one colour in all three", async () => {
    const strip = await import("../components/FkCommitStrip");
    expect(strip.avatarTone).toBe(avatarTone);
    for (const f of ["components/FkCommitStrip.tsx", "components/FkCommitTab.tsx", "components/GitGraph.tsx"]) {
      expect(sourceOf(f), f).toMatch(/import \{ FkAvatar \} from "\.\/FkAvatar";/);
      expect(sourceOf(f), f).not.toMatch(/0x811c9dc5|function initialsOf/);
    }
  });
});

describe("the font a badge's words are measured in", () => {
  it("is the look's own UI font, as the sheet sets it, stated so nothing asks the page for a style", () => {
    const set = [...sheetText().matchAll(/--fk-font:\s*([^;]+);/g)].map(m => m[1].trim());
    expect(set.length).toBeGreaterThan(0);
    for (const v of set) expect(v).toBe(FK_FONT);
    expect(sourceOf("components/FkRefBadge.tsx")).not.toMatch(/getComputedStyle/);
  });
});
