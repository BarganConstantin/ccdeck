import type { ReactNode, SVGProps } from "react";

type Kind = "radar" | "connection" | "logs" | "metrics" | "traces" | "info";
const paths: Record<Kind, ReactNode> = {
  radar: <><path d="M20 12a8 8 0 1 1-8-8v8l5-5" /><path d="M12 8a4 4 0 1 0 4 4" /><circle cx="12" cy="12" r="1" /></>,
  connection: <><path d="M8 8h8v8H8zM12 3v5M12 16v5M3 12h5M16 12h5" /><circle cx="12" cy="3" r="1" /><circle cx="21" cy="12" r="1" /></>,
  logs: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  metrics: <><path d="M4 20h16M7 16v-5M12 16V4M17 16V8" /></>,
  traces: <><path d="M7 5h10M7 12h10M7 19h10M12 5v14" /><circle cx="7" cy="5" r="2" /><circle cx="17" cy="12" r="2" /><circle cx="7" cy="19" r="2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7h.01" /></>,
};
export function RadarIcon({ kind, ...props }: SVGProps<SVGSVGElement> & { kind: Kind }) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[kind]}</svg>;
}
