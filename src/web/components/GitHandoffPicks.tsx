// Settings › Git: which app each of the git view's hand-off buttons opens,
// for the slots where the deck's machine has more than one. A slot with one app
// opens that one and asks nothing; the default is the first found, in the
// deck's order (git-handoff-apps.mjs on the server).
//
// Native selects, as the Sounds section's are: they arrive with the keyboard,
// the platform's own list and a reader that already knows how to announce one.
// A group of its own under the section's switch, captioned with the words the
// view's own menu says them in, and drawn only when there is a choice to make.
import { useEffect } from "react";
import { useGitOn } from "../git-pref";
import { HANDOFF_SLOTS, loadHandoffs, pickHandoff, useHandoffs, type HandoffSlot } from "../git-handoffs";

const PICK_LABEL: Record<HandoffSlot, string> = { git: "Git client", editor: "Editor", terminal: "Terminal" };

export default function GitHandoffPicks() {
  const gitOn = useGitOn();
  const handoffs = useHandoffs();
  // Looked at afresh each time Settings › Git opens, so an app installed since
  // the last look is offered.
  useEffect(() => { if (gitOn) void loadHandoffs(true, true); }, [gitOn]);
  const slots = gitOn && handoffs.state === "ready"
    ? HANDOFF_SLOTS.filter(slot => handoffs.slots[slot].apps.length > 1)
    : [];
  if (!slots.length) return null;
  return (
    <section className="settings-group" aria-labelledby="appearance-git-picks-caption">
      <div className="settings-caption">
        <div>
          <h3 id="appearance-git-picks-caption">Open in</h3>
          <p className="settings-caption-note">
            {handoffs.local ? "Only apps found on this machine are listed." : `Only apps found on ${handoffs.machine || "the deck's machine"} are listed.`}
          </p>
        </div>
      </div>
      <div className="appearance-git-picks">
        {slots.map(slot => (
          <div key={slot} className="appearance-git-pick">
            <label htmlFor={`appearance-git-pick-${slot}`}>{PICK_LABEL[slot]}</label>
            <select
              id={`appearance-git-pick-${slot}`}
              className="sm-select"
              value={handoffs.slots[slot].chosen ?? ""}
              onChange={e => pickHandoff(slot, e.target.value)}
            >
              {handoffs.slots[slot].apps.map(app => (
                <option key={app.id} value={app.id}>{app.id === "lazygit" ? "lazygit (in a terminal)" : app.name}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}
