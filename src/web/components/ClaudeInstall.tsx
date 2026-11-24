// Install Claude Code, where the deck found none: the session pane's card for a
// Claude session that could not start, and the Accounts sign-in whose `claude`
// could not be run. One component, so the two say and do the same thing. And
// Install Codex, the same card for a Codex session (`agent`): its own words,
// npm's install (codex-install.mjs), and npm's command by hand, the one
// OpenAI's README gives for every platform.
//
// THE OFFER, THEN THE WAY BY HAND. The host's sentence on what is missing, a
// primary Install Claude Code beside the host's own buttons (Try again and Not
// now in the pane, Try again in the dialog), and under them one muted line
// with the command Anthropic's setup page recommends, for the deck's platform,
// and Copy. Where the deck may not download it (AGENTS_DECK_NO_INSTALL,
// AGENTS_DECK_NO_DOWNLOAD), only the line.
//
// WHILE IT RUNS, THE SAME BUTTON, BUSY. Install stays where it was pressed, as
// the loader and "Installing Claude Code…", and a second press does nothing:
// the control a press came from is never taken away from under the reader
// (#518), so focus stays on it while it runs, and on Install again if it
// fails. The host chooses its buttons by what the card shows, so nothing
// offers to start Claude Code while it installs. Done: the host's sentence and
// small print go, since neither is true any more, and the host is told once
// (`onInstalled`), which in the pane starts the session again by itself.
// Failed: why, the installer's last lines when it printed any, and Install
// again.
import { useState, type ReactNode } from "react";
import { copyText } from "../copy-text";
import { useT } from "../i18n";
import { INSTALL_WORDS, type InstallAgent } from "../claude-install-api";
import { useClaudeInstall, type ClaudeInstallView } from "../use-claude-install";
import { useHoldThen } from "../use-engine-install";
import { Loader } from "./Loader";
import { KitIcon } from "./kit-icons";

/** How long "installed" is on screen before the host is told. */
export const INSTALLED_HOLD_MS = 900;

export interface ClaudeInstallProps {
  /** The session pane's centred card, or the sign-in dialog's column. */
  place: "stage" | "dialog";
  /** Which CLI it installs; Claude Code unless it says. */
  agent?: InstallAgent;
  /** Called once, after an install this card watched is done. */
  onInstalled?(): void;
  /** The host's sentence on what is missing, first; gone once installed. */
  lead?: ReactNode;
  /** The host's own buttons, after Install in the same row: as they are, or
   *  by what the card shows. */
  actions?: ReactNode | ((state: ClaudeInstallView["state"]) => ReactNode);
  /** The host's small print, last, with the command; gone once installed. */
  note?: ReactNode;
  /** Drawn under the lead instead when the deck cannot say anything of the install. */
  fallback?: ReactNode;
}

/** The command cut before its last word, with the pipe that feeds it
 *  ("| bash"): that end and Copy share a line at any width, so a narrow card
 *  breaks the command between whole parts, never after a dangling pipe. */
export function commandEnd(command: string): [head: string, end: string] {
  const last = command.lastIndexOf(" ");
  if (last < 0) return ["", command];
  const before = command.lastIndexOf(" ", last - 1);
  const cut = before >= 0 && command.slice(before + 1, last) === "|" ? before : last;
  return [command.slice(0, cut + 1), command.slice(cut + 1)];
}

/** The command to run by hand, muted, with Copy. */
function ByHand({ command, shell, place }: { command: string; shell: "terminal" | "powershell"; place: ClaudeInstallProps["place"] }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [head, end] = commandEnd(command);
  return (
    <p className={`${place === "stage" ? "ts-note" : "aa-note"} ci-manual`} data-place={place}>
      <span>{t(shell === "powershell" ? "accounts.claudeInstall.byHandPowerShell" : "accounts.claudeInstall.byHand")}</span>
      {/* The command as one piece, wrapping between its parts; its end and
          Copy never part, so Copy never wraps alone. */}
      <span className="ci-cmd">
        {head && <code>{head}</code>}
        <span className="ci-end">
          <code>{end}</code>
          <button
            type="button"
            className="glyph-btn"
            aria-label={copied ? t("board.stage.copied") : t("board.stage.copyCommand")}
            title={copied ? t("board.stage.copied") : t("board.stage.copy")}
            onClick={() => { void copyText(command).then(ok => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); } }); }}
          >
            <KitIcon name="copy" />
          </button>
        </span>
      </span>
    </p>
  );
}

export default function ClaudeInstall({ place, agent = "claude", onInstalled, lead, actions, note, fallback }: ClaudeInstallProps) {
  const t = useT();
  const { view, pending, install } = useClaudeInstall(agent);
  const words = INSTALL_WORDS[agent];
  const [told, setTold] = useState(false);
  useHoldThen(view.state === "done" && !told, INSTALLED_HOLD_MS, () => { setTold(true); onInstalled?.(); });

  const stage = place === "stage";
  const hosts = typeof actions === "function" ? actions(view.state) : actions;
  // One row that wraps whole buttons at a narrow width, never a label inside one.
  const row = (own: ReactNode) => (own || hosts ? <div className={`${stage ? "ts-acts" : "aa-actions"} ci-acts`}>{own}{hosts}</div> : null);
  if (view.state === "unavailable") return <>{lead}{fallback ?? row(null)}</>;

  const running = view.state === "running";
  const done = view.state === "done";
  const failed = view.state === "failed" ? view : null;
  const manual = view.state === "ask" || view.state === "failed" ? view : null;
  // Install, the same button busy while it runs, Install again (beside the
  // host's Try again, which starts what needed Claude Code as it was).
  const offered = view.state === "loading" || running || (manual !== null && manual.download);
  const own = offered ? (
    <button type="button" className="btn primary" data-stage-land={stage || undefined} aria-busy={running || pending || undefined}
      onClick={() => { if (!running && !pending) void install(); }}>
      {running
        ? <span className="ci-busy"><Loader /><span>{t(words.installing)}</span></span>
        : t(failed ? "accounts.claudeInstall.again" : words.install)}
    </button>
  ) : null;

  // One layout for every state, slot by slot: React matches a fragment's
  // children by their place, so the row and the button in it stay the same
  // elements from Install to Installing… to Install again, and so does the
  // focus on it. The words a button's content cannot carry to a screen reader
  // go in the status line under it, there before they change.
  return (
    <>
      {done ? null : lead}
      {done ? <p className={stage ? "ts-text" : "aa-note"} role="status">{t(words.done)}</p> : null}
      {failed ? <p className={stage ? "ts-note" : "aa-err"} role="alert">{t(words.reasons[failed.reason])}</p> : null}
      {failed?.detail ? <pre className="ci-detail">{failed.detail}</pre> : null}
      {row(own)}
      <span className="vis-hidden" role="status">{running ? t(words.installing) : ""}</span>
      {manual ? <ByHand command={manual.command} shell={manual.shell} place={place} /> : null}
      {done || running ? null : note}
    </>
  );
}
