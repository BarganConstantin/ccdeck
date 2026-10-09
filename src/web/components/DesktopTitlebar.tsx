import { useEffect } from "react";

export interface DesktopWindow {
  platform: string;
  colors: (value: { color: string; symbolColor: string }) => Promise<void>;
  menu: () => Promise<void>;
}
declare global {
  interface Window { ccdeckWindow?: DesktopWindow }
}

export default function DesktopTitlebar() {
  const desktop = window.ccdeckWindow;
  useEffect(() => {
    if (!desktop) return;
    const sync = () => {
      const bar = document.querySelector<HTMLElement>(".desktop-titlebar");
      if (!bar) return;
      const style = getComputedStyle(bar);
      const hex = (rgb: string) => {
        const parts = rgb.match(/\d+/g)?.slice(0, 3);
        return parts?.length === 3 ? `#${parts.map(n => Number(n).toString(16).padStart(2, "0")).join("")}` : "#191a1c";
      };
      void desktop.colors({ color: hex(style.backgroundColor), symbolColor: hex(style.color) }).catch(() => {});
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme"] });
    return () => observer.disconnect();
  }, [desktop]);
  if (!desktop) return null;
  return (
    <div className="desktop-titlebar" data-platform={desktop.platform}>
      {desktop.platform !== "darwin" && (
        <button type="button" className="desktop-menu" aria-label="Application menu" title="Application menu" aria-haspopup="menu"
          onClick={() => { void desktop.menu().catch(() => {}); }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 4h10M3 8h10M3 12h10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
        </button>
      )}
      <span className="desktop-window-name">ccdeck</span>
    </div>
  );
}
