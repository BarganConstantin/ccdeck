// Review: the sessions still running on older session hosts (Windows), what
// ending them costs, and the choice — End, per host, or Keep them running.
//
// Laid out like the clear prompt (ClearConfirm.tsx): the facts one to a line,
// what goes and what stays, and the harmless answer first. Keep them running
// takes focus on open, so a stray Enter keeps everything; Escape, ✕ and the
// scrim cancel and change nothing. End sends exactly the sessions listed
// above it (older-hosts.ts), and while it is on its way no End acts again: the
// others go inert, the pressed one keeps focus and the hook refuses it.
//
// Mounted from the stage, so it renders into <body> through a portal: the
// stage's own layout must not reach the scrim (panel-modal-portal.test.ts).
import { useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CONFIRM_LAYER } from "../../modal-dismiss";
import { pressState } from "../../panel-press";
import { shortAgo } from "../../relative-time";
import type { OlderHost } from "../../terminal-api";
import { useModalDismiss, useScrimDismiss } from "../use-modal-dismiss";
import { endLabel, hostReason, hostsConsequences, type HostsView } from "./older-hosts";
import { agentName, folderName } from "./stage-model";

export interface HostsReviewProps {
  view: HostsView;
  now: number;
  /** The generation whose End is in flight. */
  busy: number | null;
  /** The sentence a refused End left. */
  said: string | null;
  keepRef?: RefObject<HTMLButtonElement>;
  onEnd(host: OlderHost): void;
  onKeep(): void;
}

/** The dialog's body, hook-free so the suite can draw it and press it. */
export function HostsReview(p: HostsReviewProps) {
  const { ends, stays } = hostsConsequences(p.view);
  return (
    <section className="modal-body">
      {p.view.hosts.map(host => {
        // #518's rule: the End pressed stays enabled and says it is working,
        // the other hosts' End go inert meanwhile.
        const press = pressState(p.busy === null ? null : String(p.busy), String(host.generation));
        return (
        <div key={host.generation} className="oh-host">
          <p className="oh-reason">{hostReason(host)}</p>
          <ul className="oh-sessions">
            {host.sessions.map(s => (
              <li key={s.id}>
                <b>{s.name}</b>
                <span>{agentName(s.agent)} · {folderName(s.cwd)} · started {shortAgo(p.now - s.started)}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn danger"
            disabled={press.disabled}
            aria-busy={press.busy || undefined}
            onClick={() => p.onEnd(host)}
          >
            {endLabel(host)}
          </button>
        </div>
        );
      })}
      <dl className="cc-plan">
        <dt>Ends</dt>
        <dd><span>{ends}</span></dd>
        <dt>Stays</dt>
        <dd><span>{stays}</span></dd>
      </dl>
      {p.view.launchesRefused && <p className="cc-final">{p.view.launchesRefused}</p>}
      {p.said && <p className="cc-final" role="status">{p.said}</p>}
      <div className="cc-actions">
        <button type="button" ref={p.keepRef} className="btn" onClick={p.onKeep}>Keep them running</button>
      </div>
    </section>
  );
}

export interface HostsDialogProps extends Omit<HostsReviewProps, "keepRef"> {
  onCancel(): void;
}

export default function HostsDialog(p: HostsDialogProps) {
  const keepRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useModalDismiss(p.onCancel, { focusRef: keepRef, layer: CONFIRM_LAYER });
  const scrimPress = useScrimDismiss(p.onCancel);
  const many = p.view.hosts.length > 1;
  return createPortal(
    <div className="modal-backdrop" {...scrimPress} role="presentation">
      <div
        ref={dialogRef}
        className="modal clear-confirm older-hosts"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="older-hosts-title"
      >
        <header className="modal-head">
          <div className="modal-title">
            <span className="status-dot warn" aria-hidden />
            <span id="older-hosts-title" className="modal-tool-name">
              {many ? "Sessions on older session hosts" : "Sessions on an older session host"}
            </span>
          </div>
          <div className="modal-actions">
            <button type="button" className="glyph-btn" onClick={p.onCancel} aria-label="Cancel (Esc)" title="Cancel (Esc)">×</button>
          </div>
        </header>
        <HostsReview {...p} keepRef={keepRef} />
      </div>
    </div>,
    document.body,
  );
}
