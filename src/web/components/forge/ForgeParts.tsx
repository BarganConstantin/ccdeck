// The small pieces every GitHub/GitLab tab and detail is built from (#2179):
// a state's mark and word, a fold-able group with its count, a failure with
// its recovery, the list's end, a person, a relative time, a copyable value.
// Each draws a state as a mark AND a word (DESIGN.md), never a colour alone.
import { useEffect, useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import type { ForgeErrorInfo, ForgeUser } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import { isReader, stripScrollDelta, type Mark } from "../../forge-panel";
import IntegrationAvatar, { IntegrationPerson } from "../IntegrationAvatar";
import { IntegrationCopy } from "../IntegrationDetailBar";
import { ExternalLinkGlyph } from "../action-glyphs";
import IntegrationFailureNote from "../IntegrationFailureNote";
import IntegrationSkeleton from "../IntegrationSkeleton";
import { shortAgo } from "../../relative-time";
import { selfPressProps } from "../../panel-press";
import type { ForgePagesState } from "../../use-forge-read";
import { useForge } from "./ForgeContext";
import { StateGlyph } from "./ForgeGlyphs";

/** A state: its mark, and its word (visually hidden when `quiet`). */
export function StateMark({ mark, quiet = false, className }: { mark: Mark; quiet?: boolean; className?: string }) {
  return (
    <span className={className ? `fg-mark ${className}` : "fg-mark"} data-tone={mark.tone} title={mark.word}>
      <StateGlyph name={mark.mark} />
      <span className={quiet ? "fg-sr" : "fg-mark-word"}>{mark.word}</span>
    </span>
  );
}

/** A badge: a mark and a word in a chip. */
export function Badge({ mark }: { mark: Mark }) {
  return (
    <span className="fg-badge" data-tone={mark.tone}>
      <StateGlyph name={mark.mark} /> {mark.word}
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

/** A failed read: the integrations' shared failure note (what happened, and
 *  the one way out its kind has), named for this forge and its host. With
 *  rows still on screen it is the compact note above them; the freshness line
 *  already says they are the last answer. */
export function ReadFailure({ error, onRetry, compact = false }: { error: ForgeErrorInfo; onRetry: () => void; compact?: boolean }) {
  const { kind, connection, onReconnect } = useForge();
  // The deck's words for a missing scope name the scope; they lead the sentence.
  const body = error.kind === "permission" && error.message
    ? `${error.message.replace(/\.\s*$/, "")}. Check the token's scopes in the connection's settings.`
    : undefined;
  return (
    <IntegrationFailureNote error={error} provider={forgeWords[kind].name} host={hostOf(connection.baseUrl)} stale={compact}
      onRetry={onRetry} onReconnect={onReconnect} body={body} />
  );
}

function hostOf(baseUrl: string): string | undefined {
  try { return new URL(baseUrl).host || undefined; } catch { return undefined; }
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

/** Rows that are on their way: the integrations' shared skeleton, which
 *  stays out of sight for a read that answers at once. */
export function LoadingRows({ rows = 6, label }: { rows?: number; label: string }) {
  return <IntegrationSkeleton label={label} rows={rows} />;
}

/** What the integrations' shared face needs from a forge user: the picture
 *  through the deck's proxy, the name its initials come from, and whether it
 *  is the reader's own face. */
export function useFaceOf(): (user: ForgeUser) => { src: string | null; name: string; you: boolean } {
  const { asset, connection } = useForge();
  return user => ({
    src: user.avatarUrl ? asset(user.avatarUrl) : null,
    name: user.name || user.login,
    you: isReader(user, connection.account),
  });
}

/** A person: the integrations' shared face and a name. */
export function Person({ user, size = 20, nameless = false }: { user: ForgeUser | null; size?: number; nameless?: boolean }) {
  const faceOf = useFaceOf();
  if (!user) return null;
  return <IntegrationPerson {...faceOf(user)} size={size} nameless={nameless} />;
}

/** A face alone, where the row says who it is in its own words (and its own
 *  tooltip, which a face's would cover). */
export function Face({ user, size = 20 }: { user: ForgeUser; size?: number }) {
  const faceOf = useFaceOf();
  return <IntegrationAvatar {...faceOf(user)} size={size} />;
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

/** A value with the integrations' shared copy button beside it (a branch
 *  name, a sha). */
export function Copyable({ value, label, children }: { value: string; label: string; children?: ReactNode }) {
  return (
    <span className="fg-copyable">
      {children ?? <code>{value}</code>}
      <IntegrationCopy value={value} label={label} />
    </span>
  );
}

/** A link out to the forge's own page for something, drawn as the detail
 *  bar's "Open in …" is. */
export function OpenOnForge({ href, children }: { href: string | null; children?: ReactNode }) {
  const { kind } = useForge();
  if (!href) return null;
  return (
    <a className="ig-open" href={href} target="_blank" rel="noreferrer noopener">
      {children ?? `Open in ${forgeWords[kind].name}`}<ExternalLinkGlyph />
    </a>
  );
}

/** Keeps the chosen tab of a strip that scrolls sideways in view: on a phone
 *  the strip is wider than the list, and a tab chosen with the arrow keys, or
 *  remembered from last time, may be past its edge. Moved at once, without a
 *  smooth scroll, so nothing slides. */
export function useChosenInView(strip: RefObject<HTMLElement | null>, chosen: string) {
  useLayoutEffect(() => {
    const el = strip.current;
    const item = el?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el || !item || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += stripScrollDelta(el.getBoundingClientRect(), item.getBoundingClientRect());
  }, [strip, chosen]);
}
