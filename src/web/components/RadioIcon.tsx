export type RadioIconName = "radio" | "play" | "pause" | "shuffle" | "heart" | "close" | "search" | "globe" | "back" | "previous" | "next" | "volume" | "muted";
const paths: Record<RadioIconName, string> = {
  radio: "M4 8h16v12H4z M7 8l10-5 M7 12h5 M15 12h2 M7 16h2 M13 16h4",
  play: "M8 5l11 7-11 7z",
  pause: "M8 5v14 M16 5v14",
  shuffle: "M3 6h3c5 0 7 12 12 12h3 M17 14l4 4-4 4 M3 18h3c2 0 4-3 6-6s4-6 6-6h3 M17 2l4 4-4 4",
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z",
  close: "M6 6l12 12 M6 18L18 6",
  search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15 M16 16l5 5",
  globe: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20 M2 12h20 M12 2c-6 6-6 14 0 20 M12 2c6 6 6 14 0 20",
  back: "M16 5l-7 7 7 7",
  previous: "M5 5v14 M19 5l-10 7 10 7z",
  next: "M19 5v14 M5 5l10 7-10 7z",
  volume: "M11 4L6 8H3v8h3l5 4z M15 8a6 6 0 0 1 0 8 M18 5a10 10 0 0 1 0 14",
  muted: "M11 4L6 8H3v8h3l5 4z M16 9l6 6 M16 15l6-6",
};
export default function RadioIcon({ name }: { name: RadioIconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
