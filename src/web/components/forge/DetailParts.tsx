// What the four GitHub/GitLab item pages share (#2179): the frame that holds
// one, what its top bar (the integrations' shared one) takes, the states a
// read can be in before there is anything to draw, the side column of facts,
// a label chip, a commit row, a fold kept in the page's own state, and the
// forge's HTML parsed once per answer.
//
// A page is drawn in the host's detail pane, whose width the user sets with
// the splitter, so its layout answers the pane (a container query on
// `.fd`) rather than the window.
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ForgeCommit, ForgeErrorInfo, ForgeLabel, ForgeUser } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import { parseForgeHtml, type ForgeNode } from "../../forge-html";
import { labelColor, labelParts } from "../../forge-detail";
import { useForge } from "./ForgeContext";
import { Ago, Copyable, LoadingRows, Person, ReadFailure } from "./ForgeParts";

/** A file's folder, quiet, with a line break allowed after each slash, so a
 *  long path wraps between folders rather than inside one. */
export function PathDir({ dir }: { dir: string }) {
  if (!dir) return null;
  const parts = dir.split("/").slice(0, -1);
  return (
    <span className="fd-path-dir">
      {parts.map((part, i) => <span key={i}>{part}/<wbr /></span>)}
    </span>
  );
}

/** One item page. It starts at the top: the pane's scroll belongs to the
 *  host and would otherwise carry the last page's position into this one.
 *  The pane is the host's `.ig-detail` (IntegrationSplit), which scrolls; it
 *  is found by its class rather than by reading styles up the tree. */
export function DetailFrame({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const pane = ref.current?.closest<HTMLElement>(".ig-detail");
    if (pane) pane.scrollTop = 0;
  }, []);
  // tabIndex -1: the panel moves focus here when the control that opened the
  // page is no longer on screen.
  return <article ref={ref} className="fd" aria-label={label} tabIndex={-1}>{children}</article>;
}

/** What every page hands the integrations' shared detail bar besides its
 *  reference: the forge's name for "Open in …", whether the host's Back
 *  stands in for Close on a narrow window, and Close itself. */
export function useDetailBar(): { openLabel: string; narrow: boolean; onClose: () => void } {
  const { kind, narrow, select } = useForge();
  return { openLabel: `Open in ${forgeWords[kind].name}`, narrow, onClose: () => select(null) };
}

/** Before there is anything to draw: loading, a failure, or an item that is
 *  gone. Null once there is data — the page draws it, with a compact failure
 *  above when a refresh failed and the last answer is kept. */
export function DetailPending({ data, loading, error, onRetry, what }: {
  data: unknown; loading: boolean; error: ForgeErrorInfo | null; onRetry: () => void; what: string;
}) {
  if (data) return null;
  if (error?.kind === "not-found") {
    return <p className="fg-empty">This {what} no longer exists, or this token cannot see it.</p>;
  }
  if (error) return <ReadFailure error={error} onRetry={onRetry} />;
  if (loading) return <LoadingRows rows={5} label={`Loading the ${what}`} />;
  return null;
}

/** The forge's HTML as the allow-listed tree, parsed once per string. */
export function useForgeNodes(html: string | null | undefined, inline = false): ForgeNode[] {
  const { connection, asset } = useForge();
  return useMemo(
    () => (html ? parseForgeHtml(html, { baseUrl: connection.baseUrl, asset, inline }) : []),
    [html, inline, connection.baseUrl, asset],
  );
}

/** One fact in the side column: a label and its value. */
export function SideFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fd-fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The side column: beside the page when the pane is wide, a compact block
 *  above it when it is not. */
export function SideFacts({ label, children }: { label: string; children: ReactNode }) {
  return <aside className="fd-side" aria-label={label}><dl className="fd-facts">{children}</dl></aside>;
}

/** People in a fact: each with a name, or "None". */
export function PeopleFact({ users, extra }: { users: ForgeUser[]; extra?: (u: ForgeUser) => ReactNode }) {
  if (!users.length) return <span className="fd-none">None</span>;
  return (
    <ul className="fd-people">
      {users.map(u => (
        <li key={u.login}>
          <Person user={u} size={20} />
          {extra?.(u)}
        </li>
      ))}
    </ul>
  );
}

/** Avatars only, for a long list of people (participants). */
export function Faces({ users, max = 12 }: { users: ForgeUser[]; max?: number }) {
  if (!users.length) return <span className="fd-none">None</span>;
  const shown = users.slice(0, max);
  return (
    <ul className="fd-faces">
      {shown.map(u => <li key={u.login}><Person user={u} size={22} nameless /></li>)}
      {users.length > max && <li className="fd-faces-more">+{users.length - max}</li>}
    </ul>
  );
}

/** A label as the forge has it: its colour as a swatch beside the words, so
 *  the words stay in the theme's own ink whatever the colour is. */
export function LabelChip({ label }: { label: ForgeLabel }) {
  const color = labelColor(label.color);
  const { scope, value } = labelParts(label.name);
  return (
    <span className="fd-label" title={label.name}>
      <span className="fd-swatch" style={color ? { backgroundColor: color } : undefined} aria-hidden="true" />
      {scope && <span className="fd-label-scope">{scope}</span>}
      <span className="fd-label-value">{value}</span>
    </span>
  );
}

export function LabelsFact({ labels }: { labels: ForgeLabel[] }) {
  if (!labels.length) return <span className="fd-none">None</span>;
  return <span className="fd-labels">{labels.map(l => <LabelChip key={l.name} label={l} />)}</span>;
}

/** A commit: its title (a link to it on the forge), then short sha, author, when. */
export function CommitRow({ commit }: { commit: ForgeCommit }) {
  return (
    <li className="fd-item">
      {commit.webUrl
        ? <a className="fd-item-title fd-out" href={commit.webUrl} target="_blank" rel="noreferrer noopener">{commit.title}<span className="fd-out-mark" aria-hidden="true"> ↗</span></a>
        : <span className="fd-item-title">{commit.title}</span>}
      <span className="fd-item-meta">
        <Copyable value={commit.sha} label="commit sha"><code>{commit.shortSha}</code></Copyable>
        {commit.authorName && <span>{commit.authorName}</span>}
        {commit.authoredAt != null && <Ago at={commit.authoredAt} />}
      </span>
    </li>
  );
}

/** A heading for a block of the page, with its count. */
export function DetailHeading({ children, count, aside }: { children: ReactNode; count?: number | null; aside?: ReactNode }) {
  return (
    <h3 className="fd-heading">
      <span>{children}</span>
      {count != null && <span className="fg-count">{count.toLocaleString()}</span>}
      {aside}
    </h3>
  );
}

/** A fold that lives as long as the page — a stage, a job — not remembered
 *  with the view, because what it holds is this one item's. */
export function DetailFold({ title, count, startsOpen, aside, children }: {
  title: ReactNode; count?: number; startsOpen: boolean; aside?: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(startsOpen);
  return (
    <section className="fg-group fd-fold" data-open={open || undefined}>
      <h3 className="fg-group-head fd-fold-head">
        <button type="button" className="fg-fold" aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <span className="fg-fold-chevron" aria-hidden="true" />
          {title}
          {count != null && <span className="fg-count">{count.toLocaleString()}</span>}
        </button>
        {aside}
      </h3>
      {open && children}
    </section>
  );
}
