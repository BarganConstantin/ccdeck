import { useEffect, useState } from "react";

/** Reading activity only; the folders are decorative, not report rows. */
export default function AccountProjectsLoading() {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return <div className="ap-proj-loading" role="status" aria-label="Reading project activity" data-paused={hidden || undefined}>
    <svg className="ap-proj-loading-art" viewBox="0 0 240 112" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="100" y="8" width="40" height="43" rx="4" />
      <path d="M108 21h24M108 29h18M108 37h21" />
      <path className="ap-proj-loading-scan" d="M108 21h24" />
      <path className="ap-proj-loading-links" d="M120 51v15M51 76V66h138v10M120 66v10" />
      <path d="M30 83v-7h14l6 7h22v23H30zM99 83v-7h14l6 7h22v23H99zM168 83v-7h14l6 7h22v23h-42z" />
    </svg>
    <strong>Reading project activity</strong>
    <span>Gathering this account’s work by project…</span>
  </div>;
}
