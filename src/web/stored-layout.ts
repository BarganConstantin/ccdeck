// The persisted canvas arrangement, and the one derivation the deck makes from
// it on mount. Kept out of App.tsx — the way minimap.ts is — so the derivation
// can be tested without React, React Flow or a DOM.
//
// Reading and writing the value is still App.tsx's job: it owns the storage
// keys and the debounced write. What lives here is the pure half — the stored
// format, its v1 migration, the save merge and the stored frame's check (#1174)
// — which is also the half that was quadratic.
import type { Frame } from "./layout";

/**
 * Where every node sits, and which of those the user placed by hand.
 *
 * Only drags used to be stored, so a reload re-ran dagre over everything and
 * the canvas came back rearranged — the arrangement you spent time reading is
 * not something you should have to rebuild because you hit refresh. Auto
 * positions are saved too, and `pins` records which were deliberate so a drag
 * still outranks the layout pass.
 */
export interface StoredLayout {
  positions: Array<[string, { x: number; y: number }]>;
  pins: string[];
}

export interface RestoredLayout {
  /** Every stored position, pinned or not — what the layout pass starts from. */
  positions: Map<string, { x: number; y: number }>;
  /** Just the deliberate ones, which outrank anything dagre would compute. */
  pinned: Map<string, { x: number; y: number }>;
}

/**
 * Split a stored arrangement into the two maps the canvas holds on to.
 *
 * `pins` is turned into a Set first, and that is the whole of the fix in #612.
 * The pinned map used to be built with
 * `positions.filter(([id]) => pins.includes(id))`, and `includes` is a linear
 * scan — so restoring a board cost `positions × pins` string comparisons. That
 * is quadratic precisely in the size of a board someone spent time arranging,
 * which is the only kind of board that has anything to restore. Reading `pins`
 * once into a Set makes the whole derivation a single pass over each input.
 *
 * (It ran on every render as well, because it was seeded as a `useRef`
 * argument. That half is fixed at the call site — this function is called from
 * a `useState` initialiser now — but the cost being linear matters even once.)
 */
export function restoreLayout(stored: StoredLayout): RestoredLayout {
  const pins = new Set(stored.pins);
  const positions = new Map<string, { x: number; y: number }>();
  const pinned = new Map<string, { x: number; y: number }>();
  for (const [id, at] of stored.positions) {
    positions.set(id, at);
    if (pins.has(id)) pinned.set(id, at);
  }
  return { positions, pinned };
}

type Point = { x: number; y: number };

/** The entries of a stored id → point map that are points. Anything else — a
 *  string coordinate, a null, a missing y — is dropped rather than handed to
 *  the canvas, which would place a card at NaN. */
function pointsOf(map: unknown): Array<[string, Point]> {
  return Object.entries((map ?? {}) as Record<string, Point>)
    .filter(([, v]) => v && typeof v.x === "number" && typeof v.y === "number");
}

/**
 * The stored layout string as a {@link StoredLayout}, or an empty one when
 * there is nothing usable — absent, not JSON, or not an object.
 *
 * Two formats are in the wild. v1 stored a bare id → point map of drags only,
 * and it is read as all-pinned so an upgrade keeps whatever the user had
 * arranged. v2 is `{ v: 2, positions, pins }`, written by
 * {@link serializeLayout}.
 */
export function parseStoredLayout(raw: string | null): StoredLayout {
  const empty: StoredLayout = { positions: [], pins: [] };
  if (!raw) return empty;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return empty; }
  if (!obj || typeof obj !== "object") return empty;
  if (!("v" in obj)) {
    const entries = pointsOf(obj);
    return { positions: entries, pins: entries.map(([id]) => id) };
  }
  const v2 = obj as { positions?: unknown; pins?: unknown };
  return { positions: pointsOf(v2.positions), pins: Array.isArray(v2.pins) ? v2.pins : [] };
}

/**
 * The v2 string for the canvas's two maps. Pinned positions are written after
 * the auto ones, so where both hold an id the drag wins over the layout.
 */
export function serializeLayout(positions: Map<string, Point>, pinned: Map<string, Point>): string {
  const obj: Record<string, Point> = {};
  for (const [id, pos] of positions) obj[id] = pos;
  for (const [id, pos] of pinned) obj[id] = pos;   // a drag wins over the layout
  return JSON.stringify({ v: 2, positions: obj, pins: Array.from(pinned.keys()) });
}

/**
 * The stored frame string as a {@link Frame}, or null. Only a positive numeric
 * width and height count: a frame of zero is "not measured yet", and the
 * reframe effect compares nothing against a null (#995).
 */
export function parseLayoutFrame(raw: string | null): Frame | null {
  if (!raw) return null;
  let f: { width?: unknown; height?: unknown } | null;
  try { f = JSON.parse(raw); } catch { return null; }
  if (!(typeof f?.width === "number" && typeof f?.height === "number")) return null;
  if (!(f.width > 0 && f.height > 0)) return null;
  return { width: f.width, height: f.height };
}
