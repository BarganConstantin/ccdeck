// The small pieces every GitHub/GitLab tab and detail is built from (#2179):
// a state's mark and word, a fold-able group with its count, a failure with
// its recovery, the list's end, a person, a relative time, a copyable value.
// Each draws a state as a mark AND a word (DESIGN.md), never a colour alone.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ForgeErrorInfo, ForgeUser } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import { isReader, markWord, rovingStop, rowMove, stripScrollDelta, type Mark } from "../../forge-panel";
import { currentLanguage, useT, type TFunction } from "../../i18n";
import { formatNumber } from "../../i18n/format";
import IntegrationAvatar, { IntegrationPerson } from "../IntegrationAvatar";
import { trackerImageUrl } from "../../integrations/client";
import { IntegrationCopy } from "../IntegrationDetailBar";
import { ExternalLinkGlyph } from "../action-glyphs";
import IntegrationFailureNote from "../IntegrationFailureNote";
import IntegrationSkeleton from "../IntegrationSkeleton";
import { selfPressProps } from "../../panel-press";
import type { ForgePagesState } from "../../use-forge-read";
import { useForge } from "./ForgeContext";
import { StateGlyph } from "./ForgeGlyphs";

/** A state: its mark, and its word (visually hidden when `quiet`). */
export function StateMark({ mark, quiet = false, className }: { mark: Mark; quiet?: boolean; className?: string }) {
  const t = useT();
  const word = markWord(mark, t);
  return (
    <span className={className ? `fg-mark ${className}` : "fg-mark"} data-tone={mark.tone} title={word}>
      <StateGlyph name={mark.mark} />
      <span className={quiet ? "fg-sr" : "fg-mark-word"}>{word}</span>
    </span>
  );
}

