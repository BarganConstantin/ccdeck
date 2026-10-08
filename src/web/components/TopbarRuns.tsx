// The three runs of the topbar's actions.
//
// Moved out of App.tsx's topbar markup unchanged. The actions come in three
// runs (see the comment on `.actions` in App.tsx): your sessions and what they
// spend, then who spends it, on what, and what it watched. Those two only open
// panels and dialogs, so each needs the open flags and the ways to flip them,
// and nothing else. The third run, the utilities, is the gear that opens
// Settings and the way to send feedback, so it needs the door into Settings
// and the feedback dialog's. Settings itself is mounted from DeckDialogs.tsx,
// the top of the tree.
import type { Dispatch, SetStateAction } from "react";

import type { Providers } from "../providers";
import type { PanelToggles } from "../use-panel-return";
import { platformName } from "../platform";
import { settingsChordLabel, type SettingsSection } from "../settings";
import { withKey } from "../single-key-shortcuts";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import TopbarMore from "./TopbarMore";

type Toggle = Dispatch<SetStateAction<boolean>>;

/** Session list, Usage and its History. */
export function SessionRun({ sessionListOpen, toggleSessionList, usagePanelOpen, setUsagePanelOpen, setUsageHistoryOpen, toggles }: {
  sessionListOpen: boolean;
  toggleSessionList: () => void;
  usagePanelOpen: boolean;
  setUsagePanelOpen: Toggle;
  setUsageHistoryOpen: Toggle;
  /** Where a panel's own close hands keyboard focus back (use-panel-return.ts). */
  toggles: PanelToggles;
}) {
  const singleKeys = useSingleKeyShortcuts();
  return (
    <div className="action-run">
      {/* aria-expanded, not aria-pressed. This shows and hides a region
          that follows it in the DOM and it leaves focus exactly where it
          was — the disclosure pattern, which is what the accounts panel's
          ⋯ menu already models below. "Pressed" would claim the button is
          a setting that stays on; what it actually reports is whether the
          thing it points at is on screen.
          aria-controls only while the panel is mounted, for the reason
          AccountsPanel spells out: an IDREF that resolves to nothing is a
          dangling pointer rather than a relationship, and closed is exactly
          when there is nothing to point at.
          The `primary` class is gone from all four of these. The state is
          the ARIA attribute now and the stylesheet reads it there, so the
          pixels and the accessibility tree cannot drift apart. #370 counted
          five; the session list's button has since been removed from the
          row and the rule is unchanged for the four that are left. */}
      {/* AND IT IS BACK (#800). Removing it left `L` as the ONLY way to
          open the sidebar — and the README leads with what that sidebar
          shows: "every session stopped on a human is at the top of the
          sidebar with the wait beside it". On a fresh install the detail
          rail is closed too, and that rail is where the `L session list`
          row lives, so the only route was: notice the small ? in the
          canvas control stack, open the sheet, read `L`. A mouse-only
          user had none at all.
          The count above is now five again, and the argument that
          removed this one — width in the middle of the bar — was about
          the three TEXT buttons that went with it, not about a 24px
          glyph. */}
      <button
        ref={toggles.sessionList}
        className="btn icon-btn"
        onClick={toggleSessionList}
        title={withKey(`${sessionListOpen ? "Hide" : "Show"} session list`, "L", singleKeys)}
        aria-label="Toggle session list"
        aria-expanded={sessionListOpen}
        aria-controls={sessionListOpen ? "session-list" : undefined}
      >
        {/* AUTHORED, NOT TYPED (#837). ☰, $ and ☀/☾ came from whichever
            font each platform had — three sizes and three baselines
            beside five drawn icons. All eight are drawn now, on one spec:
            13px on a 14 viewBox, a 1.4 stroke, round caps and joins. */}
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5.4 3.6h6.6M5.4 7h6.6M5.4 10.4h6.6" />
          <path d="M2.2 3.6h.2M2.2 7h.2M2.2 10.4h.2" />
        </svg>
        {/* THE WORD (#836), drawn where the bar has room — see .tb-word.
            Each one is a word its button's accessible name already
            contains, so the eye and voice control agree. */}
        <span className="tb-word">Session list</span>
      </button>
      <button
        ref={toggles.usage}
        className="btn icon-btn"
        onClick={() => setUsagePanelOpen(o => !o)}
        title={withKey(`${usagePanelOpen ? "Hide" : "Show"} usage panel`, "U", singleKeys)}
        aria-label="Toggle usage panel"
        aria-expanded={usagePanelOpen}
        aria-controls={usagePanelOpen ? "usage-panel" : undefined}
      >
        {/* tb-glyph-narrow: the one glyph in the set whose ink is far
            narrower than its box — see the rule in styles.css. */}
        <svg className="tb-glyph-narrow" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9.4 4.5C9 3.6 8.1 3.1 7 3.1c-1.4 0-2.4.8-2.4 1.9 0 1.2 1.2 1.6 2.4 2s2.4.8 2.4 2c0 1.1-1 1.9-2.4 1.9-1.1 0-2-.5-2.4-1.4" />
          <path d="M7 1.6v1.5M7 10.9v1.5" />
        </svg>
        <span className="tb-word">Usage</span>
      </button>
      {/* Beside Usage, because it is the same subject over a longer span:
          Usage is what is being spent now, History is ccusage's record
          of the days before. Read next to the dollar sign, "History" says
          whose history it is; filed at the end of the run it read as the
          browser history the eye after it watches.
          Neither aria-pressed nor aria-expanded. What this opens is a
          modal — role="dialog" aria-modal="true" behind a full-screen
          scrim, with the focus trap #371 added — so while it is open this
          button cannot be clicked, cannot be tabbed to, and aria-modal has
          removed the whole topbar from the accessibility tree. A state
          whose `true` no reader can ever reach is worse than no state: it
          would be a value announced only in the one case it is not
          needed. The label says "Open" rather than "Toggle", and
          aria-haspopup says what kind of thing opens. */}
      <button
        className="btn icon-btn tb-fold"
        onClick={() => setUsageHistoryOpen(o => !o)}
        title={withKey("Usage history — ccusage", "H", singleKeys)}
        aria-label="Open usage history"
        aria-haspopup="dialog"
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <line x1="3" y1="11.5" x2="3" y2="7" />
          <line x1="7" y1="11.5" x2="7" y2="3" />
          <line x1="11" y1="11.5" x2="11" y2="8.5" />
        </svg>
        {/* No ellipsis. On a row of chips "History…" read as a word cut
            off, the convention it borrowed means "asks for more before it
            acts" (which a viewer does not), and Settings and Feedback open
            dialogs too without one. Every button here opens something. */}
        <span className="tb-word">History</span>
      </button>
    </div>
  );
}

