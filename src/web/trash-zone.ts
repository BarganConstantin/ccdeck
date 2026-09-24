export interface ClientPoint { clientX: number; clientY: number }
export interface ClientRectBounds { left: number; right: number; top: number; bottom: number }

/** Whether the pointer release landed inside the viewport-fixed trash target. */
export function pointInRect(point: ClientPoint, rect: ClientRectBounds): boolean {
  return point.clientX >= rect.left
    && point.clientX <= rect.right
    && point.clientY >= rect.top
    && point.clientY <= rect.bottom;
}
