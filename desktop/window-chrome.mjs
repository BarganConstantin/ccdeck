// Keep native caption buttons; only their surrounding chrome belongs to ccdeck.
export const TITLEBAR_HEIGHT = 34;
export function windowChrome(platform) {
  return {
    titleBarStyle: "hidden",
    ...(platform === "darwin"
      ? { trafficLightPosition: { x: 12, y: 10 } }
      : { titleBarOverlay: { color: "#191a1c", symbolColor: "#d4d4d4", height: TITLEBAR_HEIGHT }, autoHideMenuBar: true }),
  };
}

// Only opaque CSS colours cross the bridge, never arbitrary native options.
export function titlebarColors(value) {
  if (!value || typeof value !== "object") return null;
  const color = /^#[0-9a-f]{6}$/i;
  return typeof value.color === "string" && typeof value.symbolColor === "string"
    && color.test(value.color) && color.test(value.symbolColor)
    ? { color: value.color, symbolColor: value.symbolColor, height: TITLEBAR_HEIGHT }
    : null;
}
