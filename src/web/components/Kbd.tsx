// V4's key cap (`Kbd`), for the chrome that is not the terminal stage. The
// stage's own cap (.ts-kbd, in KeysBar) stays as it is; this one is the shape
// the status bar draws, and the first-load home for any later bar that names a
// key.
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
