// Appearance › Git: which app each of the git view's hand-off buttons opens,
// for the slots where the deck's machine has more than one. A slot with one app
// opens that one and asks nothing; the default is the first found, in the
// deck's order (git-handoff-apps.mjs on the server).
//
// Native selects, as the sound menu's are: they arrive with the keyboard, the
// platform's own list and a reader that already knows how to announce one. A
// component of its own, under the switch it belongs to, so the dialog's one
// station combobox stays the only picker AppearanceMenu draws itself.
import { useEffect } from "react";
import { useGitOn } from "../git-pref";
import { HANDOFF_SLOTS, loadHandoffs, pickHandoff, useHandoffs, type HandoffSlot } from "../git-handoffs";

const PICK_LABEL: Record<HandoffSlot, string> = { git: "Git client", editor: "Editor", terminal: "Terminal" };

export default function GitHandoffPicks() {
  const gitOn = useGitOn();
  const handoffs = useHandoffs();
  // Looked at afresh each time Appearance opens, so an app installed since the
  // last look is offered.
  useEffect(() => { if (gitOn) void loadHandoffs(true, true); }, [gitOn]);
  const slots = gitOn && handoffs.state === "ready"
    ? HANDOFF_SLOTS.filter(slot => handoffs.slots[slot].apps.length > 1)
    : [];
  if (!slots.length) return null;
  return (
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
      <p className="appearance-row-note">
        {handoffs.local ? "Only apps found on this machine are listed." : `Only apps found on ${handoffs.machine || "the deck's machine"} are listed.`}
      </p>
    </div>
  );
}
