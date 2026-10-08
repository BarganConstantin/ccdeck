// Settings › Git: the git view's one switch, the look the view wears, and
// which app each of its hand-off buttons opens.
//
// These were a Git group under the theme in the Appearance modal. When that
// modal became Settings they took a section of their own rather than a group
// under General: the switch is one the server reads as well, the look and the
// apps only mean anything while it is on, and the nav is where a reader looks
// for "git". The section leads with its switch, as Notifications and Sounds
// lead with theirs, and the apps stand under the hairline every second subject
// in a section stands under.
//
// Every value here belongs to a store outside React — git-pref.ts for the
// switch, git-view-sizes.ts for the look, git-handoffs.ts for the apps — so
// the cards, the view's header button and its `f` read the same answer as this
// section, at once, and nothing is handed down through SettingsModal.
import type { KeyboardEvent } from "react";
import { toggleGit, useGitOn } from "../git-pref";
import { setGitLook, useGitViewPrefs } from "../git-view-sizes";
import type { GitLook } from "../git-view-types";
import GitHandoffPicks from "./GitHandoffPicks";

export default function GitSection() {
  // The git view's switch, which the server reads as well — git-pref.ts.
  const gitOn = useGitOn();
  // Which look the git view wears: the view's own preference, shared with
  // its header button and its `f` (git-view-sizes.ts).
  const gitLook = useGitViewPrefs().look;

  return (
    <>
      {/* One switch for all of it, the server's reads included, so the note
          can make the promise it makes. THE WHOLE ROW IS THE TARGET, and still
          one control, as Music's character row is: the <label> hands a press
          anywhere in it to the switch exactly once. */}
      <div className="settings-group">
        <div className="appearance-controls">
          <label className="appearance-row">
            <span className="appearance-row-label" id="appearance-git-label">Git: branch on cards and the git view</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={gitOn}
              aria-labelledby="appearance-git-label"
              aria-describedby="appearance-git-note"
              onClick={toggleGit}
            >
              <span className="switch-knob" />
            </button>
            <span id="appearance-git-note" className="appearance-row-note">Reads your repos locally; never changes them.</span>
          </label>
          {gitOn && <GitLookRow look={gitLook} />}
        </div>
      </div>
      {/* Which app each hand-off button opens, where there is a choice. */}
      <GitHandoffPicks />
    </>
  );
}

const GIT_LOOKS: ReadonlyArray<{ look: GitLook; word: string }> = [{ look: "deck", word: "Deck" }, { look: "fork", word: "Fork" }];

/** The git view's look, as a pair of radios: one Tab stop on the look that is
 *  set, the arrows walking the pair and switching as they go. */
function GitLookRow({ look }: { look: GitLook }) {
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = GIT_LOOKS[(GIT_LOOKS.findIndex(l => l.look === look) + 1) % GIT_LOOKS.length].look;
    setGitLook(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[GIT_LOOKS.findIndex(l => l.look === next)]?.focus();
  };
  return (
    <div className="appearance-git-look">
      <span className="appearance-row-label" id="appearance-git-look-label">Git view look</span>
      <div className="appearance-git-looks" role="radiogroup" aria-labelledby="appearance-git-look-label" aria-describedby="appearance-git-look-note" onKeyDown={onKey}>
        {GIT_LOOKS.map(l => (
          <button key={l.look} type="button" role="radio" className="appearance-git-look-pick" aria-checked={look === l.look}
            tabIndex={look === l.look ? 0 : -1} onClick={() => setGitLook(l.look)}>
            {l.word}
          </button>
        ))}
      </div>
      <span id="appearance-git-look-note" className="appearance-row-note">Fork draws the view as Fork's window, still read-only. Press F in the view to switch.</span>
    </div>
  );
}