/** Accounts, Machine and Browser watch. */
export function SourceRun({
  providers, accountsPanelOpen, toggleAccountsPanel, machinePanelOpen, setMachinePanelOpen,
  watchOn, watchUnseen, setBrowserWatchOpen, toggles,
}: {
  providers: Providers;
  accountsPanelOpen: boolean;
  toggleAccountsPanel: () => void;
  machinePanelOpen: boolean;
  setMachinePanelOpen: Toggle;
  /** Whether Browser Watch reads in the background; null until known. */
  watchOn: boolean | null;
  /** Findings nobody has looked at yet. */
  watchUnseen: number;
  setBrowserWatchOpen: Toggle;
  /** Where a panel's own close hands keyboard focus back (use-panel-return.ts). */
  toggles: PanelToggles;
}) {
  const singleKeys = useSingleKeyShortcuts();
  return (
    <div className="action-run">
      {/* Same disclosure as the usage panel — a sidebar that opens beside
          the canvas and takes no focus with it.
          Gone entirely without Claude Code, rather than present and inert.
          A disabled control is a promise that something could be enabled;
          there is no account to switch to on a machine whose only CLI is
          Codex, which has exactly one logged-in account and no store. */}
      {providers.claude && (
      <button
        ref={toggles.accounts}
        className="btn icon-btn"
        onClick={toggleAccountsPanel}
        title={withKey(`${accountsPanelOpen ? "Hide" : "Show"} accounts`, "A", singleKeys)}
        aria-label="Toggle accounts panel"
        aria-expanded={accountsPanelOpen}
        aria-controls={accountsPanelOpen ? "accounts-panel" : undefined}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="7" cy="4.6" r="2.4" />
          <path d="M2.4 12c0-2.3 2.1-3.7 4.6-3.7s4.6 1.4 4.6 3.7" />
        </svg>
        <span className="tb-word">Accounts</span>
      </button>
      )}
      {/* The session list's ☰ used to sit here, sharing the left slot with
          accounts. The panel is untouched — it is still mounted by
          `sessionListOpen`, still toggled by L, still closed by its own ‹ —
          and only the topbar control is gone. What that costs is written
          down at the L handler, which is now the only way in. */}
      {/* THE METER'S REPLACEMENT, and the reason the strip above is one
          readout shorter. The panel is the same panel; what changed is
          that opening it costs a click on a glyph rather than a live
          trace in the corner of the bar.
          The run is ordered by subject: the session list, then what is
          being spent (Usage, and History beside it), then who spends it
          and what it runs on (Accounts, Machine), then Browser watch. It
          was ordered by kind, panels first and dialogs after with an
          ellipsis to tell them apart, and that split Usage from its own
          history.
          The glyph is a processor — a die with its pins — which is the
          one shape in this row that says "the box you are sitting at"
          rather than "your work". No aria-pressed: this discloses a
          region, which is what aria-expanded means, and the region names
          itself back through aria-controls. */}
      <button
        ref={toggles.machine}
        className="btn icon-btn"
        onClick={() => setMachinePanelOpen(o => !o)}
        title={withKey(`${machinePanelOpen ? "Hide" : "Show"} this machine — cores, memory, temperature`, "S", singleKeys)}
        aria-label="Toggle machine detail"
        aria-expanded={machinePanelOpen}
        aria-controls={machinePanelOpen ? "system-panel" : undefined}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3.6" y="3.6" width="6.8" height="6.8" rx="1.2" />
          <path d="M5.8 1.4v2.2M8.2 1.4v2.2M5.8 10.4v2.2M8.2 10.4v2.2M1.4 5.8h2.2M1.4 8.2h2.2M10.4 5.8h2.2M10.4 8.2h2.2" />
        </svg>
        <span className="tb-word">Machine</span>
      </button>
      {/* THE SILHOUETTE CARRIES THE STATE, AND NOTHING ELSE DOES. At 13px
          a hue change is not readable — ambient.ts makes the same
          argument about the favicon, where amber and grey come to 1.01:1
          under protanopia — so watching and not watching are a pupil and
          a slash, which differ in shape at any size.

          The slash is not a warning. Off is the default and it is a fine
          place to be, since the panel still answers retroactively.

          The button used to agree in colour as well, accent while
          watching and amber with a finding unread, and both are gone.
          Accent in this bar is hover, focus and an open panel's line;
          amber is the blocked-session chip, the one alarm the deck exists
          to raise. An eye that went amber for unread browser history
          taught the reader to look past amber. The badge says something
          is unread, in the bar's resting grey, and the pupil says the
          watch is on. */}
      <button
        className="btn icon-btn bw-btn tb-fold"
        onClick={() => setBrowserWatchOpen(o => !o)}
        title={withKey(watchOn
          ? "Browser watch — watching; the deck is keeping its own copy"
          : "Browser watch — not watching; reading the browser's history live", "B", singleKeys)}
        aria-label={`Browser watch, ${watchOn ? "watching" : "not watching"}`
          + (watchUnseen > 0 ? `, ${watchUnseen} unread` : "")}
        aria-haspopup="dialog"
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M0.9 7s2.2-4 6.1-4 6.1 4 6.1 4-2.2 4-6.1 4S0.9 7 0.9 7Z" />
          {watchOn || watchUnseen > 0
            ? <circle cx="7" cy="7" r="1.8" fill="currentColor" stroke="none" />
            : <line x1="2.4" y1="11.6" x2="11.6" y2="2.4" />}
        </svg>
        {/* The dialog's own title, so the word on the button and the
            heading it opens are the same two words. "Watch" alone did
            not say what is watched. */}
        <span className="tb-word">Browser watch</span>
        {watchUnseen > 0 && <span className="bw-badge" aria-hidden>{watchUnseen}</span>}
      </button>
    </div>
  );
}

