// The stage's glyphs: one stroke weight, drawn in currentColor, and hidden
// from assistive technology — every control that carries one is named in
// words, by its aria-label, so the picture is never the only way to know.
//
// Kept here rather than inline in each component because the header, the
// state cards and the New session popover share several of them, and two
// copies of one path are two drawings that drift.
import type { ReactNode } from "react";
import type { TerminalProvider } from "../../terminal-api";

function Glyph({ size = 16, box = 16, children }: { size?: number; box?: number; children: ReactNode }) {
  return (
    <svg className="ts-icon" width={size} height={size} viewBox={`0 0 ${box} ${box}`} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** The provider, inside the model chip and on the popover's agent switch. */
export function ProviderGlyph({ provider, size = 10 }: { provider: TerminalProvider; size?: number }) {
  return provider === "codex"
    ? <Glyph size={size} box={12}><path d="M2 3.5 4.5 6 2 8.5M6 9h4" /></Glyph>
    : <Glyph size={size} box={12}><path d="M6 1.5v9M1.5 6h9M2.8 2.8l6.4 6.4M9.2 2.8 2.8 9.2" /></Glyph>;
}

export const KeyboardGlyph = () => (
  <Glyph><rect x="1.75" y="4" width="12.5" height="8" rx="1.5" /><path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M12 6.5h.01M5 9.5h6" /></Glyph>
);
export const ExpandGlyph = () => (
  <Glyph><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" /></Glyph>
);
export const CollapseGlyph = () => (
  <Glyph><path d="M13.5 6.5h-4v-4M9.5 6.5 14 2M2.5 9.5h4v4M6.5 9.5 2 14" /></Glyph>
);
export const CloseGlyph = () => <Glyph><path d="M4 4l8 8M12 4l-8 8" /></Glyph>;
export const BackGlyph = () => <Glyph><path d="M9.75 3.5 5.25 8l4.5 4.5" /></Glyph>;
export const PlusGlyph = () => <Glyph><path d="M8 3v10M3 8h10" /></Glyph>;
export const CopyGlyph = () => (
  <Glyph><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></Glyph>
);
export const ChevronGlyph = () => <Glyph size={12} box={12}><path d="M4.5 2.5 8 6l-3.5 3.5" /></Glyph>;
export const TerminalGlyph = () => (
  <Glyph size={28} box={28}><rect x="2.5" y="5" width="23" height="18" rx="3" /><path d="M8 11l3.5 3L8 17M14 17.5h6" /></Glyph>
);
