export type RadioIconName = "radio" | "play" | "pause" | "shuffle" | "heart" | "close" | "search" | "globe" | "back" | "previous" | "next" | "volume" | "muted" | "headphones" | "book" | "gamepad" | "sunset" | "moon" | "cassette" | "palm" | "coffee" | "check";
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
  headphones: "M4 14v-3a8 8 0 0 1 16 0v3 M4 12h3v8H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 1-2 M20 12h-3v8h2a2 2 0 0 0 2-2v-4a2 2 0 0 0-1-2",
  book: "M12 6v15 M12 6C9 4 6 3 3 4v15c3-1 6 0 9 2 3-2 6-3 9-2V4c-3-1-6 0-9 2",
  gamepad: "M8 7h8c3 0 4 2 5 8 1 5-2 6-5 2H8c-3 4-6 3-5-2 1-6 2-8 5-8z M6 11h4 M8 9v4 M16 10h.01 M18 13h.01",
  sunset: "M3 17h18 M5 21h14 M7 17a5 5 0 0 1 10 0 M12 3v3 M4 8l2 2 M20 8l-2 2",
  moon: "M20 14A9 9 0 0 1 10 3a9 9 0 1 0 10 11z",
  cassette: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M7 8h10v5H7z M7 20l2-4h6l2 4 M9 10.5h.01 M15 10.5h.01",
  palm: "M12 8c2 4 3 8 2 13 M12 8C8 3 4 4 2 8c4-1 7-1 10 0 M12 8c1-6 6-7 10-2-4-1-7 0-10 2 M12 8c-5 0-7 3-7 7 2-3 4-5 7-7 M12 8c4 0 7 3 7 7-2-3-4-5-7-7 M10 21h8",
  coffee: "M4 8h12v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z M16 9h2a3 3 0 0 1 0 6h-2 M7 3v2 M11 3v2 M3 22h15",
  check: "M5 12l4 4L19 6",
};
export default function RadioIcon({ name }: { name: RadioIconName }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
