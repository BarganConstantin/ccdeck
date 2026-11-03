// The deck's control glyphs. Where V4's kit has the icon they are the kit's own
// drawing (kit-icons.tsx: 14px, a 1.5 stroke, round caps and joins); the brand
// marks and the few shapes the kit has no counterpart for keep the old 13px
// spec below. Moved out of TopbarRuns.tsx when the panel toggles left the topbar
// for the edges, so the rails, the phone dock and the two utilities left on the
// bar draw from one set.
import type { ReactNode } from "react";
import { KitIcon } from "./kit-icons";

function Glyph({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <svg className={narrow ? "glyph glyph-narrow" : "glyph"} width="13" height="13" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const SessionListGlyph = () => <KitIcon name="sessions" className="glyph" />;

/** Discovery, distinct from a provider shortcut or a generic Add action. */
export const IntegrationsGlyph = () => <KitIcon name="integrations" className="glyph" />;

export const AccountsGlyph = () => <KitIcon name="account" className="glyph" />;

export const UsageGlyph = () => <KitIcon name="usage" className="glyph glyph-narrow" />;

export const HistoryGlyph = () => <KitIcon name="activity" className="glyph" />;

export const MachineGlyph = () => <KitIcon name="machine" className="glyph" />;

export const TrafficRadarGlyph = () => <KitIcon name="radar" className="glyph" />;

// Watching is the kit's eye; the not-watching slash has no kit drawing yet.
export const BrowserWatchGlyph = ({ watching }: { watching: boolean }) => (
  watching ? <KitIcon name="browser-watch" className="glyph" /> : (
    <Glyph>
      <path d="M0.9 7s2.2-4 6.1-4 6.1 4 6.1 4-2.2 4-6.1 4S0.9 7 0.9 7Z" />
      <line x1="2.4" y1="11.6" x2="11.6" y2="2.4" />
    </Glyph>
  )
);

export const SettingsGlyph = () => <KitIcon name="settings" className="glyph" />;

export const FeedbackGlyph = () => <KitIcon name="feedback" className="glyph" />;

// What's new's three actions (ReleaseActions.tsx). The arrow is the one the
// Accounts panel's reload turns while it works, and this one turns the same way
// while a check is out.

export const TourGlyph = () => <KitIcon name="play" className="glyph" />;

export const UpdateCheckGlyph = () => <KitIcon name="update" className="glyph" />;

export const RestartGlyph = () => <KitIcon name="restart" className="glyph" />;

export const RadioGlyph = () => <KitIcon name="radio" className="glyph" />;

/** Tool activity. */
export const ToolActivityGlyph = () => <KitIcon name="tools" className="glyph" />;

/** Skill activity. */
export const SkillActivityGlyph = () => <KitIcon name="skills" className="glyph" />;

/** Account capacity: the gauge. */
export const CapacityGlyph = () => <KitIcon name="capacity" className="glyph" />;

/** Reset calendar. */
export const ResetCalendarGlyph = () => <KitIcon name="calendar" className="glyph" />;

/** The Inspector's door, first on the right stripe. */
export const InspectorGlyph = () => <KitIcon name="info" className="glyph" />;

/** Reported reset timing. */
export const ClockGlyph = () => <KitIcon name="time" className="glyph" />;

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

// Quick open (quick-open.ts): the field's own glass, and the canvas actions it
// lists, on the kit's drawings so a row's glyph is one family with the doors above it.
export const SearchGlyph = () => <KitIcon name="search" className="glyph" />;

export const FitGlyph = () => <KitIcon name="recenter" className="glyph" />;

export const ArrangeGlyph = () => <KitIcon name="arrange" className="glyph" />;

export const PauseGlyph = () => <KitIcon name="pause" className="glyph" />;

export const ClearGlyph = () => <KitIcon name="clear" className="glyph" />;

export const CodexAccountsGlyph = () => (
  <Glyph>
    <path d="M4.6 3.6 1.4 7l3.2 3.4M9.4 3.6 12.6 7l-3.2 3.4M8 2.2 6 11.8" />
  </Glyph>
);
