import React from "react";

// The small glyphs the git view's file list and diff draw, on the 14px grid
// the branch chip's glyphs use. Every one is decoration beside a word or an
// accessible name, so every one is hidden from a screen reader.

function Glyph({ children, width = 1.4, size = 13 }: { children: React.ReactNode; width?: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={width}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Two arrows meeting at a bar: two agents on one file. Never an ×, which
 *  would read as "close". */
export function ClashGlyph({ size = 12 }: { size?: number }) {
  return <Glyph width={1.5} size={size}><path d="M7 2.6v8.8M1.4 7h3.4M3.4 5 5.2 7 3.4 9M12.6 7H9.2M10.6 5 8.8 7l1.8 2" /></Glyph>;
}

export function CopyGlyph() {
  return <Glyph><rect x="4.8" y="4.8" width="6.8" height="6.8" rx="1.3" /><path d="M9.2 4.8V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v4.7a1 1 0 0 0 1 1h1.3" /></Glyph>;
}

export function CheckGlyph() {
  return <Glyph><path d="m3 7.4 2.6 2.6L11 4.4" /></Glyph>;
}

export function ChevronGlyph({ size = 11 }: { size?: number }) {
  return <Glyph size={size}><path d="M5.2 3.4 8.8 7l-3.6 3.6" /></Glyph>;
}

export function InfoGlyph({ size = 12 }: { size?: number }) {
  return <Glyph size={size}><circle cx="7" cy="7" r="5.2" /><path d="M7 6.3v3.4M7 4.4v.1" /></Glyph>;
}

export function WrapGlyph() {
  return <Glyph><path d="M2.2 3.6h9.6M2.2 7h8a2 2 0 0 1 0 4H7.4M8.8 9.6 7.4 11l1.4 1.4M2.2 10.4h3" /></Glyph>;
}

/** Code brackets: open the file in the editor. */
export function EditorGlyph() {
  return <Glyph><path d="M4.6 4 2 7l2.6 3M9.4 4 12 7l-2.6 3" /></Glyph>;
}

/** A turning arrow: read the diff again. */
export function ReloadGlyph() {
  return <Glyph><path d="M11.4 7a4.4 4.4 0 1 1-1.3-3.1M11.4 2.6v2.9H8.5" /></Glyph>;
}