/** A badge: a mark and a word in a chip. */
export function Badge({ mark }: { mark: Mark }) {
  const t = useT();
  return (
    <span className="fg-badge" data-tone={mark.tone}>
      <StateGlyph name={mark.mark} /> {markWord(mark, t)}
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
        <button type="button" className="fg-fold" data-nav="" aria-expanded={open} onClick={() => toggle(id)}>
          <span className="fg-fold-chevron" aria-hidden="true" />
          {title}
          {count != null && <span className="fg-count">{formatNumber(count, 0)}</span>}
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
  const t = useT();
  // The deck's words for a missing scope name the scope; they lead the sentence.
  const body = error.kind === "permission" && error.message
    ? t("forge.permissionBody", { message: error.message.replace(/\.\s*$/, "") })
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
export function ListEnd({ pages, label }: {
  pages: Pick<ForgePagesState<unknown>, "data" | "loadingMore" | "moreError" | "loadMore">; label?: string;
}) {
  const t = useT();
  if (pages.moreError) return <ReadFailure error={pages.moreError} onRetry={pages.loadMore} compact />;
  if (!pages.data?.next) return null;
  return (
    <button type="button" className="btn fg-more" onClick={pages.loadMore} {...selfPressProps(pages.loadingMore)}>
      {pages.loadingMore ? t("forge.loading") : label ?? t("forge.more")}
    </button>
  );
}

/** Rows that are on their way: the integrations' shared skeleton, which
 *  stays out of sight for a read that answers at once. */
export function LoadingRows({ rows = 6, label }: { rows?: number; label: string }) {
  return <IntegrationSkeleton label={label} rows={rows} />;
}

/** What the integrations' shared face needs from a forge user: the picture
 *  through the deck's proxy, then at the forge itself when it is on the
 *  connection's own host, the name its initials come from, and whether it is
 *  the reader's own face. */
export function useFaceOf(): (user: ForgeUser) => { src: string | null; direct: string | null; name: string; you: boolean } {
  const { asset, connection } = useForge();
  return user => ({
    src: user.avatarUrl ? asset(user.avatarUrl) : null,
    direct: trackerImageUrl(connection, user.avatarUrl),
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

/** "12m ago" in the language on show: just now under a minute, then minutes,
 *  hours and days. */
export function agoWords(ms: number, t: TFunction): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t("forge.ago.now");
  if (s < 3600) return t("forge.ago.m", { n: Math.floor(s / 60) });
  if (s < 86400) return t("forge.ago.h", { n: Math.floor(s / 3600) });
  return t("forge.ago.d", { n: Math.floor(s / 86400) });
}

/** "12m ago", kept current, with the exact time on hover. */
export function Ago({ at }: { at: number | null }) {
  const [, tick] = useState(0);
  const t = useT();
  useEffect(() => {
    const timer = window.setInterval(() => tick(n => n + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (at == null) return null;
  return <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString(currentLanguage())}>{agoWords(Date.now() - at, t)}</time>;
}

/** A phrase with a time in it ("merged {ago}", "created {ago} by Alice"): the
 *  words around the {ago} are the language's, the time is the live Ago.
 *  `verb` styles the words, for a row whose verb is quieter than its time. */
export function AgoIn({ at, text, verb }: { at: number | null; text: string; verb?: string }) {
  const [before, ...rest] = text.split("{ago}");
  const after = rest.join("{ago}");
  const words = (w: string) => (w && verb ? <span className={verb}>{w}</span> : w);
  return <>{words(before)}<Ago at={at} />{words(after)}</>;
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
  const t = useT();
  if (!href) return null;
  return (
    <a className="ig-open" href={href} target="_blank" rel="noreferrer noopener">
      {children ?? t("forge.openIn", { name: forgeWords[kind].name })}<ExternalLinkGlyph />
    </a>
  );
}

/** A list as one Tab stop, walked with the arrow keys, as Jira's backlog is.
 *  Its rows are the elements marked data-nav (a change, pipeline or issue
 *  row, a branch row, a group's fold) in the order drawn. Up and Down move a
 *  row, Home and End go to the ends; Right opens a folded group or steps into
 *  an open one, Left folds it, or goes from a row up to its group. The stop
 *  is the row last focused while it is drawn, else the open item's row, else
 *  the first; a row's own controls (a branch's copy button, its Create link)
 *  are Tab stops on that row only. It is set here, on what is drawn, as rows
 *  come and go, so the four tabs' rows need no state of their own for it. */
export function useRovingRows(ref: RefObject<HTMLElement | null>) {
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const rows = () => Array.from(root.querySelectorAll<HTMLElement>("[data-nav]")).filter(el => el.getClientRects().length > 0);
    const controlsOf = (row: HTMLElement) => {
      const item = row.closest("li");
      if (!item || !root.contains(item)) return [];
      return Array.from(item.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea"))
        .filter(el => el !== row && !el.hasAttribute("data-nav") && el.closest("li") === item);
    };
    // The row holding the stop now, so moving it touches two rows, not all.
    let stop: HTMLElement | undefined;
    const setStop = (row: HTMLElement, on: boolean) => {
      for (const el of [row, ...controlsOf(row)]) {
        if (on) el.removeAttribute("tabindex"); else if (el.tabIndex !== -1) el.tabIndex = -1;
      }
    };
    const apply = () => {
      const all = rows();
      stop = all[rovingStop(all.length, last.current ? all.indexOf(last.current) : -1,
        all.findIndex(el => el.getAttribute("aria-current") === "true"))];
      for (const row of all) setStop(row, row === stop);
    };
    const onFocusIn = (event: FocusEvent) => {
      const row = event.target as HTMLElement;
      if (!row.hasAttribute?.("data-nav") || row === stop) return;
      last.current = row;
      if (stop?.isConnected) setStop(stop, false);
      setStop(row, true);
      stop = row;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const row = event.target as HTMLElement;
      if (!row.hasAttribute?.("data-nav") || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const all = rows();
      const at = all.indexOf(row);
      if (at < 0) return;
      const expanded = row.getAttribute("aria-expanded");
      const moved = rowMove(event.key, at, all.length);
      let to: HTMLElement | null | undefined;
      if (moved != null) to = all[moved];
      else if (event.key === "ArrowRight" && expanded === "true") to = all[at + 1];
      else if (event.key === "ArrowLeft" && expanded == null) to = row.closest(".fg-group")?.querySelector<HTMLElement>(".fg-group-head [data-nav]");
      else if ((event.key === "ArrowRight" && expanded === "false") || (event.key === "ArrowLeft" && expanded === "true")) {
        event.preventDefault();
        row.click();
        return;
      } else return;
      event.preventDefault();
      if (to && to !== row) {
        to.focus();
        to.scrollIntoView?.({ block: "nearest" });
      }
    };
    // Rows arrive with a read, leave with a filter or a fold, and change which
    // is open: each of those moves the stop. Setting it touches only tabindex,
    // which is not watched, so it never wakes itself.
    const watch = new MutationObserver(apply);
    watch.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current", "aria-expanded", "hidden"] });
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("keydown", onKeyDown);
    apply();
    return () => {
      watch.disconnect();
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, [ref]);
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
