// The finding that nothing can reach this deck, drawn wherever somebody is
// looking when it matters.
//
// IT EXISTED AND NOBODY SAW IT. lan-reach.mjs has read this machine's firewall
// since 3.23.2 and answers on every poll, and the panel drew that answer in one
// place: inside `+ add a deck`, a dialog a reader opens only once they have
// already decided the feature is broken and gone looking for a way round it.
// So the deck knew, said so, and the report that came back was still "I turned
// it on and nothing ever appeared". A verdict behind a door is a verdict that
// arrives after the conclusion it was meant to prevent.
//
// SO IT MOVED TO THE SWITCH, and this file is what makes that not a second
// copy. Two surfaces draw one finding, and a finding drawn twice in two files
// is two things to keep true: the block below was already four elements, a
// fold, a shell block and a copy verb, and duplicating that into the panel
// would have been the same paragraph maintained in two voices until they
// disagreed.
//
// WHAT DIFFERS BETWEEN THE TWO IS THE WAY OUT, AND ONLY THAT. The verdict is
// about the machine and reads identically on both; the sentence under it points
// at a control, and the control is not the same one. In the dialog the paste
// field is directly below, so the sentence says below. In the panel there is no
// field — the same two ways in live behind the `+` in the header — so the
// sentence says `+`. This is the whole reason `where` exists, and it is a
// parameter rather than two components because everything else, including the
// part that has to stay exactly right, is shared.
//
// SAYS, NEVER RUNS. The lines are text and a copy verb, for the reason
// relay-guard.mjs wrote down: a route in this server that elevated would hand
// every local process a way to raise an authentication dialog wearing ccdeck's
// name. See lan-reach.mjs, which refuses the same thing at the other end.
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../copy-text";
import type { LanReach } from "./LanSyncSection";

/**
 * The way out that needs no firewall rule at all, per surface.
 *
 * VALUES RATHER THAN JSX, so the difference between the two surfaces can be
 * read by the suite as the thing it is — one sentence, pointing at one control
 * — instead of being inferred from a regex over a branch. `below` in the panel
 * would be the panel telling a reader to look at a field that is not on the
 * screen, which is the class of copy nobody catches by reading the file.
 *
 * Both say the same first half, because it is the half that stops somebody
 * concluding the feature is broken: a round is one OUTBOUND connection, so a
 * deck nothing can reach still does every part of this by dialling out.
 */
export const REACH_WAY_OUT: Record<"panel" | "dialog", string> = {
  panel: "Nothing here is stuck: whoever pastes an invite is the one dialling out. "
    + "Ask them for one and paste it behind the + above, where an address can be typed too.",
  dialog: "Nothing here is stuck: whoever pastes an invite is the one dialling out. "
    + "Ask them for one and paste it below, or type their address.",
};

/** How long the copy verb reads `copied` before it goes back to saying what it
 *  does. The same 1.6s the dialog's other copy words use. */
const COPIED_MS = 1_600;

/**
 * Why other decks cannot reach this one, and the two ways forward.
 *
 * Draws nothing at all unless the verdict is `blocked`. Every other answer —
 * a machine this cannot speak about, a probe that did not come back, a firewall
 * that is off, a connection that has already got in — is silence, which is what
 * it was before any of this existed and the one outcome that cannot mislead.
 */
export default function LanReachNote({ reach, where }: {
  reach?: LanReach | null;
  /** Which surface is drawing it — see REACH_WAY_OUT. */
  where: "panel" | "dialog";
}) {
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const steps = reach?.steps ?? [];
  const copy = useCallback(async () => {
    // A copy that did not land leaves the verb alone rather than claiming it
    // did: the lines are selectable text underneath, so the reader is exactly
    // where they were. See copy-text, which returns false rather than throwing.
    if (!await copyText(steps.join("\n"))) return;
    if (!alive.current) return;
    setCopied(true);
    window.setTimeout(() => { if (alive.current) setCopied(false); }, COPIED_MS);
  }, [steps]);

  if (!reach?.blocked) return null;
  // WHERE THE LINES GO, from the verdict rather than from a guess about the
  // platform. Windows wants an elevated PowerShell and Linux an ordinary
  // terminal with sudo in the lines themselves; saying "PowerShell" to somebody
  // on Arch is worse than saying nothing, because it reads as a dialog meant
  // for a different machine and the rest goes with it.
  const sh = reach.shell === "sh";
  return (
    <div className="ap-lan-reach">
      <p className="lan-warn">{reach.text}</p>
      <p className="lan-note">{REACH_WAY_OUT[where]}</p>
      {steps.length > 0 && (
        // Folded away, because the paragraph above it is the answer that needs
        // no administrator at all. This is the other one, for a reader who
        // wants the discovery half working rather than a deck that dials.
        <details className="ap-lan-reach-fix">
          <summary>or let them find this deck on their own</summary>
          <p className="lan-note">
            {sh ? (
              <>Run this in a terminal on this machine, then restart the deck.</>
            ) : (
              <>Run this in PowerShell <strong>as Administrator</strong>, then restart the deck.</>
            )}
            {reach.category === "Public" && (
              <> The first line marks this network as a home or office one — leave it
              out on a network you do not trust.</>
            )}
            {/* The Linux verdict knows what it could not check, and says so here
                rather than letting the command imply a certainty it does not
                have. See LanReach.unsure. */}
            {reach.unsure && <> {reach.unsure}</>}
          </p>
          <pre className="ap-lan-cmd"><code>{steps.join("\n")}</code></pre>
          <button type="button" className="ap-manage-btn" onClick={() => void copy()}
            title={sh ? "Copy these lines, then paste them into a terminal"
              : "Copy these lines, then paste them into an elevated PowerShell"}>
            {copied ? "copied" : "copy command"}
          </button>
        </details>
      )}
    </div>
  );
}
