import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { AskSendResult, PromptSendResult } from "../../use-terminal-session";
import "./chat-composer.css";

export interface ChatComposerProps {
  value: string;
  onChange(value: string): void;
  onSend(text: string): PromptSendResult;
  unavailable?: string;
  onShowTerm?(): void;
  /** Claude Code is working and can be stopped from here: Stop sits beside Send. */
  canStop?: boolean;
  /** Sends Esc only while the screen says Esc stops it (chat-stop.ts). */
  onStop?(): Promise<AskSendResult>;
}

/** How long "Stop sent." stays in the status line. */
export const STOP_SENT_MS = 2500;

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function ChatComposer({ value, onChange, onSend, unavailable, onShowTerm, canStop, onStop }: ChatComposerProps) {
  const t = useT();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const [feedback, setFeedback] = useState<{ result: PromptSendResult; draft: string } | null>(null);
  // A stop in flight, held in a ref as well so a second press before the
  // next render asks for nothing; and how the last one went.
  const stopBusy = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState<AskSendResult | null>(null);
  const blocked = unavailable !== undefined;
  const disabled = blocked || !value.trim();
  const result = feedback?.draft === value ? feedback.result : null;

  useEffect(() => {
    setFeedback(previous => previous?.draft === value ? previous : null);
  }, [value]);

  // "Stop sent." is a confirmation, not a state: it goes after a moment.
  useEffect(() => {
    if (stopped !== "sent") return;
    const timer = setTimeout(() => setStopped(null), STOP_SENT_MS);
    return () => clearTimeout(timer);
  }, [stopped]);

  useBeforePaint(() => {
    const el = textarea.current;
    if (!el) return;
    const resize = () => {
      // CSS owns the two-to-six-line bounds; resetting first also shrinks drafts.
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    resize();
    const host = el.parentElement ?? el;
    let width = host.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width;
      // Height follows the textarea. Only a width change can alter line wraps;
      // reacting to our own height adjustment would keep the observer firing.
      if (nextWidth === undefined || nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    if (observer) observer.observe(host);
    return () => observer?.disconnect();
  }, [value]);

  function send() {
    if (disabled || composing.current) return;
    let outcome: PromptSendResult;
    try { outcome = onSend(value); }
    catch { outcome = "unavailable"; }
    if (outcome === "sent") onChange("");
    setStopped(null);
    setFeedback({ result: outcome, draft: outcome === "sent" ? "" : value });
    textarea.current?.focus({ preventScroll: true });
  }

  // Esc goes only through onStop's guard; the textarea never binds Esc, which
  // the deck uses elsewhere.
  async function stop() {
    if (!onStop || stopBusy.current) return;
    stopBusy.current = true;
    setStopping(true);
    setStopped(null);
    let outcome: AskSendResult;
    try { outcome = await onStop(); }
    catch { outcome = "unavailable"; }
    stopBusy.current = false;
    setStopping(false);
    setStopped(outcome);
    // A pressed Stop goes disabled, and a disabled button lets go of the
    // focus: it comes back to the draft, unless the person moved on meanwhile.
    if (typeof document !== "undefined" && (!document.activeElement || document.activeElement === document.body)) {
      textarea.current?.focus({ preventScroll: true });
    }
  }

  // How the last stop went says it first; a stop that could not go says to
  // press Esc in Term, with Show Term beside it.
  const stopFailed = stopped === "unavailable" || stopped === "partial";
  const message = stopped === "sent" ? t("board.chat.stop.sent")
    : stopped === "changed" ? t("board.chat.stop.nothing")
    : stopFailed ? t("board.chat.stop.failed")
    : result === "sent" ? t("board.chat.composer.sent")
    : result === "partial" ? t("board.chat.composer.partial")
    : result === "too-large" ? t("board.chat.composer.tooLarge")
    : result === "empty" ? t("board.chat.composer.empty")
    : result === "unavailable" ? t("board.chat.composer.unavailable")
    : blocked ? unavailable || t("board.chat.cannotType") : "";
  const showTerm = onShowTerm && (blocked || result === "partial" || result === "unavailable" || stopFailed);

  return (
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <div className="chat-composer-col">
        <label className="vis-hidden" htmlFor={`${id}-draft`}>{t("board.chat.composer.reply")}</label>
        <div className="chat-composer-input">
          <textarea
            ref={textarea}
            id={`${id}-draft`}
            className="chat-composer-draft"
            rows={1}
            value={value}
            placeholder={t("board.chat.composer.placeholder")}
            aria-describedby={`${id}-hint ${id}-status`}
            onChange={event => { setFeedback(null); setStopped(null); onChange(event.currentTarget.value); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
                || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat) send();
            }}
          />
          {canStop && onStop && (
            <button className="btn chat-composer-stop" type="button" disabled={stopping}
              title={t("board.chat.stop.title")} aria-label={t("board.chat.stop.title")}
              onClick={() => { void stop(); }}>{t("board.chat.stop")}</button>
          )}
          <button className="btn primary chat-composer-send" type="submit" disabled={disabled}>{t("board.chat.composer.send")}</button>
        </div>
        <span id={`${id}-hint`} className="vis-hidden">{t("board.chat.composer.hint")}</span>
        <div className="chat-composer-meta">
          <p id={`${id}-status`} className="chat-composer-status" role="status" aria-live="polite" aria-atomic="true"
            data-result={stopped ? `stop-${stopped}` : result ?? undefined}>{message}</p>
          {showTerm && <button className="chat-composer-term" type="button" onClick={onShowTerm}>{t("board.chat.showTerm")}</button>}
        </div>
      </div>
    </form>
  );
}
