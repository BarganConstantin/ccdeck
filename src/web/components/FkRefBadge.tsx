import React from "react";
import { fitBranch } from "../git-chip";
import { cachedMeasure, type Measure } from "../git-path-fit";
import { remoteBranch, type LogCommit, type RepoHead } from "../git-graph-layout";

// The ref badges of a history row in the git view's Fork look: a rectangle in
// the commit's lane colour per branch, remote-tracking branch and tag, told
// apart by glyph and weight the way Fork tells them apart. A branch and its
// upstream on the same commit share one badge; `origin/HEAD` is never shown.

/** The most badges a row shows before folding the rest into `+N`. */
export const FK_REF_BADGES = 3;
/** A badge's widest box, and the room under a 680px history. */
export const FK_REF_ROOM = 320;
export const FK_REF_ROOM_NARROW = 160;
/** A badge's words: 12px in the look's UI font (git-graph-fork.css). */
export const FK_REF_PX = 12;
/** The chrome around a badge's words: 5px padding each side and the 1px edge;
 *  the ✓ and its gap; a tag's glyph and gap; a remote's icon cell. */
const EDGE = 12;
const CHECK = 12;
const TAG = 14;
const CELL = 20;

export interface FkChip {
  kind: "head" | "local" | "remote" | "tag";
  /** The ref as git names it: `develop`, `origin/develop`, `v1.4.0`, `HEAD`. */
  name: string;
  /** The words the badge shows, cut to its room. */
  label: string;
  /** Every name the badge stands for, in words. */
  title: string;
  /** The branch HEAD is on. */
  current?: boolean;
  /** The remote-tracking branch shown with this branch, its upstream. */
  upstream?: string;
}

const order = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byName = (a: string, b: string) => order.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
/** `origin/HEAD` and its kind: a pointer at another ref, which is listed
 *  itself. A branch whose own name ends in `/HEAD` (`origin/fix/HEAD`) is not
 *  one. */
export const isRemoteHead = (ref: string) => remoteBranch(ref) === "HEAD";

/**
 * A commit's badges in Fork's order — HEAD (detached) or HEAD's branch first,
 * then the other branches, the remote-tracking branches and the tags, each
 * group by name — with each branch paired with its upstream when both are on
 * the commit: by the configured upstream, or, when none is configured, the
 * one remote-tracking branch of the same name. Past FK_REF_BADGES the last
 * ones fold into `more`. Each name is cut to the badge's room the way the
 * card's branch chip cuts it (git-chip.ts); `measure` null leaves it whole.
 */
export function fkRefChips(c: Pick<LogCommit, "refs">, head: RepoHead | null, room: number, measure: ((text: string, bold: boolean) => number) | null): { chips: FkChip[]; more: string[] } {
  const r = c.refs;
  const onHead = r.head && head !== null;
  const headBranch = onHead && head && !head.detached && head.branch && r.local.includes(head.branch) ? head.branch : null;
  const fit = (name: string, chrome: number, bold: boolean) => {
    const max = Math.max(48, room - chrome);
    return measure ? fitBranch(name, text => measure(text, bold) <= max) : name;
  };
  const remotes = r.remote.filter(x => !isRemoteHead(x));
  const taken = new Set<string>();
  const upstreamOf = (local: string): string | null => {
    const configured = r.upstream?.[local];
    if (configured !== undefined) return remotes.includes(configured) && !taken.has(configured) ? configured : null;
    const same = remotes.filter(x => remoteBranch(x) === local && !taken.has(x));
    return same.length === 1 ? same[0] : null;
  };

  const chips: FkChip[] = [];
  if (onHead && !headBranch) chips.push({ kind: "head", name: "HEAD", label: "HEAD", title: "HEAD, detached: not on a branch" });
  const locals = [...r.local].sort(byName);
  for (const name of headBranch ? [headBranch, ...locals.filter(l => l !== headBranch)] : locals) {
    const current = name === headBranch;
    const upstream = upstreamOf(name);
    if (upstream) taken.add(upstream);
    const lines = [name];
    if (current) lines.push("checked out (HEAD)");
    if (upstream) lines.push(`${upstream} is here too`);
    chips.push({ kind: "local", name, label: fit(name, EDGE + (current ? CHECK : 0), current), title: lines.join(" · "), ...(current ? { current } : {}), ...(upstream ? { upstream } : {}) });
  }
  for (const ref of remotes.filter(x => !taken.has(x)).sort(byName)) {
    const branch = remoteBranch(ref);
    const prefix = ref.slice(0, ref.length - branch.length);
    // The remote's name goes first when there is room for it beside the
    // branch's own words, never by cutting them further: the cloud says
    // "remote" either way, and the title names it.
    const alone = fit(branch, EDGE + CELL, false);
    const roomy = !measure || (alone === branch && measure(ref, false) <= room - EDGE - CELL);
    chips.push({ kind: "remote", name: ref, label: roomy ? `${prefix}${alone}` : alone, title: `${ref}: remote-tracking branch, as of the last fetch` });
  }
  for (const t of [...r.tags].sort(byName)) chips.push({ kind: "tag", name: t, label: fit(t, EDGE + TAG, false), title: `tag ${t}` });
  if (chips.length <= FK_REF_BADGES) return { chips, more: [] };
  return { chips: chips.slice(0, FK_REF_BADGES - 1), more: chips.slice(FK_REF_BADGES - 1).map(x => (x.upstream ? `${x.name} · ${x.upstream}` : x.name)) };
}

