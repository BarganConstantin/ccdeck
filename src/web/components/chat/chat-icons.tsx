// The glyphs Chat and the Decision card draw that the deck did not have: a
// lock, a changed question, and the marks a tool row wears. Stroke only, in
// currentColor, hidden from assistive technology (every one sits beside words
// that say what it says), and drawn like the glyphs of action-glyphs.tsx. The
// logo is never drawn here.
import type { ReactNode } from "react";

function Svg({ size = 14, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      {children}
    </svg>
  );
}

/** A changed rule or mode: only in the terminal. */
export const LockGlyph = ({ size = 12 }: { size?: number }) => (
  <Svg size={size}><rect x="2.75" y="6.25" width="8.5" height="5.5" rx="1.25" /><path d="M4.75 6.25v-1.5a2.25 2.25 0 0 1 4.5 0v1.5" /></Svg>
);

/** The question changed under the answer. */
export const ChangedGlyph = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}><path d="M2.5 5h8.5M8.75 2.75 11 5 8.75 7.25M11.5 9H3M5.25 6.75 3 9l2.25 2.25" /></Svg>
);

export const ChevronRightGlyph = () => <Svg size={14}><path d="M5 3l4 4-4 4" /></Svg>;
export const FileGlyph = () => <Svg><path d="M3.75 1.75h4.5l2.5 2.5v7a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1z" /><path d="M8 1.75v2.5h2.75" /></Svg>;
export const SearchGlyph = () => <Svg><circle cx="6" cy="6" r="3.75" /><path d="M9 9l3 3" /></Svg>;
export const ToolTerminalGlyph = () => <Svg><rect x="1.75" y="2.75" width="10.5" height="8.5" rx="1.5" /><path d="M4 5.5l2 1.5-2 1.5M7.5 8.75h2.25" /></Svg>;
