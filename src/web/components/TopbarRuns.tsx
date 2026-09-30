// The three runs of the topbar's actions.
//
// Moved out of App.tsx's topbar markup unchanged. The actions come in three
// runs (see the comment on `.actions` in App.tsx): your sessions and what they
// spend, then who spends it, on what, and what it watched. Those two only open
// panels and dialogs, so each needs the open flags and the ways to flip them,
// and nothing else. The third run, the settings, mounts the sound and
// appearance menus with everything they configure, so it is handed each hook's
// return whole rather than forty props relayed one by one.
import type { Dispatch, SetStateAction } from "react";

import { selfPressProps } from "../panel-press";
import { finishSoundTitle } from "../provider-copy";
import type { Providers } from "../providers";
import type { useAppearance } from "../use-appearance";
import type { useChimePlayer } from "../use-chime-player";
import type { useClaudeFm } from "../use-claude-fm";
import type { useCustomTones } from "../use-custom-tones";
import type { useOsNotifications } from "../use-os-notifications";
import type { useReports } from "../use-reports";
import type { useSettingsMenus } from "../use-settings-menus";
import type { useSoundSwitch } from "../use-sound-switch";
import type { useTonePrefs } from "../use-tone-prefs";
import AppearanceMenu from "./AppearanceMenu";
import SoundMenu from "./SoundMenu";

type Toggle = Dispatch<SetStateAction<boolean>>;

/** Session list, Usage and its History. */
export function SessionRun({ sessionListOpen, toggleSessionList, usagePanelOpen, setUsagePanelOpen, setUsageHistoryOpen }: {
  sessionListOpen: boolean;
  toggleSessionList: () => void;
  usagePanelOpen: boolean;
  setUsagePanelOpen: Toggle;
  setUsageHistoryOpen: Toggle;
}) {
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
        className="btn icon-btn"
        onClick={toggleSessionList}
        title={`${sessionListOpen ? "Hide" : "Show"} session list (L)`}
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
        className="btn icon-btn"
        onClick={() => setUsagePanelOpen(o => !o)}
        title={`${usagePanelOpen ? "Hide" : "Show"} usage panel (U)`}
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
        className="btn icon-btn"
        onClick={() => setUsageHistoryOpen(o => !o)}
        title="Usage history — ccusage (H)"
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
            acts" (which a viewer does not), and Sound opens a dialog too
            without one. Every button here opens something. */}
        <span className="tb-word">History</span>
      </button>
    </div>
  );
}

