// Browser Watch's footer: whether the watch is running, how many episodes are
// on disk, the gear that opens the settings, and the switch.
//
// Lifted out of BrowserWatchModal.tsx unchanged, with modeState, which only the
// footer's word reads. The settings panel is the dialog's to show, so the gear
// is handed its open state; the switch writes through the dialog's `save`.
import type { Dispatch, SetStateAction } from "react";

import type { WatchSettings, WatchSnapshot } from "../browser-watch-model";

/**
 * What the bar says about the watch, and which of three things it is saying: a
 * setting on its way to the server, paused, or watching.
 *
 * The kind exists so the word can cross-fade when the meaning changes. The word
 * is keyed on it, so a new state mounts a new word and plays its entrance, and a
 * render that leaves the state where it was leaves the word alone.
 */
function modeState(
  snap: { settings: { enabled: boolean } },
  saving: boolean,
): { kind: "saving" | "off" | "on"; word: string } {
  if (saving) return { kind: "saving", word: "Saving" };
  // ONE QUESTION, ONE ANSWER. This carried an episode count as well — "Watching
  // · nothing captured yet" — and the two ideas fought: a reader with visible
  // browser activity in the feed below was being told nothing had been
  // captured, which is true of episodes and reads as false of the panel.
  // Persistence belongs to the count beside it, which says it in the same noun
  // the Findings section uses. The word says whether the watch is running.
  if (!snap.settings.enabled) return { kind: "off", word: "Paused" };
  return { kind: "on", word: "Watching" };
}

export default function BrowserWatchStatus({
  snap,
  saving,
  save,
  why,
  setWhy,
}: {
  snap: WatchSnapshot;
  /** A setting is on its way to the server — the word says "Saving". */
  saving: boolean;
  save: (patch: Partial<WatchSettings>) => Promise<void>;
  /** Whether the settings panel is open. */
  why: boolean;
  setWhy: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <footer className="bw-status">
      {/* THE STATE SITS BESIDE THE CONTROL THAT CHANGES IT. It had a
          row of its own holding one word and one link, which is a whole
          band of the panel spent on two small things — and it put the
          readout at the top while the switch it describes was at the
          bottom. Together they are one sentence: what the watch is
          doing, and the control for it. */}
      <span className={`bw-mode-dot${snap.settings.enabled ? " on" : ""}`} aria-hidden />
      <span className="bw-mode-word" key={modeState(snap, saving).kind}>
        {modeState(snap, saving).word}
      </span>
      {/* THE ONE PLACE PERSISTENCE IS SAID, in the noun the Findings
          section uses. One concept, one noun, one place. */}
      <span className="bw-status-text">
        {snap.coverage.archived === 0
          ? (snap.settings.enabled ? "No episodes recorded yet" : "No episodes on disk")
          : `${snap.coverage.archived} ${snap.coverage.archived === 1 ? "episode" : "episodes"} on disk`}
      </span>
      {/* `htmlFor` forwards the CLICK to a button, which is why the
          whole label operates the switch — but it does not NAME one:
          `<label>` names form controls, and a button is not among them.
          So the switch was announcing itself as "switch, on" with no
          word for what it switches. `aria-labelledby` points at the
          same visible text, so the two cannot drift apart. */}
      {/* A GEAR, NOT THE WORD. `settings` spelled out took a control's
          worth of width for a disclosure nobody opens twice, and the
          deck already draws icons this way — the topbar's eye is inline
          SVG at 13px, stroke 1.5, in currentColor. Same drawing, same
          `.glyph-btn` box as the header's ↻ and ×, and a real
          accessible name so the picture never has to carry the meaning
          on its own. */}
      <button
        className={`glyph-btn bw-gear${why ? " on" : ""}`}
        onClick={() => setWhy(w => !w)}
        aria-expanded={why}
        aria-label="Settings"
        title="Settings"
      >
        <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
          <circle cx="7" cy="7" r="2.1" />
          <path d="M7 1.2v1.6M7 11.2v1.6M1.2 7h1.6M11.2 7h1.6M2.9 2.9l1.1 1.1M10 10l1.1 1.1M11.1 2.9L10 4M4 10l-1.1 1.1" />
        </svg>
      </button>
      <label className="bw-switch" htmlFor="bw-enabled">
        <span className="bw-switch-label" id="bw-enabled-label">Watch browser activity</span>
        <button
          id="bw-enabled"
          type="button"
          role="switch"
          aria-checked={snap.settings.enabled}
          aria-labelledby="bw-enabled-label"
          className="switch"
          onClick={() => void save({ enabled: !snap.settings.enabled })}
          title={snap.settings.enabled
            ? "On — every episode it finds is written down, so the list outlives the browsing history being cleared"
            : "Off — showing only what this deck has seen since it started. Anything an earlier run archived is hidden until you switch back on, and nothing new is kept"}
        >
          <span className="switch-knob" />
        </button>
      </label>
    </footer>
  );
}
