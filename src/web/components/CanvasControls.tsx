// The canvas's command bar, bottom right (V4's Board / Controls): zoom out, the
// zoom level, zoom in | recenter, and one ⋯ "More actions" whose menu holds the
// rest — re-arrange, pause, clear, the Command Panel, the keyboard reference and
// the tool filter. With no session yet, the Command Panel alone.
//
// CHANGED ON PURPOSE (V4 top-10 #5): the bar drew eight buttons, three of them
// verbs used a few times a day, and a "Tools" button floated on its own at the
// canvas's top left. The view's controls stay one press away; everything else
// is in the menu, each row with its key, and the tool filter is the menu's last
// group, so nothing floats over the cards any more.
//
// Moved out of App.tsx's markup unchanged. It renders inside <ReactFlow>, which
// is what gives it the viewport and the store; App.tsx keeps the commands
// themselves (the relayout, the clear confirmation, the pause gate, the
// auto-fit switch, the filter's state) and this file only lays out the
// controls that call them.
import { useId, useState, type Dispatch, type SetStateAction } from "react";
import { Controls, ControlButton, useStore, type ReactFlowState } from "reactflow";
import type { ClearSource } from "../clear-confirm";
import type { DetailCategory } from "../detail-category";
import { useT } from "../i18n";
import type { PauseControls } from "../use-pause-gate";
import { useBoardEmpty } from "../board-empty";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { zoomPercent } from "../zoom-percent";
import AnchoredPopover from "./AnchoredPopover";
import CategoryFilterBar from "./CategoryFilterBar";
import { Kbd } from "./Kbd";
import { KitIcon } from "./kit-icons";

/** The zoom range's two ends, as React Flow's own zoom buttons read them.
 *  Module-level so `useStore` gets the same selector every render. */
const zoomAtMax = (s: ReactFlowState) => s.transform[2] >= s.maxZoom;
const zoomAtMin = (s: ReactFlowState) => s.transform[2] <= s.minZoom;
/** The level, as the string the bar prints: a new value only when the whole
 *  percent changes, so a pinch does not re-render the bar every frame. */
const zoomLevel = (s: ReactFlowState) => zoomPercent(s.transform[2]);
/** One press of + or −: the 1.2 React Flow's own buttons step by. */
const ZOOM_STEP = 1.2;

const NO_CATS: readonly DetailCategory[] = [];
const NONE_HIDDEN: ReadonlySet<DetailCategory> = new Set();

/** The tool filter's group shows when the board has calls of two kinds or
 *  more, or a kind is hidden: the rule the floating "Tools" button had (#783).
 *  A filter kept for a kind that has left the board is still a filter, and the
 *  menu keeps the one press that shows everything again. */
export function toolFilterShown(presentCats: readonly DetailCategory[], hiddenCats: ReadonlySet<DetailCategory>): boolean {
  return presentCats.length > 1 || hiddenCats.size > 0;
}

/** Whether calls on the board are hidden right now: what "Tools 1 of 2" said,
 *  and what the dot on ⋯ says now. */
export function toolFilterActive(presentCats: readonly DetailCategory[], hiddenCats: ReadonlySet<DetailCategory>): boolean {
  return presentCats.some(c => hiddenCats.has(c));
}

