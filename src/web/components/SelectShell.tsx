// The deck's one Select (V4's Forms / Select): a closed box 28 high with the
// chosen option's name and a 12px chevron, in the kit's fill and edge.
//
// The list itself stays the platform's own. A native <select> arrives with
// everything a hand-built list would have to rebuild and would still do worse:
// Up/Down, Home/End, Enter, Esc and type-ahead, a screen reader that already
// announces a list of options, and the OS picker on a touch screen. So this is
// the box and the chevron around the native element, which is drawn with
// `appearance: none` (menus.css, `.v4-select`) and sizes itself to its longest
// option, not to a fixed width.
//
// The element inside carries its own props, its own id and its own label, so
// each place that has a select keeps its value, its options and its handler.
import type { ReactNode } from "react";

export function SelectChevron() {
  return (
    <svg className="v4-select-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="m3 4.5 3 3 3-3" />
    </svg>
  );
}

export default function SelectShell({ children }: { children: ReactNode }) {
  return <span className="v4-select">{children}<SelectChevron /></span>;
}
