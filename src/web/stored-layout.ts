// The persisted canvas arrangement, and the one derivation the deck makes from
// it on mount. Kept out of App.tsx — the way minimap.ts is — so the derivation
// can be tested without React, React Flow or a DOM.
//
// Reading the value is still App.tsx's job: it owns the storage key, the v1
// migration and the debounced write. What lives here is the pure half, which is
// also the half that was quadratic.

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
