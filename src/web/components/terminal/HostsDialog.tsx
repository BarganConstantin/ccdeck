// Review: the sessions still running on older session hosts (Windows), what
// ending them costs, and the choice — End them, or Keep them running.
//
// Drawn as V4's Figma has it: the intro, one two-line row per session, the two
// facts as plain lines and the engine's refusal, then the footer, right-aligned
// — Keep them running, and End {n} sessions last. Keep them running takes focus
// on open, so a stray Enter keeps everything; Escape, ✕ and the scrim cancel
// and change nothing. End sends exactly the sessions listed above it
// (older-hosts.ts), one host after another through the existing per-host call:
// the engine refuses new sessions until every older host is gone, so ending one
// alone would not help. While it is on its way End stays enabled and says it is
// working, and the hook refuses a second press.
//
// Mounted from the stage, so it renders into <body> through a portal: the
// stage's own layout must not reach the scrim (panel-modal-portal.test.ts).
import { useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CONFIRM_LAYER } from "../../modal-dismiss";
import { shortAgo } from "../../relative-time";
import { Dialog, DialogClose } from "../Dialog";
import { useModalDismiss, useScrimDismiss } from "../use-modal-dismiss";
import { endAllLabel, hostReason, hostsConsequences, type HostsView } from "./older-hosts";
import { agentName, folderName } from "./stage-model";
import { t, useT } from "../../i18n";

export interface HostsReviewProps {
  view: HostsView;
  now: number;
  /** The generation whose End is in flight. */
  busy: number | null;
  /** The sentence a refused End left. */
  said: string | null;
  keepRef?: RefObject<HTMLButtonElement>;
  /** End every listed session. */
  onEndAll(): void;
  onKeep(): void;
}

/** "Those agents" -> "those agents": a fact's sentence follows its label. */
const afterLabel = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The dialog's body and footer, hook-free so the suite can draw them and press them. */
export function HostsReview(p: HostsReviewProps) {
  const { ends, stays } = hostsConsequences(p.view);
  const reasons = [...new Set(p.view.hosts.map(hostReason))];
  const sessions = p.view.hosts.flatMap(h => h.sessions);
  return (
    <>
      <section className="modal-body">
        {reasons.map(reason => <p key={reason} className="oh-intro">{reason}</p>)}
        <ul className="oh-sessions">
          {sessions.map(s => (
            <li key={s.id}>
              <b>{s.name}</b>
              <span>{t("board.hosts.row", { agent: agentName(s.agent), folder: folderName(s.cwd), ago: shortAgo(p.now - s.started) })}</span>
            </li>
          ))}
        </ul>
        <div className="oh-facts">
          <p className="oh-ends">{t("board.hosts.endsLine", { text: afterLabel(ends) })}</p>
          <p className="oh-stays">{t("board.hosts.staysLine", { text: afterLabel(stays) })}</p>
        </div>
        {p.view.launchesRefused && <p className="oh-last">{p.view.launchesRefused}</p>}
        {p.said && <p className="oh-last" role="status">{p.said}</p>}
      </section>
      <footer className="modal-foot">
        <button type="button" ref={p.keepRef} className="btn" onClick={p.onKeep}>{t("board.hosts.keep")}</button>
        <button
          type="button"
          className="btn danger"
          aria-busy={p.busy !== null || undefined}
          onClick={p.onEndAll}
        >
          {endAllLabel(sessions.length)}
        </button>
      </footer>
    </>
  );
}

export interface HostsDialogProps extends Omit<HostsReviewProps, "keepRef"> {
  onCancel(): void;
}

export default function HostsDialog(p: HostsDialogProps) {
  const tt = useT();
  const keepRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(p.onCancel, { focusRef: keepRef, layer: CONFIRM_LAYER });
  const scrimPress = useScrimDismiss(p.onCancel);
  const many = p.view.hosts.length > 1;
  return createPortal(
    <Dialog scrim={scrimPress} dialogRef={dialogRef} className="clear-confirm older-hosts" labelledBy="older-hosts-title">
        <header className="modal-head">
          <div className="modal-title">
            <span id="older-hosts-title" className="modal-tool-name">
              {many ? tt("board.hosts.titleMany") : tt("board.hosts.titleOne")}
            </span>
          </div>
          <div className="modal-actions">
            <DialogClose onClick={p.onCancel} label={tt("board.hosts.cancelEsc")} />
          </div>
        </header>
        <HostsReview {...p} keepRef={keepRef} />
    </Dialog>,
    document.body,
  );
}
