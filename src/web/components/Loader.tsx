import { useEffect, useState, type CSSProperties } from "react";
import { useWaitingLoader } from "../use-waiting-loader";

/* V4's Work / Loader (V4's Figma kit): a grid of pixels that breathes in a
   diagonal wave. Use it where the app is waiting on data and has only words to
   say so, beside those words (they carry the role="status"). Never use it for
   an agent working: that is the Working ring, and the two are not swapped. */
const PIXELS = { s: 3, m: 5 } as const;

export function Loader({ size = "s", pace, timed, leaving, idle }: { size?: "s" | "m"; pace?: "person"; timed?: boolean; leaving?: boolean; idle?: boolean }) {
  // The hidden window stops the wave, as SessionUsageLoading does.
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const n = PIXELS[size];
  return <span className="loader" data-size={size === "m" ? "m" : undefined} data-pace={pace} data-paused={hidden || undefined} data-timed={timed || undefined} data-leaving={leaving || undefined} data-idle={idle || undefined} aria-hidden="true">
    {Array.from({ length: n * n }, (_, k) => <i key={k} style={{ "--d": Math.floor(k / n) + (k % n) } as CSSProperties} />)}
  </span>;
}

/** The Loader for a wait that is `busy`, on V4's timing (use-waiting-loader.ts):
 *  nothing under 150 ms, a Fast fade in, at least 300 ms on screen, then a fade
 *  out. Always mounted by the caller; it holds its slot unseen until the wait is long enough to show. */
export function WaitingLoader({ busy, size, pace }: { busy: boolean; size?: "s" | "m"; pace?: "person" }) {
  const { draw, leaving } = useWaitingLoader(busy);
  // Before the first draw the grid holds its slot unseen, so the words beside
  // it do not move when it arrives.
  return <Loader size={size} pace={pace} timed leaving={leaving} idle={!draw} />;
}

export default Loader;