/** What a badge says to a screen reader, inside its row's name. */
export function fkChipWords(x: FkChip): string {
  if (x.kind === "tag") return `tag ${x.name}`;
  if (x.kind === "head") return "HEAD, detached";
  const own = x.current ? `${x.name}, checked out` : x.name;
  return x.upstream ? `${own}, with ${x.upstream}` : own;
}

const measures = new Map<string, Measure>();

/** The look's UI font, as the sheet's `--fk-font` sets it — stated here so a
 *  canvas can measure in it without asking the page for a style (a test holds
 *  the two together). */
export const FK_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", "Noto Sans", Cantarell, Ubuntu, "Liberation Sans", Arial, sans-serif';

/** Words measured in the look's UI font on a canvas, cached per font: a
 *  badge's 12px by default. Browser only. */
export function fkMeasure(px = FK_REF_PX): (text: string, bold: boolean) => number {
  const one = (weight: number): Measure => {
    const font = `${weight} ${px}px ${FK_FONT}`;
    let m = measures.get(font);
    if (!m) {
      const ctx = document.createElement("canvas").getContext("2d");
      if (!ctx) return (text: string) => text.length * px * 0.6;
      m = cachedMeasure((text: string) => {
        ctx.font = font;
        return ctx.measureText(text).width;
      });
      measures.set(font, m);
    }
    return m;
  };
  const regular = one(400), bold = one(700);
  return (text, heavy) => (heavy ? bold : regular)(text);
}

// ─── glyphs, drawn for ccdeck (never a hosting service's mark) ────────────

function Cloud() {
  return (
    <svg className="fk-ref-glyph" width="13" height="11" viewBox="0 0 13 11" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3.6 9.4h6a2.3 2.3 0 0 0 .4-4.57A3.4 3.4 0 0 0 3.5 4.1 2.66 2.66 0 0 0 3.6 9.4z" />
    </svg>
  );
}

function Check() {
  return (
    <svg className="fk-ref-check" width="9.5" height="9" viewBox="0 0 9.5 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M1 4.9 3.5 7.6 8.5 1.4" />
    </svg>
  );
}

function Tag() {
  return (
    <svg className="fk-ref-glyph" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 3h8.2l9.6 9.6-8.2 8.2L3 11.2z" /><circle cx="7.6" cy="7.6" r="1.5" />
    </svg>
  );
}

/** What kind of ref a badge is, in words, for a screen reader. */
const KIND_WORD = (x: FkChip) => (x.kind === "head" ? "detached HEAD" : x.kind === "tag" ? "tag" : x.kind === "remote" ? "remote branch" : x.current ? "current branch" : "branch");

/**
 * One badge. "lane" (a history row's) takes its colours from `--lane`, which
 * the row sets; "neutral" (the Commit tab's, and the +N) is grey whatever the
 * lane. Both share one shape.
 */
export function FkRefBadge({ chip, tone = "lane" }: { chip: FkChip; tone?: "lane" | "neutral" }) {
  const neutral = tone === "neutral" ? "neutral" : undefined;
  // Beside the name rather than in it, so the name a narrow row cuts with an
  // ellipsis is the label alone, and its title holds what it cut.
  const words = <span className="vis-hidden">{KIND_WORD(chip)} </span>;
  if (chip.kind === "remote") {
    return (
      <span className="fk-ref" data-kind="remote" data-tone={neutral} title={chip.title}>
        <span className="fk-ref-cell"><Cloud /></span>
        {words}<span className="fk-ref-name">{chip.label}</span>
      </span>
    );
  }
  return (
    <span className="fk-ref" data-kind={chip.kind} data-tone={neutral} data-current={chip.current ? "" : undefined} data-paired={chip.upstream ? "" : undefined} title={chip.title}>
      {chip.upstream && <span className="fk-ref-cloud"><Cloud /></span>}
      {chip.current && <Check />}
      {chip.kind === "tag" && <Tag />}
      {words}<span className="fk-ref-name">{chip.label}</span>
    </span>
  );
}

/** The `+N` badge: the refs a row has no room for, in neutral colours. */
export function FkMoreBadge({ names }: { names: string[] }) {
  return <span className="fk-ref" data-kind="more" data-tone="neutral" title={names.join("\n")}>+{names.length}</span>;
}
