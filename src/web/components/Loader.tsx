import { useEffect, useState, type CSSProperties } from "react";

/* V4's Work / Loader (V4's Figma kit): a grid of pixels that breathes in a
   diagonal wave. Use it where the app is waiting on data and has only words to
   say so, beside those words (they carry the role="status"). Never use it for
   an agent working: that is the Working ring, and the two are not swapped. */
const PIXELS = { s: 3, m: 5 } as const;

export function Loader({ size = "s", pace }: { size?: "s" | "m"; pace?: "person" }) {
  // The hidden window stops the wave, as SessionUsageLoading does.
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const n = PIXELS[size];
  return <span className="loader" data-size={size === "m" ? "m" : undefined} data-pace={pace} data-paused={hidden || undefined} aria-hidden="true">
    {Array.from({ length: n * n }, (_, k) => <i key={k} style={{ "--d": Math.floor(k / n) + (k % n) } as CSSProperties} />)}
  </span>;
}

export default Loader;
