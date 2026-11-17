// Resizing a tracker's dialog (IntegrationModal): the size it remembers, the
// handles on its edges and corners, and the Size menu in its header. One set
// for every provider, so Jira, GitLab and GitHub resize the same way.
//
// - Every edge and corner has an 8px zone just outside the 1px border, with
//   the cursor for its direction; on hover the edge shows a 2px accent line.
//   The opposite edge stays where it is. The grip in the bottom-right corner
//   is always drawn, and a double click on it goes back to the default size.
//   While a drag runs, a readout under the corner says the size. Nothing
//   moves the dialog: the header is not a handle.
// - During a drag the size is written straight onto the dialog's custom
//   properties as the pointer moves, so the panel inside does not render
//   again on every move; the size is kept when the pointer lets go.
// - The Size menu is the keyboard's way to every size: the default, the whole
//   window, the smallest, Resize with the keyboard (the arrows change the size
//   by 32, 128 with Shift; Enter keeps it, Escape puts it back; the size is
//   announced as it changes) and Reset size.
// - On a phone the dialog is a full-screen sheet and none of this is drawn.
//
// The arithmetic is integrations/dialog-size.ts; the clamp to the window is
// integrations.css, which needs no script when the window changes size.
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import {
  chosenFor, DIALOG_MIN, dragRect, edgeSides, EDGES, offsetOf, presetOf, readChosenSize, SHEET_QUERY, SIZE_STEP, SIZE_STEP_LARGE,
  sizeProperties, stepRect, writeChosenSize, type ChosenSize, type Edge, type Offset, type Rect, type Room, type SizePreset,
} from "../integrations/dialog-size";
import { useT } from "../i18n";
import { modalStack } from "../modal-dismiss";
import { useMediaQuery } from "../use-media-query";
import AnchoredPopover from "./AnchoredPopover";
import { CheckGlyph } from "./integration-glyphs";
import { KitIcon } from "./kit-icons";

/** The window as the dialog's scrim measures it, and the title bar band the
 *  CSS keeps the dialog clear of (--ig-top). */
function roomOf(dialog: HTMLElement): Room {
  const box = dialog.parentElement?.getBoundingClientRect();
  const top = parseFloat(getComputedStyle(dialog).getPropertyValue("--ig-top")) || 0;
  return { width: box?.width || window.innerWidth, height: box?.height || window.innerHeight, top };
}

