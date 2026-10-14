import { readStored } from "./storage";

export const TEXT_SIZE_KEY = "agent-dag.text-size";
export const DENSITY_KEY = "agent-dag.density";
export const TEXT_SIZES = ["smallest", "smaller", "default", "larger", "largest"] as const;
export const DENSITIES = ["compact", "default", "comfortable"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export type Density = (typeof DENSITIES)[number];

export function resolveTextSize(value: string | null | undefined): TextSize {
  return value === "smallest" || value === "smaller" || value === "larger" || value === "largest" ? value : "default";
}
export function resolveDensity(value: string | null | undefined): Density {
  return value === "compact" || value === "comfortable" ? value : "default";
}
export const storedTextSize = () => resolveTextSize(readStored(TEXT_SIZE_KEY));
export const storedDensity = () => resolveDensity(readStored(DENSITY_KEY));
