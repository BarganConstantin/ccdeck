import type { SelectHTMLAttributes } from "react";

/** A native select with Radar's geometry; browser keyboard and option behavior remain intact. */
export function RadarSelect({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className="tr-select-wrap">
    <select {...props} className={`tr-select${className ? ` ${className}` : ""}`}>{children}</select>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
  </span>;
}
