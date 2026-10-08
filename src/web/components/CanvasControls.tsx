// The canvas's command stack, bottom left: zoom in and out, recenter, pause,
// re-arrange, clear, and the keyboard reference.
//
// Moved out of App.tsx's markup unchanged. It renders inside <ReactFlow>, which
// is what gives it the viewport and the store; App.tsx keeps the commands
// themselves (the relayout, the clear confirmation, the pause gate, the
// auto-fit switch) and this file only lays out the buttons that call them.
import type { Dispatch, SetStateAction } from "react";
import { Controls, ControlButton, useReactFlow, useStore, type ReactFlowState } from "reactflow";
import type { ClearSource } from "../clear-confirm";
import { withKey } from "../single-key-shortcuts";
import { PAUSE_LABEL, pauseTitle } from "../status-pill";
import type { PauseControls } from "../use-pause-gate";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";

/** The zoom range's two ends, as React Flow's own zoom buttons read them.
 *  Module-level so `useStore` gets the same selector every render. */
const zoomAtMax = (s: ReactFlowState) => s.transform[2] >= s.maxZoom;
const zoomAtMin = (s: ReactFlowState) => s.transform[2] <= s.minZoom;

export default function CanvasControls({
  autoFitDisabled, enableAutoFitAndRefit, paused, pauseGate, togglePause,
  handleRelayout, requestClear, setKeyHelpOpen,
}: {
  autoFitDisabled: boolean;
  enableAutoFitAndRefit: () => void;
  paused: boolean;
  pauseGate: PauseControls["pauseGate"];
  togglePause: PauseControls["togglePause"];
  handleRelayout: () => void;
  requestClear: (source: ClearSource) => void;
  setKeyHelpOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const rf = useReactFlow();
  // Whether the canvas's own zoom buttons can go any further, which is the
  // one fact they need from the store. Booleans, so this re-renders when a
  // limit is reached or left, not on every zoom frame.
  const zoomMaxed = useStore(zoomAtMax);
  const zoomMinned = useStore(zoomAtMin);
  const singleKeys = useSingleKeyShortcuts();
  return (
    <Controls showInteractive={false} showFitView={false} showZoom={false}>
      {/* Zoom in and out, drawn here rather than left to React Flow, so
          the pair wears the same 14px stroke glyphs as the five below
          them (React Flow's are filled shapes a weight heavier and 2px
          smaller) and names itself in words. The same calls React Flow's
          own buttons make, with the same limits: each refuses at its end
          of the zoom range. It refuses with aria-disabled rather than
          `disabled`, because a press from the keyboard is what reaches the
          limit, and a button disabled under focus drops that focus to the
          page (#1768, the rule #518/#620 set in panel-press.ts). */}
      <ControlButton
        onClick={() => { if (!zoomMaxed) rf.zoomIn(); }}
        title="Zoom in"
        aria-label="Zoom in"
        aria-disabled={zoomMaxed || undefined}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </ControlButton>
      <ControlButton
        onClick={() => { if (!zoomMinned) rf.zoomOut(); }}
        title="Zoom out"
        aria-label="Zoom out"
        aria-disabled={zoomMinned || undefined}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </ControlButton>
      {/* data-nudge while auto-fit is off: the glyph steps up to the
          foreground, because pressing it now would do something. It was
          the accent; the canvas's Auto-fit chip is what says why. */}
      <ControlButton
        onClick={enableAutoFitAndRefit}
        title={autoFitDisabled
          ? "Recenter view + re-enable autofit"
          : "Recenter view (autofit already on)"}
        aria-label="Recenter view"
        data-nudge={autoFitDisabled ? "" : undefined}
      >
        {/* crosshair / target — recenter affordance */}
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </ControlButton>
      {/* The last control out of the topbar, and the only toggle in this
          stack. Second rather than first: Recenter above it belongs beside
          the zoom buttons, the view's other commands, and these two are
          the reversible, often-pressed pair — putting Pause here keeps the
          one control that destroys something at the far end of the column
          from the one a hand comes back to.
          It reports its state, which none of its neighbours has to.
          They are one-shot commands and a glyph is a complete account of
          what a command does; this one is a setting that stays on, so
          there is a fact about it that is true between presses and a user
          has to be able to read it. aria-pressed is how this deck says
          that — the sound switch in the bar above is the same shape of
          control and has carried it since #370 — and it is not
          aria-expanded, because nothing is disclosed: no region appears,
          the canvas simply stops repainting.
          Which is also why the glyph does NOT flip to a play triangle.
          The media-player convention prints the ACTION on the button, and
          that convention contradicts aria-pressed rather than completing
          it: an eye reading a triangle is told the canvas is frozen and
          the button will play, while a reader hearing Pause plus pressed
          is told the same fact the other way round. One mark, then, with
          the state carried in the one channel both audiences read —
          the same choice the two panel toggles make with their own
          unchanging glyphs.
          That channel is a polarity inversion and not a hue: --text on
          --panel at rest becomes --bg on --warn when pressed, a luminance
          step a greyscale screen, a photocopy and every colour vision
          deficiency all still read. Amber because amber is what a frozen
          canvas is drawn in everywhere else on this deck — the pill at the
          other end of the bar and the dot inside it — and the pill and
          this control were a matched pair before it moved. */}
      {/* data-group-start: the first of a group, which the stack marks
          with a gap and a hairline. The groups are the view (zoom,
          recenter), the canvas's state (pause, re-arrange), the one
          that empties it (clear), and help. */}
      <ControlButton
        data-group-start=""
        onClick={togglePause}
        title={pauseTitle({ paused, held: pauseGate.size, dropped: pauseGate.dropped, singleKeys })}
        aria-label={PAUSE_LABEL}
        aria-pressed={paused}
      >
        {/* two upright bars — the pause mark, drawn as strokes so it sits
            at the weight of the four glyphs around it */}
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path d="M9 5.5v13M15 5.5v13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </ControlButton>
      {/* Down from the topbar. Both of these are canvas verbs —
          they rearrange or empty the thing this stack is attached to —
          and the crosshair above was already the proof that a command
          belongs here and not only a zoom control. `F` fits the view and
          has never had a topbar button either; `R` and `C` are the same
          shape of shortcut and now have the same kind of home.
          The titles are the strings the two buttons carried in the bar,
          unchanged, so the shortcut letters and the sentence a user
          already knows survive the move. What they gain is aria-label:
          up there each was its own name, printed on it; here the glyph
          is the whole button, and a glyph has no accessible name. */}
      <ControlButton
        onClick={handleRelayout}
        title={withKey("Auto-arrange — clear pins", "R", singleKeys)}
        aria-label="Re-arrange the canvas"
      >
        {/* three-node hierarchy — one parent over two children */}
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <rect x="8.5" y="2" width="7" height="5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <rect x="1.5" y="17" width="7" height="5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <rect x="15.5" y="17" width="7" height="5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 7v6.5M5 17v-3.5h14V17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </ControlButton>
      {/* No danger colour at rest, and no word either. `button.btn.danger`
          is the confirm half of the Clear dialog and stays there: this
          button destroys nothing, it opens a question, and colouring the
          question the same as the answer would leave the deck with two
          red controls of which only one is irreversible.
          A trash can rather than a broom. At 14px a broom is a diagonal
          line with fringe on the end and reads as almost anything; the
          can is the one glyph nobody has to be taught. The word "Clear"
          is not lost — it is the dialog's own heading, one click away,
          which is where the user reads it when it matters. */}
      <ControlButton
        data-group-start=""
        data-danger=""
        onClick={() => requestClear("button")}
        title={withKey("Clear the canvas and the server's event log — asks first", "C", singleKeys)}
        aria-label="Clear the canvas"
      >
        {/* trash can — lid, handle, tapered body, two inner strokes */}
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path d="M4 6.2h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M9 6.2V4.4a1.6 1.6 0 0 1 1.6-1.6h2.8a1.6 1.6 0 0 1 1.6 1.6v1.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M17.4 6.4 16.7 20a2 2 0 0 1-2 1.9H9.3a2 2 0 0 1-2-1.9L6.6 6.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M10.3 10.6v6.8M13.7 10.6v6.8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
      </ControlButton>
      {/* The one thing on screen that says the keyboard exists.
          It is here and not in the topbar, deliberately. The bar was cut
          back to identity, status and settings this week and the canvas
          verbs moved down into this stack; a control that opens a
          reference about the canvas is the same kind of thing. What it
          buys over the list in the detail rail is that it is always
          there: the rail draws its shortcuts only while nothing is
          selected, and it can be closed outright, so on the deck a user
          actually works in there is no other affordance at all.
          A glyph rather than a word, like the four above it, and the key
          is in the tooltip the way every other control on this deck
          names its own. */}
      <ControlButton
        data-group-start=""
        onClick={() => setKeyHelpOpen(o => !o)}
        title={singleKeys ? withKey("Keyboard shortcuts", "?", true) : "Keyboard shortcuts — the single-key ones are off"}
        aria-label="Open the keyboard shortcuts"
        aria-haspopup="dialog"
      >
        {/* A question mark drawn rather than typed: the stack's other
            four are strokes at 14px and a glyph from the body face would
            sit a weight and a baseline away from them. */}
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
          <path d="M8.6 8.4a3.5 3.5 0 1 1 4.6 3.35c-.85.3-1.2 1-1.2 1.85v1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <path d="M12 18.4v.2" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        </svg>
      </ControlButton>
    </Controls>
  );
}
