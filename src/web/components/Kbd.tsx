// V4's key cap (`Kbd`): the shape the status bar draws, and the home for any
// bar that names a key. The terminal stage's keys bar draws it too (KeysBar;
// its own cap, .ts-kbd, left with V4's Term pane), at 16 tall rather than 18.
//
// A symbol or a chord gets its spoken words beside it, hidden from the eye, and
// the printed glyph goes out of the accessibility tree: an aria-label on a bare
// <kbd> (a generic element) is one screen readers are allowed to ignore.
export function Kbd({ children, label }: { children: string; label?: string }) {
  if (!label) return <kbd className="kbd">{children}</kbd>;
  return (
    <>
      <kbd className="kbd" aria-hidden>{children}</kbd>
      <span className="kbd-spoken">{label}</span>
    </>
  );
}
