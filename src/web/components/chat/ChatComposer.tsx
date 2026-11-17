import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { PromptSendResult } from "../../use-terminal-session";
import "./chat-composer.css";

export interface ChatComposerProps {
  value: string;
  onChange(value: string): void;
  onSend(text: string): PromptSendResult;
  unavailable?: string;
  onShowTerm?(): void;
}

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export default function ChatComposer({ value, onChange, onSend, unavailable, onShowTerm }: ChatComposerProps) {
  const t = useT();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const [feedback, setFeedback] = useState<{ result: PromptSendResult; draft: string } | null>(null);
  const blocked = unavailable !== undefined;
  const disabled = blocked || !value.trim();
  const result = feedback?.draft === value ? feedback.result : null;

  useEffect(() => {
    setFeedback(previous => previous?.draft === value ? previous : null);
  }, [value]);

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
    setFeedback({ result: outcome, draft: outcome === "sent" ? "" : value });
    textarea.current?.focus({ preventScroll: true });
  }

  const message = result === "sent" ? t("board.chat.composer.sent")
    : result === "partial" ? t("board.chat.composer.partial")
    : result === "too-large" ? t("board.chat.composer.tooLarge")
    : result === "empty" ? t("board.chat.composer.empty")
    : result === "unavailable" ? t("board.chat.composer.unavailable")
    : blocked ? unavailable || t("board.chat.cannotType") : "";
  const showTerm = onShowTerm && (blocked || result === "partial" || result === "unavailable");

  return (
    <form className="chat-composer" data-message={message ? "" : undefined} onSubmit={event => { event.preventDefault(); send(); }}>
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
            onChange={event => { setFeedback(null); onChange(event.currentTarget.value); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey
                || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat) send();
            }}
          />
          <button className="btn primary chat-composer-send" type="submit" disabled={disabled}>{t("board.chat.composer.send")}</button>
        </div>
        <div className="chat-composer-meta">
          <span id={`${id}-hint`} className="chat-composer-hint">{t("board.chat.composer.hint")}</span>
          <p id={`${id}-status`} className="chat-composer-status" role="status" aria-live="polite" aria-atomic="true" data-result={result ?? undefined}>{message}</p>
          {showTerm && <button className="chat-composer-term" type="button" onClick={onShowTerm}>{t("board.chat.showTerm")}</button>}
        </div>
      </div>
    </form>
  );
}