function rectOfElement(el: HTMLElement): Rect {
  const box = el.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

/** A size and place written onto the dialog while a drag runs. */
function applyRect(dialog: HTMLElement, rect: Rect, room: Room) {
  const offset = offsetOf(rect, room);
  dialog.style.setProperty("--ig-w", `${Math.round(rect.width)}px`);
  dialog.style.setProperty("--ig-h", `${Math.round(rect.height)}px`);
  dialog.style.setProperty("--ig-x", `${offset.x}px`);
  dialog.style.setProperty("--ig-y", `${offset.y}px`);
}

/** Whether a readout under the dialog would leave the window: then it is drawn
 *  inside the dialog's foot. */
const readoutInside = (rect: Rect, room: Room) => room.height - (rect.top + rect.height) < 36;

interface KeyboardMode {
  /** What to put back on Escape. */
  before: { chosen: ChosenSize; offset: Offset | null };
  /** The size and place on screen, as the arrows moved it. */
  rect: Rect;
  inside: boolean;
}

export interface DialogResize {
  /** False on the phone's sheet: no handles and no Size button. */
  enabled: boolean;
  dialogRef: RefObject<HTMLElement | null>;
  /** The custom properties for the dialog's style. */
  style: CSSProperties | undefined;
  /** Which of the menu's sizes is on, if any. */
  preset: SizePreset | null;
  /** One of the menu's sizes: the default keeps the dialog where it is, the
   *  whole window centres it. */
  choose: (preset: SizePreset) => void;
  /** The default size, centred: the dialog as it first opened. */
  reset: () => void;
  /** A drag let go at this rect. */
  commit: (rect: Rect) => void;
  keyboard: KeyboardMode | null;
  /** Resize with the keyboard; focus goes back to `returnTo` when it ends. */
  startKeyboard: (returnTo: HTMLElement | null) => void;
  /** One arrow press; false for any other key. */
  stepKeyboard: (key: string, large: boolean) => boolean;
  /** Enter (keep) or Escape (put back). */
  endKeyboard: (keep: boolean) => void;
}

/** The size and place of one provider's dialog. */
export function useDialogResize(kind: string, dialogRef: RefObject<HTMLElement | null>): DialogResize {
  const sheet = useMediaQuery(SHEET_QUERY);
  const [chosen, setChosen] = useState<ChosenSize>(() => readChosenSize(kind));
  const [offset, setOffset] = useState<Offset | null>(null);
  const [keyboard, setKeyboard] = useState<KeyboardMode | null>(null);
  const keyboardRef = useRef(keyboard);
  keyboardRef.current = keyboard;
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;
  const returnTo = useRef<HTMLElement | null>(null);

  const remember = useCallback((next: ChosenSize) => { setChosen(next); writeChosenSize(kind, next); }, [kind]);
  const choose = useCallback((preset: SizePreset) => {
    remember(chosenFor(preset));
    if (preset === "fill") setOffset(null);
  }, [remember]);
  const reset = useCallback(() => { remember(null); setOffset(null); }, [remember]);
  const commit = useCallback((rect: Rect) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    remember({ width: Math.round(rect.width), height: Math.round(rect.height) });
    setOffset(offsetOf(rect, roomOf(dialog)));
  }, [dialogRef, remember]);

  const startKeyboard = useCallback((from: HTMLElement | null) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    returnTo.current = from;
    const rect = rectOfElement(dialog);
    setKeyboard({ before: { chosen: chosenRef.current, offset }, rect, inside: readoutInside(rect, roomOf(dialog)) });
  }, [dialogRef, offset]);
  const stepKeyboard = useCallback((key: string, large: boolean) => {
    const mode = keyboardRef.current;
    const dialog = dialogRef.current;
    if (!mode || !dialog) return false;
    const room = roomOf(dialog);
    const next = stepRect(mode.rect, key, large, room);
    if (!next) return false;
    // Held at once, so a second press before the next render steps from here.
    const nextMode = { ...mode, rect: next, inside: readoutInside(next, room) };
    const size = { width: next.width, height: next.height };
    keyboardRef.current = nextMode;
    chosenRef.current = size;
    setKeyboard(nextMode);
    setChosen(size);
    setOffset(offsetOf(next, room));
    return true;
  }, [dialogRef]);
  const endKeyboard = useCallback((keep: boolean) => {
    const mode = keyboardRef.current;
    if (!mode) return;
    keyboardRef.current = null;
    setKeyboard(null);
    if (keep) writeChosenSize(kind, chosenRef.current);
    else { setChosen(mode.before.chosen); setOffset(mode.before.offset); }
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  }, [kind]);

  // Escape puts the size back before it closes anything: keyboard mode is on
  // the deck's dismiss stack, above the dialog, for as long as it lasts.
  const endRef = useRef(endKeyboard);
  endRef.current = endKeyboard;
  const inKeyboard = keyboard != null;
  useEffect(() => (inKeyboard ? modalStack.push(() => endRef.current(false), 0, "popover") : undefined), [inKeyboard]);
  // Grown into a phone's width, the sheet takes over: keyboard mode ends.
  useEffect(() => { if (sheet) endRef.current(false); }, [sheet]);

  return {
    enabled: !sheet,
    dialogRef,
    style: sheet ? undefined : (sizeProperties(chosen, offset) as CSSProperties),
    preset: presetOf(chosen),
    choose, reset, commit,
    keyboard, startKeyboard, stepKeyboard, endKeyboard,
  };
}

interface Drag {
  edge: Edge;
  x: number;
  y: number;
  start: Rect;
  room: Room;
  last: Rect;
  moved: boolean;
}

/** The edges, the corners, the grip, the drag's readout and the keyboard
 *  mode's band. Drawn inside the dialog, outside its clipped frame. */
export function DialogResizeHandles({ resize }: { resize: DialogResize }) {
  const t = useT();
  const drag = useRef<Drag | null>(null);
  const [readout, setReadout] = useState<{ width: number; height: number; inside: boolean } | null>(null);
  const { dialogRef, commit, reset, keyboard } = resize;

  const begin = (edge: Edge) => (event: PointerEvent<HTMLDivElement>) => {
    const dialog = dialogRef.current;
    if (event.button !== 0 || !dialog) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = rectOfElement(dialog);
    drag.current = { edge, x: event.clientX, y: event.clientY, start, room: roomOf(dialog), last: start, moved: false };
    dialog.dataset.resizing = edgeSides(edge);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const dialog = dialogRef.current;
    if (!d || !dialog) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && dx === 0 && dy === 0) return;
    d.moved = true;
    d.last = dragRect(d.start, d.edge, dx, dy, d.room);
    applyRect(dialog, d.last, d.room);
    setReadout({ width: d.last.width, height: d.last.height, inside: readoutInside(d.last, d.room) });
  };
  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const dialog = dialogRef.current;
    if (dialog) delete dialog.dataset.resizing;
    setReadout(null);
    // A press that did not move keeps the size as it was, the default included.
    if (d.moved) commit(d.last);
  };
  const handlers = (edge: Edge) => ({
    onPointerDown: begin(edge), onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end,
  });

  return (
    <>
      {EDGES.map(edge => <div key={edge} className="ig-rs" data-edge={edge} aria-hidden="true" {...handlers(edge)} />)}
      <div className="ig-rs-grip" aria-hidden="true" title={t("integrations.size.grip")} {...handlers("se")} onDoubleClick={reset}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
          <path d="M10.6 3.6 3.6 10.6M10.6 7 7 10.6" />
        </svg>
      </div>
      {readout && (
        <div className="ig-rs-readout" data-inside={readout.inside || undefined} aria-hidden="true">
          {t("integrations.size.readout", { w: Math.round(readout.width), h: Math.round(readout.height) })}
        </div>
      )}
      {keyboard && <KeyboardBand resize={resize} mode={keyboard} />}
    </>
  );
}

