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

export const TrafficRadarGlyph = () => (
  <Glyph>
    <circle cx="7" cy="7" r="5" />
    <path d="M7 2v5l3.5-3.5" />
    <circle cx="4.5" cy="8.5" r=".7" />
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

export const RadioGlyph = () => (
  <Glyph><path d="M2 5h10v7H2z M4 5l6-3 M4 8h3 M9 8h1 M4 10h1 M8 10h2" /></Glyph>
);

/** Tool activity: a wrench in the shared rail-glyph style. */
export const ToolActivityGlyph = () => (
  <Glyph><path d="M8.8 1.5a3 3 0 0 0-3.7 3.7l-3 3a1.8 1.8 0 0 0 2.5 2.5l3-3a3 3 0 0 0 3.7-3.7L9.4 5.9 7 3.5z" /></Glyph>
);

/** Reported reset timing uses the same control-glyph geometry. */
export const ClockGlyph = () => (
  <Glyph><circle cx="7" cy="7" r="5" /><path d="M7 3.8V7l2.2 1.4" /></Glyph>
);

/** Jira (#2178): the three-tile mark from Simple Icons' Jira icon (CC0;
 *  THIRD_PARTY_NOTICES.md), filled in currentColor so it takes the stripe's
 *  ink like every glyph here, and drawn a little inside the frame so its solid
 *  tiles weigh about what a 1.4 stroke does. Never the coloured logo. */
export const JiraGlyph = () => (
  <Glyph>
    <path fill="currentColor" stroke="none" transform="translate(1.25 1.25) scale(0.479)"
      d="M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0z" />
  </Glyph>
);

/** GitHub and GitLab (#2179): the marks from Simple Icons' GitHub and GitLab
 *  icons (CC0; THIRD_PARTY_NOTICES.md), filled in currentColor and placed as
 *  JiraGlyph is. Never the coloured logos. */
export const GithubGlyph = () => (
  <Glyph>
    <path fill="currentColor" stroke="none" transform="translate(1.25 1.25) scale(0.479)"
      d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </Glyph>
);

export const GitlabGlyph = () => (
  <Glyph>
    <path fill="currentColor" stroke="none" transform="translate(1.25 1.25) scale(0.479)"
      d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
  </Glyph>
);
