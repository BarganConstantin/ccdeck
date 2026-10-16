import { readStored } from "./storage";

export const TEXT_SIZE_KEY = "agent-dag.text-size";
export const DENSITY_KEY = "agent-dag.density";
export const TEXT_SIZES = ["smallest", "smaller", "default", "larger", "largest"] as const;
export const DENSITIES = ["tightest", "tighter", "compact", "default", "comfortable"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export type Density = (typeof DENSITIES)[number];

/** What each text size adds to every size in the sheet — the
 *  `--ui-text-increase` styles/reading.css sets for it, which a test holds to
 *  this table. Script that reasons about type on screen reads it here. */
export const TEXT_SIZE_INCREASE: Record<TextSize, number> = { smallest: -2, smaller: -1, default: 0, larger: 2, largest: 4 };

/** The text size the page is drawn at now, from the attribute the boot script
 *  and useAppearance keep on the root. */
export function currentTextSize(): TextSize {
  return resolveTextSize(typeof document === "undefined" ? null : document.documentElement?.dataset?.textSize);
}

export function resolveTextSize(value: string | null | undefined): TextSize {
  return value === "smallest" || value === "smaller" || value === "larger" || value === "largest" ? value : "default";
}
export function resolveDensity(value: string | null | undefined): Density {
  return value === "tightest" || value === "tighter" || value === "compact" || value === "comfortable" ? value : "default";
}
export const storedTextSize = () => resolveTextSize(readStored(TEXT_SIZE_KEY));
export const storedDensity = () => resolveDensity(readStored(DENSITY_KEY));