/** Keyboard mode: the band under the dialog that takes the arrows, says what
 *  they do, and shows and announces the size. */
function KeyboardBand({ resize, mode }: { resize: DialogResize; mode: KeyboardMode }) {
  const t = useT();
  const id = useId();
  const self = useRef<HTMLDivElement>(null);
  const { stepKeyboard, endKeyboard } = resize;
  useEffect(() => { self.current?.focus({ preventScroll: true }); }, []);
  const w = Math.round(mode.rect.width);
  const h = Math.round(mode.rect.height);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      endKeyboard(true);
      return;
    }
    if (stepKeyboard(event.key, event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  return (
    <div ref={self} className="ig-rs-keys" data-inside={mode.inside || undefined} tabIndex={-1} role="application"
      aria-label={t("integrations.size.keyboard")} aria-describedby={`${id}-help`} onKeyDown={onKeyDown}
      // Leaving the band any other way keeps the size it has.
      onBlur={() => endKeyboard(true)}>
      <span className="ig-rs-keys-title">{t("integrations.size.resizing")}</span>
      <span className="ig-rs-keys-hint" aria-hidden="true">{t("integrations.size.keysHint", { step: SIZE_STEP, large: SIZE_STEP_LARGE })}</span>
      <span className="ig-rs-readout" data-band="" aria-hidden="true">{t("integrations.size.readout", { w, h })}</span>
      <span className="vis-hidden" id={`${id}-help`}>{t("integrations.size.keysHelp", { step: SIZE_STEP, large: SIZE_STEP_LARGE })}</span>
      <span className="vis-hidden" role="status">{t("integrations.size.announce", { w, h })}</span>
    </div>
  );
}

/** The Size button in the header and its menu. */
export function DialogSizeMenu({ resize }: { resize: DialogResize }) {
  const t = useT();
  const id = useId();
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const trigger = `${id}-size`;
  const { preset, choose, reset, startKeyboard } = resize;
  const triggerEl = () => document.getElementById(trigger);
  const pick = (act: () => void) => {
    setMenu(null);
    act();
    triggerEl()?.focus({ preventScroll: true });
  };
  const item = (label: string, onClick: () => void, on?: boolean) => (
    <button type="button" role="menuitem" className="ap-menu-item ig-size-item" aria-current={on || undefined} onClick={onClick}>
      <span className="ig-size-label">{label}</span>
      <span className="ig-size-check" aria-hidden="true">{on && <CheckGlyph />}</span>
    </button>
  );
  return (
    <span className="ig-size" id={`${id}-layer`}>
      <button id={trigger} type="button" className="glyph-btn ig-size-btn" aria-label={t("integrations.size.button")} title={t("integrations.size.button")}
        aria-haspopup="menu" aria-expanded={menu != null} aria-controls={menu ? `${id}-menu` : undefined}
        onClick={() => setMenu(m => (m ? null : "first"))}
        onKeyDown={event => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setMenu(event.key === "ArrowUp" ? "last" : "first");
        }}>
        <KitIcon name="zoom" />
      </button>
      {menu && (
        <AnchoredPopover anchorId={trigger} portalRootId={`${id}-layer`} id={`${id}-menu`} className="ap-pop ig-size-pop" role="menu"
          labelledBy={trigger} start={menu} onClose={() => setMenu(null)}>
          {item(t("integrations.size.default"), () => pick(() => choose("default")), preset === "default")}
          {item(t("integrations.size.fill"), () => pick(() => choose("fill")), preset === "fill")}
          {item(t("integrations.size.smaller", { w: DIALOG_MIN.width, h: DIALOG_MIN.height }), () => pick(() => choose("smaller")), preset === "smaller")}
          <div className="ap-menu-sep" role="separator" />
          {item(t("integrations.size.keyboard"), () => { setMenu(null); startKeyboard(triggerEl()); })}
          <div className="ap-menu-sep" role="separator" />
          {item(t("integrations.size.reset"), () => pick(reset))}
        </AnchoredPopover>
      )}
    </span>
  );
}