export default function CanvasControls({
  autoFitDisabled, enableAutoFitAndRefit, paused, togglePause,
  handleRelayout, requestClear, setKeyHelpOpen, zoomBy, zoomReset, onTerminal,
  presentCats = NO_CATS, hiddenCats = NONE_HIDDEN, toggleCat,
}: {
  autoFitDisabled: boolean;
  enableAutoFitAndRefit: () => void;
  /** Whether the canvas is paused: the menu's row says Pause or Resume. What
   *  is held while it is, the top bar's paused pill counts. */
  paused: boolean;
  togglePause: PauseControls["togglePause"];
  handleRelayout: () => void;
  requestClear: (source: ClearSource) => void;
  setKeyHelpOpen: Dispatch<SetStateAction<boolean>>;
  /** The zoom steps: Fast, on the camera's own transition, from where it is (use-camera.ts). */
  zoomBy: (factor: number) => void;
  zoomReset: () => void;
  /** The terminal stage's way in from the canvas (use-stage.ts
   *  openFromButton), or absent — and with it the button — while the hidden
   *  terminal flag is off. */
  onTerminal?: (button: Element | null) => void;
  /** The tool filter (use-category-filter-bar.ts): the kinds with a call on
   *  the board, the ones hidden, and the one way the hidden set changes. */
  presentCats?: readonly DetailCategory[];
  hiddenCats?: ReadonlySet<DetailCategory>;
  toggleCat?: (c: DetailCategory) => void;
}) {
  const t = useT();
  // Whether the canvas's own zoom buttons can go any further, which is the
  // one fact they need from the store. Booleans, so this re-renders when a
  // limit is reached or left, not on every zoom frame.
  const zoomMaxed = useStore(zoomAtMax);
  const zoomMinned = useStore(zoomAtMin);
  // An empty board has nothing to zoom, fit, re-arrange, pause or clear: the
  // bar keeps only the Command Panel, whose empty stage starts a session, and
  // is not drawn at all without it (board-empty.ts). Not in a menu there: it
  // is the one thing an empty board can do.
  const empty = useBoardEmpty();
  if (empty) {
    return onTerminal ? (
      <Controls position="bottom-right" showInteractive={false} showFitView={false} showZoom={false}>
        <CommandPanelButton onTerminal={onTerminal} />
      </Controls>
    ) : null;
  }
  return (
    <Controls position="bottom-right" showInteractive={false} showFitView={false} showZoom={false}>
      {/* Zoom out, the level, zoom in, drawn here rather than left to React
          Flow, so the pair wears the same 14px stroke glyphs as the buttons
          after them (React Flow's are filled shapes a weight heavier and 2px
          smaller) and names itself in words. The same calls React Flow's
          own buttons make, with the same limits: each refuses at its end
          of the zoom range. It refuses with aria-disabled rather than
          `disabled`, because a press from the keyboard is what reaches the
          limit, and a button disabled under focus drops that focus to the
          page (#1768, the rule #518/#620 set in panel-press.ts). */}
      <ControlButton
        onClick={() => { if (!zoomMinned) zoomBy(1 / ZOOM_STEP); }}
        title={t("board.controls.zoomOut")}
        aria-label={t("board.controls.zoomOut")}
        aria-disabled={zoomMinned || undefined}
      >
        <KitIcon name="minus" />
      </ControlButton>
      <ZoomLevel zoomReset={zoomReset} />
      <ControlButton
        onClick={() => { if (!zoomMaxed) zoomBy(ZOOM_STEP); }}
        title={t("board.controls.zoomIn")}
        aria-label={t("board.controls.zoomIn")}
        aria-disabled={zoomMaxed || undefined}
      >
        <KitIcon name="plus" />
      </ControlButton>
      {/* Two groups: the view (zoom), then fitting it and the menu of what
          acts on the canvas or opens something else. A 1×16 rule between
          them: decoration, so hidden from the accessibility tree and not a
          tab stop. */}
      <span className="react-flow__controls-divider" aria-hidden />
      {/* data-nudge while auto-fit is off: the glyph steps up to the
          foreground and wears a dot, because pressing it now would do
          something. It is the canvas's one fit control: the Fit all chip
          that did the same went (V4 top-10 #3), and its title says it. */}
      <ControlButton
        onClick={enableAutoFitAndRefit}
        title={autoFitDisabled
          ? t("board.controls.recenterOn")
          : t("board.controls.recenterAuto")}
        aria-label={t("board.controls.recenter")}
        data-nudge={autoFitDisabled ? "" : undefined}
      >
        <KitIcon name="recenter" />
      </ControlButton>
      <CanvasMore
        paused={paused} togglePause={togglePause} handleRelayout={handleRelayout} requestClear={requestClear}
        setKeyHelpOpen={setKeyHelpOpen} onTerminal={onTerminal}
        presentCats={presentCats} hiddenCats={hiddenCats} toggleCat={toggleCat}
      />
    </Controls>
  );
}

/** The ⋯ button's id: what its menu hangs off and is named by, and where
 *  focus goes back to when a row has been chosen. */
export const CANVAS_MORE_ID = "canvas-more";
const CANVAS_MORE_MENU_ID = "canvas-more-menu";

/** One command row: its words, and its key at the right end while the single
 *  keys are on. The key is seen there and heard from aria-keyshortcuts, so
 *  the cap itself is out of the row's name. */
function MenuRow({ label, keyCap, onPick }: { label: string; keyCap?: string; onPick: () => void }) {
  const singleKeys = useSingleKeyShortcuts();
  // Every key on this menu is a single character (Space too), so the switch
  // that silences them takes the caps away with the keys.
  const key = singleKeys ? keyCap : undefined;
  return (
    <button type="button" role="menuitem" className="ap-menu-item" onClick={onPick}
      aria-keyshortcuts={key}>
      <span className="canvas-more-word">{label}</span>
      {key && <span className="canvas-more-key" aria-hidden><Kbd>{key}</Kbd></span>}
    </button>
  );
}

/** More actions: the canvas's verbs, what opens something else, and the tool
 *  filter, in a menu like the dock's More and an account's ⋯. Up and Down on
 *  the button open it at either end, the way a native menu button does. A
 *  command hands focus back to ⋯ before it runs, so a dialog it opens (Clear's
 *  question, the keyboard sheet) gives focus back there when it closes. The
 *  filter's checkboxes (CategoryFilterBar.tsx) leave the menu open: they are
 *  ticked, not run.
 *
 *  Pause is a row whose words follow the state (Pause the stream, Resume the
 *  stream) — the setting is not drawn on ⋯: the top bar's paused pill is what
 *  says the canvas is frozen. Clear the deck… is not in the danger colour: it
 *  destroys nothing, it opens the question whose answer does, and that answer
 *  is the deck's one red button. */
