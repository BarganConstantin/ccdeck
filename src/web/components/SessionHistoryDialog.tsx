import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT, currentLanguage } from "../i18n";
import { sessionHistory, type SavedSession, type SessionHistoryPage } from "../session-history";
import ProviderAvatar from "./ProviderAvatar";
import { ClockGlyph, SearchGlyph } from "./rail-glyphs";
import { KitIcon } from "./kit-icons";
import { Dialog, DialogClose } from "./Dialog";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import type { TerminalProvider } from "../terminal-api";
import "../styles/session-history.css";

const PROVIDERS = ["all", "claude", "codex"] as const;
const PLACEHOLDERS = [0, 1, 2, 3, 4];

const EMPTY: SessionHistoryPage = { rows: [], next: null, limited: false };

export default function SessionHistoryDialog({ onClose, onOpen }: {
  onClose(): void;
  onOpen(session: SavedSession): void;
}) {
  const t = useT();
  const titleId = useId();
  const search = useRef<HTMLInputElement>(null);
  const dialog = useModalDismiss(onClose, { focusRef: search });
  const scrim = useScrimDismiss(onClose);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<TerminalProvider | "all">("all");
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(EMPTY);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const language = currentLanguage();
  const date = new Intl.DateTimeFormat(language, { dateStyle: "medium" });
  const exactDate = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
  const older = page.next;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void sessionHistory(query, provider, offset, controller.signal).then(next => {
        if (controller.signal.aborted) return;
        setPage(prev => {
          if (!offset) return next;
          const seen = new Set(prev.rows.map(row => `${row.provider}:${row.id}`));
          return { ...next, rows: [...prev.rows, ...next.rows.filter(row => !seen.has(`${row.provider}:${row.id}`))] };
        });
        setState("ready");
      }).catch(() => { if (!controller.signal.aborted) setState("failed"); });
    }, offset ? 0 : 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, provider, offset, retry]);

  function change() {
    setOffset(0);
    setPage(EMPTY);
    setState("loading");
  }

  return createPortal(
    <Dialog dialogRef={dialog} scrim={scrim} className="session-history" labelledBy={titleId}>
      <header className="modal-head">
        <div className="session-history-heading"><ClockGlyph /><h2 id={titleId}>{t("board.history.title")}</h2></div>
        <div className="modal-actions"><DialogClose onClick={onClose} label={t("board.history.close")} /></div>
      </header>
      <div className="session-history-filters">
        <div className="session-history-search">
          <SearchGlyph />
          <input ref={search} type="search" value={query} aria-label={t("board.history.search")} placeholder={t("board.history.search")}
            onChange={e => { change(); setQuery(e.currentTarget.value); }} />
        </div>
        <div className="session-history-providers" role="group" aria-label={t("board.history.provider")}>
          {PROVIDERS.map(key => (
            <button key={key} type="button" aria-pressed={provider === key}
              onClick={() => { if (provider !== key) { change(); setProvider(key); } }}>
              {key === "all" ? t("board.history.all") : key === "claude" ? "Claude" : "Codex"}
            </button>
          ))}
        </div>
      </div>
      <div className="session-history-body" aria-busy={state === "loading"}>
        <ul className="session-history-list">
          {page.rows.map(row => (
            <li key={`${row.provider}:${row.id}`}>
              <button type="button" className="session-history-row" disabled={row.unavailable !== null}
                onClick={() => onOpen(row)} title={row.cwd}>
                <ProviderAvatar provider={row.provider} />
                <span className="session-history-identity">
                  <span className="session-history-name">{row.title}</span>
                  <span className="session-history-path">
                    {row.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? row.cwd}
                    {row.unavailable && <> · {t(row.unavailable === "folder" ? "board.history.folder" : "board.history.profile")}</>}
                  </span>
                </span>
                <time className="session-history-date" dateTime={new Date(row.updatedAt).toISOString()} title={exactDate.format(row.updatedAt)}>{date.format(row.updatedAt)}</time>
                {!row.unavailable && <KitIcon name="chevron-right" className="session-history-open" />}
              </button>
            </li>
          ))}
        </ul>
        {state === "loading" && !page.rows.length && (
          <>
            <span className="vis-hidden" role="status">{t("board.history.loading")}</span>
            <div className="session-history-skeleton" aria-hidden="true">
              {PLACEHOLDERS.map(index => <div key={index}><span /><span /><span /></div>)}
            </div>
          </>
        )}
        {state === "loading" && page.rows.length > 0 && <p role="status">{t("board.history.loading")}</p>}
        {state === "failed" && (
          <div role="status">{t("board.history.failed")}{" "}
            <button type="button" className="btn" onClick={() => { setState("loading"); setRetry(n => n + 1); }}>{t("board.history.retry")}</button>
          </div>
        )}
        {state === "ready" && !page.rows.length && <p role="status">{t("board.history.empty")}</p>}
        {state === "ready" && page.limited && <p className="session-history-note">{t("board.history.limited")}</p>}
      </div>
      {older !== null && (
        <footer className="session-history-footer">
          <button type="button" className="btn" disabled={state !== "ready"}
            onClick={() => { setState("loading"); setOffset(older); }}>{t("board.history.more")}</button>
        </footer>
      )}
    </Dialog>,
    document.body,
  );
}
