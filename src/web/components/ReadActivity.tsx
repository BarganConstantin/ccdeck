import { useEffect, useState } from "react";

/** Indeterminate local reads. Artwork is decorative, never provisional data. */
export default function ReadActivity({ kind, title, note, delayed = false }: {
  kind: "quota" | "processes" | "history"; title: string; note?: string; delayed?: boolean;
}) {
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  useEffect(() => {
    const changed = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return <div className={`read-activity read-activity-${kind}`} role="status" aria-label={title} data-paused={hidden || undefined} data-delayed={delayed || undefined}>
    <svg className="read-activity-art" viewBox="0 0 180 100" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "quota" ? <>
        <path d="M36 26a23 23 0 1 1-3 28M34 20v14h14" /><path d="M56 33v14l8 5" />
        <rect x="104" y="20" width="40" height="58" rx="4" /><path d="M113 32h22M113 42h22M113 52h15M82 47h15" />
        <circle className="read-activity-mark" cx="80" cy="47" r="2" />
      </> : kind === "processes" ? <>
        <rect x="34" y="18" width="112" height="64" rx="5" /><path d="M34 33h112M43 25h2M51 25h2M59 25h2M49 46h24M49 57h36M49 68h28M113 46h17M113 57h17M113 68h17" />
        <path className="read-activity-mark" d="M49 43h24" />
      </> : <>
        <rect x="37" y="18" width="107" height="64" rx="5" />
        <circle cx="65" cy="48" r="17" /><path d="M65 38v11l7 4M98 35h32M98 47h25M98 59h30" />
        <path className="read-activity-mark" d="M98 32h25" />
      </>}
    </svg>
    <strong>{title}</strong>
    {note && <span>{note}</span>}
  </div>;
}