/** Settings and Feedback: the gear that opens every setting the deck has, and
 *  the way to tell the people who make it something. */
export function SettingsRun({
  openSettings, onFeedback, watchUnseen, setUsageHistoryOpen, setBrowserWatchOpen,
}: {
  /** The one door into Settings (use-settings-menus.ts). */
  openSettings: (section?: SettingsSection) => void;
  onFeedback: () => void;
  /** What the phone-width ⋯ needs of the two dialogs it also opens. */
  watchUnseen: number;
  setUsageHistoryOpen: Toggle;
  setBrowserWatchOpen: Toggle;
}) {
  const settingsTitle = `Settings (${settingsChordLabel(platformName())})`;
  return (
    <div className="action-run action-run-utility">
      {/* THE GEAR, AND IT IS ALWAYS HERE. Every setting the deck has is behind
          it, in one dialog with a section per subject (SettingsModal.tsx), and
          Cmd/Ctrl+, opens the same dialog from anywhere — the chord every
          desktop app opens its settings with, said in the tooltip in the
          spelling of the keyboard in front of the reader.
          A gear and not the sliders this button used to wear: the sliders said
          "appearance", and this opens everything. The cog's teeth keep it apart
          from the Machine button's processor, whose pins are straight strokes
          off a square.
          `aria-haspopup="dialog"` and no aria-expanded, the shape History and
          Feedback use for a button that opens a modal rather than discloses a
          region: while the dialog is up this button is behind its scrim.
          Its word arrives later than the others' (`.tb-word-wider`,
          topbar.css): the busiest bar holds it only from the width given
          there, and under it the gear says its name in its tooltip and its
          accessible name, the way Feedback does under its own.
          It stands first in the run since the speaker left it (2026-10-07).
          The speaker opened a popover holding the sound switch and the two
          tones' volumes, and every one of those is in Settings › Sounds too:
          two doors to the same three controls, on a bar with no width to
          spare. What the speaker gave that the gear does not is kept on the
          keyboard — M mutes from anywhere, V opens Settings at Sounds. */}
      <button
        className="btn icon-btn"
        onClick={() => openSettings()}
        title={settingsTitle}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+, Meta+,"
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5.4 2.9L5.6 1.1L8.4 1.1L8.6 2.9L9.8 3.6L11.5 2.8L12.8 5.2L11.3 6.3L11.3 7.7L12.8 8.8L11.5 11.2L9.8 10.4L8.6 11.1L8.4 12.9L5.6 12.9L5.4 11.1L4.2 10.4L2.5 11.2L1.2 8.8L2.7 7.7L2.7 6.3L1.2 5.2L2.5 2.8L4.2 3.6Z" />
          <circle cx="7" cy="7" r="1.9" />
        </svg>
        <span className="tb-word-wider">Settings</span>
      </button>
      {/* FEEDBACK, WHERE A PERSON LOOKS FOR IT (#1853). The way to tell the
          makers something was buried in the Appearance menu — "Help improve
          ccdeck" → "Send feedback…" — behind the theme and the radio; the owner
          could not find it. It lives in the utility run beside the gear,
          the corner every product keeps its help and feedback in.
          It first came as a bare glyph, beside the theme button, so as not to
          be an eighth word. That was the second time it could not be found:
          at the toolbar's --muted, a 13px bubble at the end of a run of words
          read as nothing at all. So it says "Feedback" — rather than "Report
          a problem", because the dialog takes an idea or anything else as
          readily as a fault — from the width where the busiest bar still
          holds the word (`.tb-word-wide`, topbar.css), and is the glyph alone,
          at the same resting tone, under it. It opens the dialog through the
          one door, `onFeedback`, and since the Appearance section went
          (2026-10-01) it is the only way to it from the topbar.
          `aria-haspopup="dialog"` and no aria-expanded, the shape History and
          Browser watch already use for a button that opens a modal rather
          than discloses a region. */}
      <button
        className="btn icon-btn tb-fold"
        onClick={onFeedback}
        title="Send feedback — a problem, an idea or anything else, to the people who make ccdeck"
        aria-label="Send feedback"
        aria-haspopup="dialog"
      >
        {/* A speech bubble with a mark inside — say something is wrong. Drawn on
            the topbar's one spec (#837): 13px on a 14 viewBox, a 1.4 stroke,
            round caps and joins. The mark is a stroke and a dot, the way the
            accounts warning glyph draws one. */}
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M2.2 3.3h9.6v5.3H6.1L3.5 10.8V8.6H2.2Z" />
          <path d="M7 4.9v1.7" />
          <path d="M7 7.7v.05" />
        </svg>
        <span className="tb-word-wide">Feedback</span>
      </button>
      {/* History, Browser watch and Feedback above, folded into one ⋯ at a
          phone's width, where the bar cannot hold all eight controls and the
          waiting pill as well — components/TopbarMore.tsx. */}
      <TopbarMore
        watchUnseen={watchUnseen} setUsageHistoryOpen={setUsageHistoryOpen}
        setBrowserWatchOpen={setBrowserWatchOpen} onFeedback={onFeedback}
      />
    </div>
  );
}
