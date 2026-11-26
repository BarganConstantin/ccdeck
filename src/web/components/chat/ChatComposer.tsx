import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { addImages, focusAfterImage, MAX_CHAT_IMAGE_BYTES, MAX_CHAT_IMAGES, pastedImages, removeImage, type ChatImage, type ImageRefusal } from "../../chat-images";
import { useT } from "../../i18n";
import { providerLabel } from "../../provider-copy";
import type { Provider } from "../../types";
import type { AskSendResult, PromptSendResult } from "../../use-terminal-session";
import { KitIcon } from "../kit-icons";
import type { ChatTurn } from "./chat-model";
import { ToolTerminalGlyph } from "./chat-icons";
import { historyMove, opensInTerm, readHistory, rememberSent, slashItems, slashQuery, usedCommands, withSent } from "./chat-compose";
import "./chat-composer.css";

export interface ChatComposerProps {
  value: string;
  onChange(value: string): void;
  onSend(text: string): PromptSendResult;
  unavailable?: string;
  onShowTerm?(): void;
  /** Claude Code is working and can be stopped from here: with nothing typed, Send is Stop. */
  canStop?: boolean;
  /** Sends Esc only while the screen says Esc stops it (chat-stop.ts). */
  onStop?(): Promise<AskSendResult>;
  /** Which session the messages go to: the history Up and Down recall is its own. */
  session?: string;
  /** The conversation as read: the slash list offers the commands it ran. */
  turns?: readonly ChatTurn[];
  /** A message the session did not take, put back as the draft: while the draft
   *  is still that text, the line under it says why. */
  notTaken?: string;
  provider?: Provider;
  /** Pictures pasted into the box, held by the owner as the draft is (chat-images.ts). */
  images?: readonly ChatImage[];
  onImagesChange?(images: ChatImage[]): void;
  /** Sends the draft with its pictures. Without it this session takes no
   *  picture from Chat, and a pasted one is not added. */
  onSendImages?(text: string, images: readonly ChatImage[]): Promise<ChatSendResult>;
  /** Term takes a pasted picture for this session (its Ctrl+V): where Chat
   *  cannot, the line under the box says to paste it there. */
  imagesInTerm?: boolean;
}

/** How a send went: the terminal's answer, or the pictures not kept by the deck, so nothing went. */
export type ChatSendResult = PromptSendResult | "images-failed";

/** Why the last paste added no picture, or added fewer than it carried. */
type ImageNote = ImageRefusal | "unsupported";

/** How long "Stop sent." stays in the status line. */
export const STOP_SENT_MS = 2500;

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

const NO_TURNS: readonly ChatTurn[] = [];
const NO_IMAGES: readonly ChatImage[] = [];

