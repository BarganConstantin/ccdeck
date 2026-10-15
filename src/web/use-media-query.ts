import { useEffect, useState } from "react";

/** Whether a media query matches, kept current as the window changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const sync = () => setMatches(list.matches);
    sync();
    list.addEventListener("change", sync);
    return () => list.removeEventListener("change", sync);
  }, [query]);
  return matches;
}
