// The glyph before each section's name in Settings' nav, so the eye finds a
// section by its shape before it reads the word, the way a desktop's own
// settings window does.
//
// All five are on the topbar's one spec (#837): 13px on a 14 viewBox, a 1.4
// stroke in currentColor with round caps and joins, hidden from assistive
// technology so a tab is named by its word alone. currentColor is what makes
// each one the tab's own ink — muted at rest, the text colour when chosen,
// the system's colours under a Contrast theme — with no rule of its own.
//
// Sounds is the topbar's speaker itself, imported rather than copied. General
// is the sliders the topbar's appearance button wore before the gear replaced
// it (#2034): the gear is the door into Settings, so inside it would name
// every section at once. The bell and the headphones are drawn for this nav,
// at the same weight and inside the same box as their neighbours.
import type { SettingsSection } from "../settings";
import { SpeakerGlyph } from "./TopbarRuns";

export default function SettingsSectionGlyph({ section }: { section: SettingsSection }) {
  if (section === "sounds") return <SpeakerGlyph on />;
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {section === "general" && (
        <>
          <path d="M1.5 3h4.3M9.2 3h3.3M1.5 7h1.3M6.2 7h6.3M1.5 11h6.3M11.2 11h1.3" />
          <circle cx="7.5" cy="3" r="1.7" />
          <circle cx="4.5" cy="7" r="1.7" />
          <circle cx="9.5" cy="11" r="1.7" />
        </>
      )}
      {section === "notifications" && (
        <>
          <path d="M3.4 9.1c.6-.8.6-1.8.6-3V4.7a3 3 0 0 1 6 0v1.4c0 1.2 0 2.2.6 3" />
          <path d="M2.2 9.1h9.6" />
          <path d="M5.7 11.2a1.3 1.3 0 0 0 2.6 0" />
        </>
      )}
      {section === "git" && (
        <>
          <circle cx="4.4" cy="3.3" r="1.4" />
          <circle cx="4.4" cy="10.7" r="1.4" />
          <circle cx="9.8" cy="4.6" r="1.4" />
          <path d="M4.4 4.7v4.6M9.8 6c0 2.4-2.2 2.8-5.2 3.5" />
        </>
      )}
      {section === "music" && (
        <path d="M2 8.4h2a1 1 0 0 1 1 1v1.4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7.2a5 5 0 0 1 10 0v3.6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1V9.4a1 1 0 0 1 1-1h2" />
      )}
    </svg>
  );
}
