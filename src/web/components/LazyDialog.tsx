// A dialog that loads when it opens (#883), and fails as that dialog when its
// chunk does not arrive.
//
// The usual reason it does not: the deck upgraded under an open tab. `npm i -g`
// rewrites dist/web while the process waits for its idle restart, so a tab
// still running the old bundle asks for a chunk name the new build no longer
// has. React.lazy rethrows the failed import while rendering, and the only
// boundary above these two is the one round the whole deck — so opening Usage
// history used to swap the canvas, the panels and the topbar for the crash pane
// and file a crash report about nothing broken. Caught here instead, the dialog
// opens as a short note with the reload that fixes it, and Close leaves the
// deck as it was.
//
// Not forwarded as a crash: a missing chunk is the tab being older than the
// deck, which a reload clears and nobody has to hear about.
import { lazy, useRef, type ComponentType } from "react";
import { useModalDismiss } from "./use-modal-dismiss";

interface Closable {
  onClose: () => void;
}

/** React.lazy over `load`, settling on a note naming `name` when the import
 *  fails, rather than on the error. */
export function lazyDialog<P extends Closable>(
  load: () => Promise<{ default: ComponentType<P> }>,
  name: string,
) {
  return lazy(() =>
    load().catch((err: unknown) => {
      console.warn(`ccdeck could not load ${name}`, err);
      return { default: ({ onClose }: P) => <DialogDidNotLoad name={name} onClose={onClose} /> };
    }),
  );
}

export function DialogDidNotLoad({ name, onClose }: { name: string; onClose: () => void }) {
  const reloadRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(onClose, { focusRef: reloadRef });
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal dialog-missing"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-missing-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            <span id="dialog-missing-title" className="modal-tool-name">{name}</span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>
        <section className="modal-body">
          <p className="dm-note">
            {name} did not load. The deck has most likely been updated since this tab opened, and a
            reload picks up the new version.
          </p>
          <div className="dm-actions">
            <button type="button" className="btn" onClick={onClose}>Close</button>
            <button type="button" ref={reloadRef} className="btn primary" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </section>
      </div>
    </div>
  );
}
