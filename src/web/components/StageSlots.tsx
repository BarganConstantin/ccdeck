// Where the terminal stage's two pieces go in App's markup, and the React.lazy
// door to them: the navigator inside <main>, the stage after it.
//
// IN THE FIRST-LOAD CHUNK; WHAT THEY RENDER IS NOT. Each slot is a few lines
// that draw nothing at all unless the terminal flag is on and the stage is
// open, and what they do draw comes from components/terminal/StageShell.tsx
// through use-stage.ts's loadStageShell — one dynamic import both slots share,
// so the navigator and the stage are one chunk and arrive together. The flag
// off, neither slot ever asks for it (DESIGN-UI decision 9; notices-bundle's
// dist case holds the entry chunk to having no xterm in it).
//
// A STALE TAB. After an upgrade, a page that was open across it asks for a
// chunk the new build no longer has. LazyDialog answers that for a dialog with
// a note in a modal; a stage is not a dialog, so its answer is to close and
// say why through the stage's own live region (use-stage.ts failed()).
import { lazy, Suspense, useEffect } from "react";
import { loadStageShell } from "../use-stage";
import type { StageDockProps, StageNavigatorProps } from "./terminal/StageShell";

function NavigatorUnavailable(_: StageNavigatorProps) {
  return null;
}

function DockUnavailable({ stage }: StageDockProps) {
  const { failed } = stage;
  useEffect(() => { failed(); }, [failed]);
  return null;
}

const LazyNavigator = lazy(() => loadStageShell().then(
  m => ({ default: m.StageNavigator }),
  () => ({ default: NavigatorUnavailable }),
));
const LazyDock = lazy(() => loadStageShell().then(
  m => ({ default: m.StageDock }),
  () => ({ default: DockUnavailable }),
));

/** The navigator, in the canvas: nothing unless the stage is open. */
export function StageNavigatorSlot(p: StageNavigatorProps) {
  if (!p.stage.enabled || p.stage.shell.phase === "closed") return null;
  return (
    <Suspense fallback={null}>
      <LazyNavigator {...p} />
    </Suspense>
  );
}

/** The stage, beside the board: nothing unless it is open. */
export function StageDockSlot(p: StageDockProps) {
  if (!p.stage.enabled || p.stage.shell.phase === "closed") return null;
  return (
    <Suspense fallback={null}>
      <LazyDock {...p} />
    </Suspense>
  );
}
