// V4 motion: "Opened by a key, or closed with Esc: no motion". The last input
// decides: any key sets data-motion="instant" on the root (dialogs.css and
// quick-open.css turn the dialog animations off under it), any pointer press
// clears it. Both listeners run in the capture phase, before the handler that
// opens or closes a dialog, so the flag is already right when that dialog mounts.

let installed: (() => void) | null = null;

/** Starts tracking the last input. Safe to call twice; returns the remover. */
export function installInputModality(doc: Document = document): () => void {
  if (installed) return installed;
  const root = doc.documentElement;
  const onKey = () => { root.dataset.motion = "instant"; };
  const onPointer = () => { delete root.dataset.motion; };
  doc.addEventListener("keydown", onKey, { capture: true, passive: true });
  doc.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  installed = () => {
    doc.removeEventListener("keydown", onKey, { capture: true });
    doc.removeEventListener("pointerdown", onPointer, { capture: true });
    delete root.dataset.motion;
    installed = null;
  };
  return installed;
}
