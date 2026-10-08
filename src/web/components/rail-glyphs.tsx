// The deck's control glyphs, on the one spec #837 drew them to: 13px on a 14
// viewBox, a 1.4 stroke, round caps and joins. Moved out of TopbarRuns.tsx
// unchanged when the panel toggles left the topbar for the edges, so the rails,
// the phone dock and the two utilities left on the bar draw from one set.
import type { ReactNode } from "react";

function Glyph({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <svg className={narrow ? "glyph glyph-narrow" : "glyph"} width="13" height="13" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const SessionListGlyph = () => (
  <Glyph>
    <path d="M5.4 3.6h6.6M5.4 7h6.6M5.4 10.4h6.6" />
    <path d="M2.2 3.6h.2M2.2 7h.2M2.2 10.4h.2" />
  </Glyph>
);

export const AccountsGlyph = () => (
  <Glyph>
    <circle cx="7" cy="4.6" r="2.4" />
    <path d="M2.4 12c0-2.3 2.1-3.7 4.6-3.7s4.6 1.4 4.6 3.7" />
  </Glyph>
);

export const UsageGlyph = () => (
  <Glyph narrow>
    <path d="M9.4 4.5C9 3.6 8.1 3.1 7 3.1c-1.4 0-2.4.8-2.4 1.9 0 1.2 1.2 1.6 2.4 2s2.4.8 2.4 2c0 1.1-1 1.9-2.4 1.9-1.1 0-2-.5-2.4-1.4" />
    <path d="M7 1.6v1.5M7 10.9v1.5" />
  </Glyph>
);

export const HistoryGlyph = () => (
  <Glyph>
    <line x1="3" y1="11.5" x2="3" y2="7" />
    <line x1="7" y1="11.5" x2="7" y2="3" />
    <line x1="11" y1="11.5" x2="11" y2="8.5" />
  </Glyph>
);

export const MachineGlyph = () => (
  <Glyph>
    <rect x="3.6" y="3.6" width="6.8" height="6.8" rx="1.2" />
    <path d="M5.8 1.4v2.2M8.2 1.4v2.2M5.8 10.4v2.2M8.2 10.4v2.2M1.4 5.8h2.2M1.4 8.2h2.2M10.4 5.8h2.2M10.4 8.2h2.2" />
  </Glyph>
);

export const BrowserWatchGlyph = ({ watching }: { watching: boolean }) => (
  <Glyph>
    <path d="M0.9 7s2.2-4 6.1-4 6.1 4 6.1 4-2.2 4-6.1 4S0.9 7 0.9 7Z" />
    {watching
      ? <circle cx="7" cy="7" r="1.8" fill="currentColor" stroke="none" />
      : <line x1="2.4" y1="11.6" x2="11.6" y2="2.4" />}
  </Glyph>
);

export const SettingsGlyph = () => (
  <Glyph>
    <path d="M5.4 2.9L5.6 1.1L8.4 1.1L8.6 2.9L9.8 3.6L11.5 2.8L12.8 5.2L11.3 6.3L11.3 7.7L12.8 8.8L11.5 11.2L9.8 10.4L8.6 11.1L8.4 12.9L5.6 12.9L5.4 11.1L4.2 10.4L2.5 11.2L1.2 8.8L2.7 7.7L2.7 6.3L1.2 5.2L2.5 2.8L4.2 3.6Z" />
    <circle cx="7" cy="7" r="1.9" />
  </Glyph>
);

export const FeedbackGlyph = () => (
  <Glyph>
    <path d="M2.2 3.3h9.6v5.3H6.1L3.5 10.8V8.6H2.2Z" />
    <path d="M7 4.9v1.7" />
    <path d="M7 7.7v.05" />
  </Glyph>
);

// What's new's three actions (ReleaseActions.tsx), on the same spec. The arrow
// is the one the Accounts panel's reload turns while it works, and this one
// turns the same way while a check is out.

export const TourGlyph = () => (
  <Glyph>
    <path d="M4.6 2.9v8.2L11.1 7Z" />
  </Glyph>
);

export const UpdateCheckGlyph = () => (
  <Glyph>
    <path d="M11.6 6.2A4.8 4.8 0 1 0 11 9.6" />
    <path d="M11.9 2.6v3.7h-3.6" />
  </Glyph>
);

export const RestartGlyph = () => (
  <Glyph>
    <path d="M7 1.6v5" />
    <path d="M4.2 3.6a4.8 4.8 0 1 0 5.6 0" />
  </Glyph>
);
