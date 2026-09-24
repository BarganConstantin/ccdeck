export interface ClientPoint { clientX: number; clientY: number }
export interface ClientRectBounds { left: number; right: number; top: number; bottom: number }
export type TrashProximity = "far" | "near" | "over";

/** Extra reach around the visible target, so a release on its edge still counts. */
export const TRASH_HIT_SLOP_PX = 16;
/** How close the pointer comes before the target leans in to meet it. */
export const TRASH_NEAR_PX = 120;

/** Whether the point lies inside the rectangle, grown by `slop` on every side. */
export function pointInRect(point: ClientPoint, rect: ClientRectBounds, slop = 0): boolean {
  return point.clientX >= rect.left - slop
    && point.clientX <= rect.right + slop
    && point.clientY >= rect.top - slop
    && point.clientY <= rect.bottom + slop;
}

/** The pointer's distance to the nearest edge of the rectangle; zero inside it. */
export function distanceToRect(point: ClientPoint, rect: ClientRectBounds): number {
  const dx = Math.max(rect.left - point.clientX, 0, point.clientX - rect.right);
  const dy = Math.max(rect.top - point.clientY, 0, point.clientY - rect.bottom);
  return Math.hypot(dx, dy);
}

export function trashProximity(point: ClientPoint, rect: ClientRectBounds): TrashProximity {
  if (pointInRect(point, rect, TRASH_HIT_SLOP_PX)) return "over";
  return distanceToRect(point, rect) <= TRASH_NEAR_PX ? "near" : "far";
}

type DragEventLike = Partial<ClientPoint> & {
  changedTouches?: ArrayLike<ClientPoint>;
  touches?: ArrayLike<ClientPoint>;
};

/** Where a mouse or touch drag event happened; a touch release carries its
 *  point only in `changedTouches`. */
export function clientPointOf(event: DragEventLike): ClientPoint | null {
  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    return { clientX: event.clientX, clientY: event.clientY };
  }
  const touch = event.changedTouches?.[0] ?? event.touches?.[0];
  return touch ? { clientX: touch.clientX, clientY: touch.clientY } : null;
}
