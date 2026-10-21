// A tracker's large modal, loaded the first time one opens (#883's way, as
// Usage history, Browser Watch and Telemetry Radar are): the modal and every
// provider's panel (integrations/panels.tsx) are one chunk the page does not
// carry. A deck that offers no integration, or never opens one, never fetches
// it; a deck with one to show fetches it as soon as the rail draws its control
// (preloadIntegrationModal, from App), so the first press finds it there and
// nothing is drawn in its place, as nothing is for the other three while
// theirs arrives. A chunk that does not arrive fails as this dialog alone,
// named for its tracker, with the reload that fixes it (LazyDialog.tsx).
import { Suspense } from "react";
import { integrationDef } from "../integrations/registry";
import type { IntegrationModalProps } from "./IntegrationModal";
import { lazyDialog } from "./LazyDialog";

const loadIntegrationModal = () => import("./IntegrationModal");

/** Fetch the chunk now, ahead of the first press. Repeated calls share one
 *  fetch; a failure here is left for the press to show. */
export function preloadIntegrationModal(): void {
  void loadIntegrationModal().catch(() => {});
}

export const LazyIntegrationModal = lazyDialog(loadIntegrationModal, (props: IntegrationModalProps) => integrationDef(props.kind)?.label ?? "The tracker");

export default function IntegrationModalOnDemand(props: IntegrationModalProps) {
  return (
    <Suspense fallback={null}>
      <LazyIntegrationModal {...props} />
    </Suspense>
  );
}
