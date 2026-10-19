// The glyph before each section's name in Settings' nav, so the eye finds a
// section by its shape before it reads the word, the way a desktop's own
// settings window does.
//
// Every one is on the topbar's one spec (#837): 13px on a 14 viewBox, a 1.4
// stroke in currentColor with round caps and joins, hidden from assistive
// technology so a tab is named by its word alone. currentColor is what makes
// each one the tab's own ink — muted at rest, the text colour when chosen,
// the system's colours under a Contrast theme — with no rule of its own.
//
// Sounds is the speaker the topbar's sound button wore — a cone with two
// waves — and it lives here alone since that button left the bar
// (2026-10-07): Settings › Sounds is where everything it opened is. General
// is the sliders the topbar's appearance button wore before the gear replaced
// it (#2034): the gear is the door into Settings, so inside it would name
// every section at once. The bell is drawn for this nav, at the same weight
// and inside the same box as their neighbours, and so are the four the nav
// gained when each subject got its own section (#2176): a palette for
// Appearance, a keyboard for Keyboard, a stack of disks for Data — what the
// deck keeps — and the circled i every platform uses for About. Their shapes
// follow Lucide's (ISC licence) redrawn on this grid, so the set reads as one
// family with the icons a reader already knows from other settings windows.
// A dot is a zero-length stroke, which the round cap draws as a dot.
import type { SettingsSection } from "../settings";

export default function SettingsSectionGlyph({ section }: { section: SettingsSection }) {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {section === "radar" && <><path d="M11.8 7a4.8 4.8 0 1 1-4.8-4.8M9.7 7A2.7 2.7 0 1 1 7 4.3M7 7l4.8-4.8" /></>}
      {section === "reading" && <><path d="M2 11 5.5 3 9 11M3.3 8h4.4M10.5 4h2M10.5 7h2M10.5 10h2" /></>}
      {section === "sounds" && (
        <>
          <path d="M3.2 5.2h2L7.8 3v8L5.2 8.8h-2z" />
          <path d="M9.8 5.4a2.4 2.4 0 0 1 0 3.2" />
          <path d="M11.3 3.9a4.6 4.6 0 0 1 0 6.2" />
        </>
      )}
      {section === "general" && (
        <>
          <path d="M1.5 3h4.3M9.2 3h3.3M1.5 7h1.3M6.2 7h6.3M1.5 11h6.3M11.2 11h1.3" />
          <circle cx="7.5" cy="3" r="1.7" />
          <circle cx="4.5" cy="7" r="1.7" />
          <circle cx="9.5" cy="11" r="1.7" />
        </>
      )}
      {section === "appearance" && (
        <>
          <path d="M7 1.7a5.3 5.3 0 1 0 0 10.6c.8 0 1.3-.5 1.3-1.2 0-.6-.5-1-.5-1.6 0-.7.5-1.2 1.2-1.2h1.3a2.3 2.3 0 0 0 2.3-2.3C12.6 3.7 10.1 1.7 7 1.7z" />
          <path d="M4.3 6.7h.01M5.7 4.4h.01M8.4 4.2h.01" />
        </>
      )}
      {section === "keyboard" && (
        <>
          <rect x="1.5" y="3.5" width="11" height="7" rx="1.4" />
          <path d="M4 5.9h.01M6 5.9h.01M8 5.9h.01M10 5.9h.01M4.6 8.2h4.8" />
        </>
      )}
      {section === "data" && (
        <>
          <ellipse cx="7" cy="3.6" rx="4.6" ry="1.7" />
          <path d="M2.4 3.6v6.8c0 .9 2.1 1.7 4.6 1.7s4.6-.8 4.6-1.7V3.6" />
          <path d="M2.4 7c0 .9 2.1 1.7 4.6 1.7s4.6-.8 4.6-1.7" />
        </>
      )}
      {section === "about" && (
        <>
          <circle cx="7" cy="7" r="5.4" />
          <path d="M7 6.4v3.4M7 4.4h.01" />
        </>
      )}
      {section === "notifications" && (
        <>
          <path d="M3.4 9.1c.6-.8.6-1.8.6-3V4.7a3 3 0 0 1 6 0v1.4c0 1.2 0 2.2.6 3" />
          <path d="M2.2 9.1h9.6" />
          <path d="M5.7 11.2a1.3 1.3 0 0 0 2.6 0" />
        </>
      )}

    </svg>
  );
}
