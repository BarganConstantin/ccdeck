// The small pieces every GitHub/GitLab tab and detail is built from (#2179):
// a state's mark and word, a fold-able group with its count, a failure with
// its recovery, the list's end, a person, a relative time, a copyable value.
// Each draws a state as a mark AND a word (DESIGN.md), never a colour alone.
import { useEffect, useState, type ReactNode } from "react";
import type { ForgeErrorInfo, ForgeUser } from "../../forge-types";
import { forgeErrorWords, type Mark } from "../../forge-panel";
import { shortAgo } from "../../relative-time";
import { copyText } from "../../copy-text";
import { selfPressProps } from "../../panel-press";
import type { ForgePagesState } from "../../use-forge-read";
import { useForge } from "./ForgeContext";

/** A state: its mark, and its word (visually hidden when `quiet`). */
export function StateMark({ mark, quiet = false, className }: { mark: Mark; quiet?: boolean; className?: string }) {
  return (
    <span className={className ? `fg-mark ${className}` : "fg-mark"} data-tone={mark.tone} title={mark.word}>
      <span aria-hidden="true">{mark.mark}</span>
      <span className={quiet ? "fg-sr" : "fg-mark-word"}>{mark.word}</span>
    </span>
  );
}

/** A badge: a mark and a word in a chip. */
export function Badge({ mark }: { mark: Mark }) {
  return (
    <span className="fg-badge" data-tone={mark.tone}>
      <span aria-hidden="true">{mark.mark}</span> {mark.word}
    </span>
  );
}

/** A group the user can fold, remembered per connection. `defaultOpen`
 *  is what it is until the user says otherwise. */
export function FoldGroup({ id, title, count, defaultOpen, children, aside }: {
  id: string; title: string; count?: number | null; defaultOpen: boolean; children: ReactNode; aside?: ReactNode;
}) {
  const { isOpen, toggle } = useForge();
  // The stored list holds the groups whose state differs from their default.
  const open = isOpen(id) ? !defaultOpen : defaultOpen;
  return (
    <section className="fg-group" data-open={open || undefined}>
      <h3 className="fg-group-head">
        <button type="button" className="fg-fold" aria-expanded={open} onClick={() => toggle(id)}>
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

/** A failed read: what happened in the forge's words, and the way out. With
 *  data still on screen it is one line above it, not a page. */
export function ReadFailure({ error, onRetry, compact = false }: { error: ForgeErrorInfo; onRetry: () => void; compact?: boolean }) {
  const { kind, onReconnect } = useForge();
  const words = forgeErrorWords(kind, error);
  return (
    <div className={compact ? "fg-failure fg-failure-compact" : "fg-failure"} role="alert">
      <p>
        <strong>{compact ? "Showing the last answer. " : ""}{words.title}.</strong> {words.detail}
      </p>
      {words.action === "connection"
        ? <button type="button" className="btn" onClick={onReconnect}>Open connection settings</button>
        : <button type="button" className="btn" onClick={onRetry}>Try again</button>}
    </div>
  );
}

/** The bottom of a paged list: Load more, its failure, or nothing. The
 *  button stays pressable while its page is out (#620), so focus stays on it,
 *  and the list's own loadMore refuses the second press. */
export function ListEnd({ pages, label = "Load more" }: {
  pages: Pick<ForgePagesState<unknown>, "data" | "loadingMore" | "moreError" | "loadMore">; label?: string;
}) {
  if (pages.moreError) return <ReadFailure error={pages.moreError} onRetry={pages.loadMore} compact />;
  if (!pages.data?.next) return null;
  return (
    <button type="button" className="btn fg-more" onClick={pages.loadMore} {...selfPressProps(pages.loadingMore)}>
      {pages.loadingMore ? "Loading…" : label}
    </button>
  );
}

/** Rows that are on their way: grey bars, the deck's loading shape. */
export function LoadingRows({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <div className="fg-loading" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <i key={i} />)}
    </div>
  );
}

// Avatars the deck could not fetch — a self-managed GitLab may serve them only
// to a signed-in browser — are drawn as the initial from then on, not asked
// for again on every page.
const failedAvatars = new Set<string>();

/** A person: avatar through the deck's proxy (or the initial), and a name. */
export function Person({ user, size = 20, nameless = false }: { user: ForgeUser | null; size?: number; nameless?: boolean }) {
  const { asset } = useForge();
  const [failed, setFailed] = useState(false);
  if (!user) return null;
  const label = user.name || user.login;
  const avatar = user.avatarUrl;
  const src = avatar && !failed && !failedAvatars.has(avatar) ? asset(avatar) : null;
  return (
    <span className="fg-person" title={nameless ? label : undefined}>
      {src
        ? <img className="fg-avatar" src={src} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => { failedAvatars.add(avatar!); setFailed(true); }} />
        : <span className="fg-avatar fg-avatar-initial" style={{ width: size, height: size }} aria-hidden="true">{label.slice(0, 1).toUpperCase()}</span>}
      {nameless ? <span className="fg-sr">{label}</span> : <span className="fg-person-name">{label}</span>}
    </span>
  );
}

/** "12m ago", kept current, with the exact time on hover. */
export function Ago({ at }: { at: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick(n => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  if (at == null) return null;
  return <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{shortAgo(Date.now() - at)}</time>;
}

/** A value with a copy button beside it (a branch name, a sha, a key). */
export function Copyable({ value, label, children }: { value: string; label: string; children?: ReactNode }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <span className="fg-copyable">
      {children ?? <code>{value}</code>}
      <button
        type="button"
        className="fg-copy"
        aria-label={done ? `${label} copied` : `Copy ${label}`}
        title={done ? "Copied" : `Copy ${label}`}
        onClick={event => {
          event.stopPropagation();
          void copyText(value).then(ok => setDone(!!ok));
        }}
      >
        <span aria-hidden="true">{done ? "✓" : "⧉"}</span>
      </button>
    </span>
  );
}

/** A link out to the forge's own page for something. */
export function OpenOnForge({ href, children }: { href: string | null; children?: ReactNode }) {
  const { kind } = useForge();
  if (!href) return null;
  return (
    <a className="fg-open" href={href} target="_blank" rel="noreferrer noopener">
      {children ?? `Open in ${kind === "github" ? "GitHub" : "GitLab"}`} <span aria-hidden="true">↗</span>
    </a>
  );
}