export default function ChatComposer({
  value, onChange, onSend, unavailable, onShowTerm, canStop, onStop, session, turns = NO_TURNS, notTaken, provider,
  images = NO_IMAGES, onImagesChange, onSendImages, imagesInTerm,
}: ChatComposerProps) {
  const t = useT();
  const id = useId();
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const [feedback, setFeedback] = useState<{ result: ChatSendResult; draft: string } | null>(null);
  // A send with pictures waits for the deck and the program: one at a time,
  // the box held as it is until it is over.
  const sendBusy = useRef(false);
  const [sending, setSending] = useState(false);
  const [imageNote, setImageNote] = useState<ImageNote | null>(null);
  // Each picture's thumbnail, drawn from its own bytes in memory.
  const [thumbs, setThumbs] = useState<ReadonlyMap<Blob, string>>(() => new Map());
  const removeButtons = useRef(new Map<number, HTMLButtonElement>());
  const [focusNext, setFocusNext] = useState<number | "draft" | null>(null);
  // A stop in flight, held in a ref as well so a second press before the
  // next render asks for nothing; and how the last one went.
  const stopBusy = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [stopped, setStopped] = useState<AskSendResult | null>(null);
  // What was sent from here to this session, oldest first, and where Up has
  // walked to in it (newest first) with the draft it left.
  const [history, setHistory] = useState<string[]>([]);
  const browse = useRef<{ at: number; draft: string } | null>(null);
  const caretToEnd = useRef(false);
  // The slash list: which row is active, and the draft Esc closed it on.
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const blocked = unavailable !== undefined;
  const empty = !value.trim();
  const pictures = images.length > 0;
  // Never `sending`: a press does not disable the control it came from
  // (panel-press.ts); a second one is refused by sendBusy instead.
  const disabled = blocked || (empty && !pictures);
  const result = feedback?.draft === value ? feedback.result : null;
  // With nothing typed or pasted while Claude Code works, the one button stops it.
  const stopShown = !!(canStop && onStop) && ((empty && !pictures) || stopping);

  useEffect(() => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
    const made = new Map<Blob, string>();
    for (const image of images) made.set(image.blob, URL.createObjectURL(image.blob));
    setThumbs(made);
    return () => { for (const url of made.values()) URL.revokeObjectURL(url); };
  }, [images]);

  // The focus after a picture is removed: the next one's button, or the box.
  useBeforePaint(() => {
    if (focusNext === null) return;
    (focusNext === "draft" ? textarea.current : removeButtons.current.get(focusNext))?.focus({ preventScroll: true });
    setFocusNext(null);
  }, [focusNext]);

  useEffect(() => { setHistory(session ? readHistory(session) : []); }, [session]);

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
    if (caretToEnd.current) {
      caretToEnd.current = false;
      el.setSelectionRange?.(value.length, value.length);
    }
    const resize = () => {
      // CSS owns the one-to-ten-line bounds and eases the change; the
      // measurement itself is made with the easing off, from the height drawn.
      const from = el.style.height;
      const transition = el.style.transition;
      el.style.transition = "none";
      el.style.height = "auto";
      const next = `${el.scrollHeight}px`;
      el.style.height = from;
      void el.offsetHeight;
      el.style.transition = transition;
      el.style.height = next;
    };
    resize();
    const host = el.parentElement ?? el;
    // The width the observer first reports is the one just measured at: kept,
    // not acted on, so a measure does not cut the height's easing short.
    let width: number | null = null;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width;
      // Height follows the textarea. Only a width change can alter line wraps;
      // reacting to our own height adjustment would keep the observer firing.
      if (nextWidth === undefined || nextWidth === width) return;
      const first = width === null;
      width = nextWidth;
      if (!first) resize();
    });
    if (observer) observer.observe(host);
    return () => observer?.disconnect();
  }, [value]);

  // THE SLASH LIST. Open while the draft is a slash and a word, with the focus
  // here, until Esc closes it for that draft.
  const used = useMemo(() => usedCommands(turns), [turns]);
  const query = slashQuery(value);
  const items = useMemo(() => (query === null ? [] : slashItems(query, used)), [query, used]);
  const listOpen = focused && query !== null && dismissed !== value && items.length > 0;
  const activeAt = Math.min(active, items.length - 1);
  const listId = `${id}-commands`;
  const optionId = (i: number) => `${id}-command-${i}`;
  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (!listOpen || typeof document === "undefined") return;
    document.getElementById(optionId(activeAt))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listOpen, activeAt]);

  function change(next: string) {
    browse.current = null;
    setFeedback(null);
    setStopped(null);
    onChange(next);
  }

  // A paste that carries pictures adds them; its words are the textarea's,
  // as any paste's. One with no words is the box's alone.
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = pastedImages(event.clipboardData);
    if (!files.length) return;
    const words = event.clipboardData?.getData("text/plain") ?? "";
    if (!words) event.preventDefault();
    if (sending) return;
    setFeedback(null);
    setStopped(null);
    if (!onSendImages || !onImagesChange) { setImageNote("unsupported"); return; }
    const added = addImages(images, files);
    setImageNote(added.refused);
    if (added.images.length !== images.length) onImagesChange(added.images);
  }

  function remove(image: ChatImage) {
    if (sending || !onImagesChange) return;
    setFocusNext(focusAfterImage(images, image.id) ?? "draft");
    setFeedback(null);
    setImageNote(null);
    onImagesChange(removeImage(images, image.id));
  }

  function complete(at: number) {
    const item = items[at];
    if (!item) return;
    caretToEnd.current = true;
    change(`${item.name} `);
  }

  function send() {
    if (disabled || composing.current || sendBusy.current) return;
    setImageNote(null);
    if (pictures) { void sendWithImages(); return; }
    let outcome: PromptSendResult;
    const text = value;
    try { outcome = onSend(text); }
    catch { outcome = "unavailable"; }
    if (outcome === "sent") {
      browse.current = null;
      setHistory(session ? rememberSent(session, text) : previous => withSent(previous, text));
      onChange("");
    }
    setStopped(null);
    setFeedback({ result: outcome, draft: outcome === "sent" ? "" : text });
    textarea.current?.focus({ preventScroll: true });
    // Claude Code answers these with a dialog only Term draws: Term it is.
    if (outcome === "sent" && opensInTerm(text)) onShowTerm?.();
  }

  // The draft and its pictures, together. Until the answer the box is held:
  // the words and pictures sent are the ones that come back on a failure.
  async function sendWithImages() {
    if (sendBusy.current) return;
    if (!onSendImages) { setImageNote("unsupported"); return; }
    const text = value;
    const sent = images;
    sendBusy.current = true;
    setSending(true);
    setFeedback(null);
    setStopped(null);
    setImageNote(null);
    let outcome: ChatSendResult;
    try { outcome = await onSendImages(text, sent); }
    catch { outcome = "unavailable"; }
    sendBusy.current = false;
    setSending(false);
    if (outcome === "sent") {
      browse.current = null;
      setHistory(session ? rememberSent(session, text) : previous => withSent(previous, text));
      onChange("");
      onImagesChange?.([]);
    }
    setFeedback({ result: outcome, draft: outcome === "sent" ? "" : text });
    textarea.current?.focus({ preventScroll: true });
    if (outcome === "sent" && opensInTerm(text)) onShowTerm?.();
  }

  // Up recalls the last message sent here, Down walks back to the draft.
  function recall(move: "older" | "newer"): boolean {
    const now = browse.current;
    if (move === "older") {
      const at = now ? now.at + 1 : 0;
      if (at >= history.length) return false;
      browse.current = { at, draft: now ? now.draft : value };
      caretToEnd.current = true;
      setFeedback(null);
      onChange(history[history.length - 1 - at]);
      return true;
    }
    if (!now) return false;
    const at = now.at - 1;
    browse.current = at < 0 ? null : { at, draft: now.draft };
    caretToEnd.current = true;
    setFeedback(null);
    onChange(at < 0 ? now.draft : history[history.length - 1 - at]);
    return true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const plain = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (listOpen && plain) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const by = event.key === "ArrowDown" ? 1 : -1;
        setActive((activeAt + by + items.length) % items.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && items[activeAt]?.name !== value)) {
        event.preventDefault();
        complete(activeAt);
        return;
      }
      if (event.key === "Escape") {
        // The list's Esc, and only the list's: the deck's goes on next time.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(value);
        return;
      }
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain) {
      const el = event.currentTarget;
      const move = historyMove(event.key, { value, start: el?.selectionStart ?? value.length, end: el?.selectionEnd ?? value.length }, browse.current !== null);
      if (move && recall(move)) event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || !plain) return;
    event.preventDefault();
    if (!event.repeat) send();
  }

  // Esc goes only through onStop's guard; the textarea binds Esc for its
  // slash list alone, and the deck uses it elsewhere.
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
  // press Esc in Term, with Show Term beside it. A message that went says
  // nothing here: the terminal taking it is not the agent taking it, and Chat
  // says where it stands under the conversation (chat-progress.ts). One the
  // session did not take is back in the box, and says so while it is.
  const stopFailed = stopped === "unavailable" || stopped === "partial";
  const returned = notTaken !== undefined && notTaken !== "" && value === notTaken && result === null && !stopped;
  const agent = providerLabel(provider);
  const message = stopped === "sent" ? t("board.chat.stop.sent")
    : stopped === "changed" ? t("board.chat.stop.nothing")
    : stopFailed ? t("board.chat.stop.failed")
    : sending ? t("board.chat.progress.sending")
    : imageNote === "unsupported" ? t(imagesInTerm ? "board.chat.compose.image.useTerm" : "board.chat.compose.image.unsupported", { agent })
    : imageNote === "type" ? t("board.chat.compose.image.type")
    : imageNote === "size" ? t("board.chat.compose.image.size", { mb: MAX_CHAT_IMAGE_BYTES / (1024 * 1024) })
    : imageNote === "count" ? t("board.chat.compose.image.count", { max: MAX_CHAT_IMAGES })
    : result === "images-failed" ? t("board.chat.compose.image.failed")
    : result === "sent" ? ""
    : result === "partial" ? t("board.chat.composer.partial")
    : result === "too-large" ? t("board.chat.composer.tooLarge")
    : result === "empty" ? t("board.chat.composer.empty")
    : result === "unavailable" ? t("board.chat.composer.unavailable")
    : returned ? t("board.chat.compose.returned", { agent })
    : blocked ? unavailable || t("board.chat.cannotType") : "";
  const showTerm = onShowTerm && (blocked || returned || result === "partial" || result === "unavailable" || stopFailed
    || (imageNote === "unsupported" && imagesInTerm === true));
  const statusResult = stopped ? `stop-${stopped}` : sending ? "sending" : imageNote ? `image-${imageNote}` : result ?? (returned ? "not-taken" : undefined);

  return (
    <form className="chat-composer" onSubmit={event => { event.preventDefault(); send(); }}>
      <div className="chat-composer-col">
        <label className="vis-hidden" htmlFor={`${id}-draft`}>{t("board.chat.composer.reply")}</label>
        {listOpen && (
          <ul className="chat-slash" id={listId} role="listbox" aria-label={t("board.chat.compose.slash.label")}>
            {items.map((item, i) => (
              <li key={item.name} id={optionId(i)} className="chat-slash-row" role="option" aria-selected={i === activeAt}
                data-active={i === activeAt || undefined}
                onMouseDown={event => event.preventDefault()}
                onMouseMove={() => { if (i !== activeAt) setActive(i); }}
                onClick={() => complete(i)}>
                <span className="chat-slash-name">{item.name}</span>
                <span className="chat-slash-about">{item.about ? t(item.about) : t("board.chat.compose.slash.used")}</span>
                {item.term && <span className="chat-slash-term"><ToolTerminalGlyph />{t("board.chat.compose.slash.term")}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="chat-composer-input">
          {pictures && (
            <ul className="chat-images" role="list" aria-label={t("board.chat.compose.image.list")}>
              {images.map((image, i) => {
                const thumb = thumbs.get(image.blob);
                return (
                  <li key={image.id} className="chat-image">
                    {thumb
                      ? <img className="chat-image-thumb" src={thumb} alt={t("board.chat.compose.image.alt", { n: i + 1 })} />
                      : <span className="chat-image-thumb" role="img" aria-label={t("board.chat.compose.image.alt", { n: i + 1 })} />}
                    <button
                      ref={button => {
                        if (button) removeButtons.current.set(image.id, button);
                        else removeButtons.current.delete(image.id);
                      }}
                      type="button"
                      className="chat-image-remove"
                      aria-disabled={sending || undefined}
                      aria-label={t("board.chat.compose.image.remove", { n: i + 1 })}
                      title={t("board.chat.compose.image.remove", { n: i + 1 })}
                      onClick={() => remove(image)}
                    ><KitIcon name="close" /></button>
                  </li>
                );
              })}
            </ul>
          )}
          <textarea
            ref={textarea}
            id={`${id}-draft`}
            className="chat-composer-draft"
            rows={1}
            value={value}
            placeholder={t("board.chat.composer.placeholder")}
            aria-describedby={`${id}-hint ${id}-status`}
            aria-autocomplete="list"
            aria-controls={listOpen ? listId : undefined}
            aria-activedescendant={listOpen ? optionId(activeAt) : undefined}
            aria-busy={sending || undefined}
            readOnly={sending || undefined}
            onChange={event => change(event.currentTarget.value)}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={() => { composing.current = false; }}
            onKeyDown={onKeyDown}
          />
          {stopShown ? (
            <button className="btn chat-composer-stop" type="button" disabled={stopping}
              title={t("board.chat.stop.title")} aria-label={t("board.chat.stop.title")}
              onClick={() => { void stop(); }}>{t("board.chat.stop")}</button>
          ) : (
            <button className="btn primary chat-composer-send" type="submit" disabled={disabled} aria-busy={sending || undefined}>{t("board.chat.composer.send")}</button>
          )}
        </div>
        <span id={`${id}-hint`} className="vis-hidden">{t("board.chat.composer.hint")} {t("board.chat.compose.hint")}</span>
        <div className="chat-composer-meta">
          <p id={`${id}-status`} className="chat-composer-status" role="status" aria-live="polite" aria-atomic="true"
            data-result={statusResult}>{message}</p>
          {showTerm && <button className="chat-composer-term" type="button" onClick={onShowTerm}>{t("board.chat.showTerm")}</button>}
        </div>
      </div>
    </form>
  );
}
