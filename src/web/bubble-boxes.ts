// The tool bubbles' boxes, in world space, from the layer that draws them
// (ToolBursts.tsx) to the minimap, which keeps off them (minimap-place.ts).
// The bubbles are not React Flow nodes, so its store does not hold them, and
// laying them out a second time for the minimap would double the walk
// ToolBursts takes care to run once per data change. One canvas, one list:
// only the minimap listens, so a change re-renders nothing else.
import { useEffect, useSyncExternalStore } from "react";
import { burstBox, type Burst } from "./burst-layout";
import type { WorldRect } from "./minimap-place";

const NONE: readonly WorldRect[] = [];
let boxes: readonly WorldRect[] = NONE;
const listeners = new Set<() => void>();

const sameBoxes = (a: readonly WorldRect[], b: readonly WorldRect[]) => a.length === b.length
  && a.every((r, i) => r.left === b[i].left && r.top === b[i].top && r.right === b[i].right && r.bottom === b[i].bottom);

/** Hand the minimap the boxes drawn now. The same boxes again tell nobody. */
export function publishBubbleBoxes(next: readonly WorldRect[]): void {
  if (sameBoxes(boxes, next)) return;
  boxes = next.length ? next : NONE;
  for (const heard of listeners) heard();
}

function subscribe(heard: () => void): () => void {
  listeners.add(heard);
  return () => { listeners.delete(heard); };
}
const current = () => boxes;

/** The bubbles' boxes, read again whenever they change. */
export function useBubbleBoxes(): readonly WorldRect[] {
  return useSyncExternalStore(subscribe, current, current);
}

/** ToolBursts' half: the boxes of the bubbles it drew, after each render, and
 *  none once the layer is gone. */
export function usePublishBubbleBoxes(bursts: readonly Burst[]): void {
  useEffect(() => { publishBubbleBoxes(bursts.map(burstBox)); });
  useEffect(() => () => publishBubbleBoxes(NONE), []);
}