/** Accounts, Machine and Browser watch. */
export function SourceRun({
  providers, accountsPanelOpen, toggleAccountsPanel, machinePanelOpen, setMachinePanelOpen,
  watchOn, watchUnseen, setBrowserWatchOpen,
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
}) {
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
        className="btn icon-btn"
        onClick={toggleAccountsPanel}
        title={`${accountsPanelOpen ? "Hide" : "Show"} accounts (A)`}
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
        className="btn icon-btn"
        onClick={() => setMachinePanelOpen(o => !o)}
        title={`${machinePanelOpen ? "Hide" : "Show"} this machine — cores, memory, temperature (S)`}
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
        className="btn icon-btn bw-btn"
        onClick={() => setBrowserWatchOpen(o => !o)}
        title={watchOn
          ? "Browser watch — watching; the deck is keeping its own copy (B)"
          : "Browser watch — not watching; reading the browser's history live (B)"}
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

/** Sound and Appearance: the two settings, each a button that opens its menu. */
export function SettingsRun({ providers, sound, tones, customTones, notify, chimeState, menus, appearance, fm, reports, onFeedback }: {
  providers: Providers;
  sound: ReturnType<typeof useSoundSwitch>;
  tones: ReturnType<typeof useTonePrefs>;
  customTones: ReturnType<typeof useCustomTones>;
  notify: ReturnType<typeof useOsNotifications>;
  /** Whether the chimes are still waiting for the first gesture to unlock. */
  chimeState: ReturnType<typeof useChimePlayer>["chimeState"];
  /** Which of the two menus is open, and the buttons they open from. */
  menus: ReturnType<typeof useSettingsMenus>;
  appearance: ReturnType<typeof useAppearance>;
  fm: ReturnType<typeof useClaudeFm>;
  /** Usage reports, on by default and switched off from the Appearance menu (#1853). */
  reports: ReturnType<typeof useReports>;
  onFeedback: () => void;
}) {
  const { soundOn, toggleSound } = sound;
  const { tonePrefs, previewTone, changeTone } = tones;
  const { customSelections, customAssets, clearCustomOnly, selectCustomTone, importNotificationAudio,
          createNotificationVoice, renameCustomAsset, deleteCustomAsset, previewCustomAsset } = customTones;
  const { notifyPermission, notifyOn, notifyVetoed, toggleNotify, notifySupported, askForNotifications } = notify;
  const { soundMenuOpen, setSoundMenuOpen, soundButtonRef, appearanceMenuOpen, setAppearanceMenuOpen,
          appearanceButtonRef } = menus;
  const { theme, setTheme, characterEnabled, setCharacterEnabled } = appearance;
  const { fmVolume, setFmVolume, fmMuted, setFmMuted, fmSource, customFmStations, unavailableFmStations,
          addFmStation, renameFmStation, removeFmStation, pickFmSource } = fm;
  return (
    <div className="action-run action-run-utility">
      {/* The settings run. Sound was the one genuine aria-pressed in this
          bar: it installs or removes a Stop hook on disk, a setting that
          is on or off. Since #711 the click opens a menu instead, and the
          pressed state went with the switch into that menu; the button is
          a disclosure now and reports the setting in its name.

          Gone without Claude Code, by the same rule the accounts button
          in the run above states: this switch is one entry in Claude Code's
          settings.json, so on a machine that has no Claude Code it is a
          control whose only effect is to write a hook nothing will ever
          execute. Where Claude Code IS here it stays, and the tooltip says
          which turns it covers — see finishSoundTitle, which also records
          the two ways of making Codex audible that were considered and why
          neither is this fix (#394). */}
      {providers.claude && soundOn !== null && (
      <div className="sound-slot">
        <button
          ref={soundButtonRef}
          className="btn icon-btn"
          /* #711: this used to toggle, and the click is now a disclosure.
             The gesture that was lost is put back rather than dropped —
             M still toggles from anywhere, and the menu carries the
             switch so a mouse has both routes. What made the change worth
             it is that the menu is no longer one number: it is a switch,
             two volumes, two sound choices and two previews, which is a
             panel's worth of controls about one subject.
             Shift used to restore the user's own parked hooks. #704
             removed the mechanism that parked them, so the modifier means
             nothing and is not read here.
             The handler is a callback rather than spelled out inline for
             TAG_BUDGET in tsx-scan.ts, which is measured against this
             tag. */
          onClick={() => setSoundMenuOpen(o => !o)}
          /* #620: this was `disabled={soundBusy}`, and the flag was set
             before the first await — so the switch went disabled under
             the press that had just come from it and Chrome dropped
             focus to `<body>`. #704 removed the request entirely and
             #711 leaves nothing to be busy for either: opening a menu is
             synchronous, and the argument is the constant that says so.
             It matters more now, not less — a disclosure that disables
             itself takes focus off the very control the menu's Escape is
             supposed to hand focus back to. */
          {...selfPressProps(false)}
          title={finishSoundTitle(providers, { on: soundOn === true, locked: chimeState === "locked", prefs: tonePrefs })}
          /* The name a screen reader announces: what the press DOES (it
             opens the settings), then whether sound is on, the same shape
             Browser watch's name has. The menu's switch changes it, with
             aria-pressed of its own; the name only reports it, so a
             reader learns the chimes are off without opening anything,
             as the icon's waves or cross already tell a sighted one.
             `title` reaches assistive tech only as a description, which
             is announced later than the name and by no means everywhere,
             so nothing a user needs lives only there. */
          aria-label={`Sound settings, ${soundOn ? "on" : "off"}`}
          aria-haspopup="dialog"
          aria-expanded={soundMenuOpen}
          aria-controls={soundMenuOpen ? "sound-menu" : undefined}
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3.2 5.2h2L7.8 3v8L5.2 8.8h-2z" />
            {soundOn
              ? <><path d="M9.8 5.4a2.4 2.4 0 0 1 0 3.2" /><path d="M11.3 3.9a4.6 4.6 0 0 1 0 6.2" /></>
              : <><path d="M10 5.6l2.6 2.8" /><path d="M12.6 5.6L10 8.4" /></>}
          </svg>
          <span className="tb-word">Sound</span>
        </button>
        {soundMenuOpen && (
          <SoundMenu
            onClose={() => setSoundMenuOpen(false)}
            soundOn={soundOn === true}
            onToggleSound={toggleSound}
            prefs={tonePrefs}
            onLevel={(chime, level) => changeTone(chime, { level })}
            onFigure={(chime, figure) => changeTone(chime, { figure })}
            onPreview={chime => previewTone(chime)}
            customAssets={customAssets}
            customSelections={customSelections}
            onBuiltInSelected={clearCustomOnly}
            onCustomSelected={selectCustomTone}
            onImportCustom={importNotificationAudio}
            onCreateVoice={createNotificationVoice}
            onRenameCustom={renameCustomAsset}
            onPreviewCustom={previewCustomAsset}
            onDeleteCustom={deleteCustomAsset}
            notifyOn={notifyOn}
            onToggleNotify={toggleNotify}
            notifyVetoed={notifyVetoed}
            notifyPermission={notifySupported ? notifyPermission : "unsupported"}
            onAskNotify={askForNotifications}
            openerRef={soundButtonRef}
          />
        )}
      </div>
      )}
      <div className="appearance-slot">
        <button
          ref={appearanceButtonRef}
          className="btn icon-btn"
          onClick={() => {
            setSoundMenuOpen(false);
            setAppearanceMenuOpen(open => !open);
          }}
          title="Appearance settings"
          aria-label={`Appearance settings, ${theme} theme, character ${characterEnabled ? "shown" : "hidden"}`}
          aria-haspopup="dialog"
          aria-expanded={appearanceMenuOpen}
          aria-controls={appearanceMenuOpen ? "appearance-menu" : undefined}
        >
        {theme === "dark" ? (
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="7" cy="7" r="2.5" />
            <path d="M7 1.5v1.2M7 11.3v1.2M1.5 7h1.2M11.3 7h1.2M3.1 3.1l.85.85M10.05 10.05l.85.85M3.1 10.9l.85-.85M10.05 3.95l.85-.85" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M11.8 8.4A5 5 0 1 1 5.6 2.2a4 4 0 0 0 6.2 6.2Z" />
          </svg>
        )}
        </button>
        {appearanceMenuOpen && (
          <AppearanceMenu
            theme={theme}
            onTheme={setTheme}
            characterEnabled={characterEnabled}
            onToggleCharacter={() => setCharacterEnabled(enabled => !enabled)}
            fmVolume={fmVolume}
            onFmVolume={setFmVolume}
            fmMuted={fmMuted}
            onFmMuted={() => setFmMuted(muted => !muted)}
            fmSource={fmSource}
            onFmSource={pickFmSource}
            customFmStations={customFmStations}
            unavailableFmStations={unavailableFmStations}
            onAddFmStation={addFmStation}
            onRenameFmStation={renameFmStation}
            onRemoveFmStation={removeFmStation}
            reportsOn={reports.reportsOn !== false && !reports.reportsVetoed}
            reportsVetoed={reports.reportsVetoed}
            onToggleReports={() => { void reports.answerReports(reports.reportsOn === false); }}
            onFeedback={() => { setAppearanceMenuOpen(false); onFeedback(); }}
            onClose={() => setAppearanceMenuOpen(false)}
          />
        )}
      </div>
      {/* REPORT A PROBLEM, WHERE A PERSON LOOKS FOR IT (#1853). The way to tell
          the makers something was buried in the Appearance menu — "Help improve
          ccdeck" → "Send feedback…" — behind the theme and the radio; the owner
          could not find it. It has a glyph in the bar now, in the utility run
          beside the two settings, which is the corner every product keeps its
          help and feedback in. No word: the topbar's seven words are a set, and
          this joins the theme button as a bare glyph rather than an eighth. It
          opens the same dialog the Appearance button does — the one door,
          `onFeedback` — and the switch and the note stay in Appearance where
          the deck explains what a report is. `aria-haspopup="dialog"` and no
          aria-expanded, the shape History and Browser watch already use for a
          button that opens a modal rather than discloses a region. */}
      <button
        className="btn icon-btn"
        onClick={onFeedback}
        title="Report a problem — tell the people who make ccdeck"
        aria-label="Report a problem"
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
      </button>
    </div>
  );
}
