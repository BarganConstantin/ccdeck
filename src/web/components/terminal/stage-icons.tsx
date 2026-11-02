// The stage's glyphs: one stroke weight, drawn in currentColor, and hidden
// from assistive technology — every control that carries one is named in
// words, by its aria-label, so the picture is never the only way to know.
//
// Kept here rather than inline in each component because the header, the
// state cards and the New session popover share several of them, and two
// copies of one path are two drawings that drift.
import type { ReactNode } from "react";
import type { TerminalProvider } from "../../terminal-api";
import { KitIcon } from "../kit-icons";
import { AlertMark, StateMark } from "../StateMark";
import type { StageState } from "./stage-model";

function Glyph({ size = 16, box = 16, children }: { size?: number; box?: number; children: ReactNode }) {
  return (
    <svg className="ts-icon" width={size} height={size} viewBox={`0 0 ${box} ${box}`} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** The provider, on the New session popover's agent switch. */
export function ProviderGlyph({ provider, size = 10 }: { provider: TerminalProvider; size?: number }) {
  return provider === "codex"
    ? <Glyph size={size} box={12}><path d="M2 3.5 4.5 6 2 8.5M6 9h4" /></Glyph>
    : <Glyph size={size} box={12}><path d="M6 1.5v9M1.5 6h9M2.8 2.8l6.4 6.4M9.2 2.8 2.8 9.2" /></Glyph>;
}

/** The four marks the rail draws a row with (RailGlyph, RailParts.tsx). */
export type StageGlyphKind = "waiting" | "working" | "done" | "idle";

/**
 * The rail's glyph for a stage state (V4): the header and the keys bar say
 * a state with the same 14px mark the session's row says it with, so the
 * rail, the header and the bar agree on what a mark means. Working is what
 * a session that is attaching or starting is doing too; the hollow mark is
 * the session at its prompt, a session not asking for you, one running
 * elsewhere and a pane someone else took; ended is the rail's tick. The
 * empty stage has no session to mark.
 */
export function glyphForState(state: StageState): StageGlyphKind | null {
  switch (state) {
    case "working":
    case "attaching":
    case "starting":
      return "working";
    case "waiting":
      return "waiting";
    case "ended":
      return "done";
    case "none":
      return null;
    default:
      return "idle";
  }
}

/** The 14px state glyph: the rail's marks (StateMark, AlertMark), without the
 *  rail's row around them. Decoration beside words that say the same. */
export function StageGlyph({ kind }: { kind: StageGlyphKind }) {
  return (
    <span className="ts-glyph" data-glyph={kind} aria-hidden="true">
      {kind === "waiting" && <AlertMark size={14} />}
      {kind === "working" && <StateMark kind="live" size={14} />}
      {kind === "done" && <StateMark kind="done" size={14} />}
      {kind === "idle" && <StateMark kind="idle" size={14} />}
    </span>
  );
}

export const KeyboardGlyph = () => <KitIcon name="keyboard" className="ts-icon" />;
export const ExpandGlyph = () => (
  <Glyph><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></Glyph>
);
export const CollapseGlyph = () => (
  <Glyph><path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14" /></Glyph>
);
export const CloseGlyph = () => <KitIcon name="close" className="ts-icon" />;
export const BackGlyph = () => <KitIcon name="chevron-left" className="ts-icon" />;
export const CopyGlyph = () => <KitIcon name="copy" className="ts-icon" />;