function CanvasMore({ paused, togglePause, handleRelayout, requestClear, setKeyHelpOpen, onTerminal, presentCats, hiddenCats, toggleCat }: {
  paused: boolean;
  togglePause: () => void;
  handleRelayout: () => void;
  requestClear: (source: ClearSource) => void;
  setKeyHelpOpen: Dispatch<SetStateAction<boolean>>;
  onTerminal?: (button: Element | null) => void;
  presentCats: readonly DetailCategory[];
  hiddenCats: ReadonlySet<DetailCategory>;
  toggleCat?: (c: DetailCategory) => void;
}) {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  const headId = useId();
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const open = menu !== null;
  // The filter's toggle, while the menu has a filter group to draw.
  const filter = toggleCat && toolFilterShown(presentCats, hiddenCats) ? toggleCat : null;
  // The dot: calls on the board are hidden, which "Tools 1 of 2" used to say.
  const filtered = filter != null && toolFilterActive(presentCats, hiddenCats);
  const name = filtered ? t("board.controls.moreFiltered") : t("accounts.row.more");
  const pick = (run: () => void) => () => {
    document.getElementById(CANVAS_MORE_ID)?.focus();
    setMenu(null);
    run();
  };
  return (
    <>
      <ControlButton
        id={CANVAS_MORE_ID}
        className="canvas-more"
        title={name}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? CANVAS_MORE_MENU_ID : undefined}
        onKeyDown={e => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setMenu(e.key === "ArrowUp" ? "last" : "first");
        }}
        onClick={() => setMenu(open ? null : "first")}
      >
        <KitIcon name="more" />
        {filtered && <span className="canvas-more-dot" aria-hidden />}
      </ControlButton>
      {open && (
        <AnchoredPopover anchorId={CANVAS_MORE_ID} id={CANVAS_MORE_MENU_ID} className="ap-pop canvas-more-pop" role="menu"
          labelledBy={CANVAS_MORE_ID} start={menu} onClose={() => setMenu(null)}>
          <MenuRow label={t("board.controls.arrangeLabel")} keyCap="R" onPick={pick(handleRelayout)} />
          <MenuRow label={paused ? t("board.quick.action.resume") : t("board.quick.action.pause")}
            keyCap="Space" onPick={pick(togglePause)} />
          <MenuRow label={t("board.quick.action.clear")} keyCap="C" onPick={pick(() => requestClear("button"))} />
          <div role="separator" className="ap-menu-sep" />
          {/* The stage grows out of the card when it is on screen, else out of
              the control it was opened from: ⋯, now that the button is a row. */}
          {onTerminal && (
            <MenuRow label={t("board.controls.openPanel")}
              onPick={pick(() => onTerminal(document.getElementById(CANVAS_MORE_ID)))} />
          )}
          {/* With Settings › General's single keys off, ? does nothing, and the
              row says why where the cap would have been (WCAG 2.1.4), as the
              bar's keyboard button's tooltip did. */}
          <MenuRow label={singleKeys ? t("board.controls.keys") : t("board.controls.keysOff")} keyCap="?"
            onPick={pick(() => setKeyHelpOpen(o => !o))} />
          {filter && (
            <>
              <div role="separator" className="ap-menu-sep" />
              <CategoryFilterBar headId={headId} presentCats={presentCats} hiddenCats={hiddenCats} toggleCat={filter} />
            </>
          )}
        </AnchoredPopover>
      )}
    </>
  );
}

/** The terminal, behind its hidden flag: the selected session on the
 *  stage, else the one the stage showed last, else the empty stage,
 *  whose one action is New session — which is why it is the one button an
 *  empty board keeps. On a board with sessions it is a row of ⋯'s menu. The
 *  stage grows out of the session's card when it is on screen, else out of
 *  this button, which is why the press hands the button over. */
function CommandPanelButton({ onTerminal }: { onTerminal: (button: Element | null) => void }) {
  const t = useT();
  return (
    <ControlButton
      onClick={e => onTerminal(e.currentTarget)}
      title={t("board.controls.openPanelTip")}
      aria-label={t("board.controls.openPanel")}
    >
      <KitIcon name="terminal" />
    </ControlButton>
  );
}

/** The level, on its own: a zoom gesture re-renders this one button rather
 *  than the bar, and the store hands it a new string only when the whole
 *  percent changes. It is also the way back to 100%: zoomTo scales about the
 *  centre of the viewport and, like the two buttons beside it, takes no
 *  duration. Named for both halves, because a reader who hears only "100%"
 *  does not learn that it can be pressed. */
function ZoomLevel({ zoomReset }: { zoomReset: () => void }) {
  const t = useT();
  const level = useStore(zoomLevel);
  return (
    <ControlButton
      data-zoom-level=""
      onClick={zoomReset}
      title={t("board.controls.zoomReset")}
      aria-label={t("board.controls.zoomLabel", { level })}
    >
      {level}
    </ControlButton>
  );
}
