// A tracker's large modal, loaded the first time one opens (#883's way, as
// Usage history, Browser Watch and Telemetry Radar are): the modal and every
// provider's panel (integrations/panels.tsx) are one chunk the page does not
// carry. A deck that offers no integration, or never opens one, never fetches
// it; a deck with one to show fetches it as soon as the rail draws its control
// (preloadIntegrationModal, from App), so the first press finds it there and
// nothing is drawn in its place, as nothing is for the other three while
// theirs arrives. A chunk that does not arrive fails as this dialog alone,
// named for its tracker, with the reload that fixes it (LazyDialog.tsx).
//
// Escape, though, reaches it while it arrives: the press opened a dialog, so
// Escape closes it, as it would once drawn, rather than going on to the canvas
// while the dialog opens seconds later anyway. The other three are left as
// lazyDialog has them.
import { Suspense, useEffect } from "react";
import { integrationDef } from "../integrations/registry";
import { modalStack } from "../modal-dismiss";
import type { IntegrationModalProps } from "./IntegrationModal";
import { lazyDialog } from "./LazyDialog";

const loadIntegrationModal = () => import("./IntegrationModal");

/** Fetch the chunk now, ahead of the first press. Repeated calls share one
 *  fetch; a failure here is left for the press to show. */
export function preloadIntegrationModal(): void {
  void loadIntegrationModal().catch(() => {});
}

export const LazyIntegrationModal = lazyDialog(loadIntegrationModal, (props: IntegrationModalProps) => integrationDef(props.kind)?.label ?? "The tracker");

/** What stands in while the chunk arrives: nothing drawn, and the dialog's
 *  place on modalStack, held until the modal takes it or the dialog closes. */
function Opening({ onClose }: { onClose: () => void }) {
  useEffect(() => modalStack.push(onClose, 0, "dialog"), [onClose]);
  return null;
}

export default function IntegrationModalOnDemand(props: IntegrationModalProps) {
  return (
    <Suspense fallback={<Opening onClose={props.onClose} />}>
      <LazyIntegrationModal {...props} />
    </Suspense>
  );
}
