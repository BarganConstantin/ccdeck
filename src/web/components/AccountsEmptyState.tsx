// What the accounts panel says when there is no roster to draw.
//
// The roster read answers `ok: false` for five different reasons — claude-swap
// still installing, not installed, installed with nothing in its store, a copy
// the deck refused to drive, or a store that could not be read — and each needs
// a different thing from the reader, so each gets its own sentence. V4's Figma
// draws four of them the same way: a title, a line of plain words, and then the
// one thing to do, which is a command to copy or a button to press.
import { useId, useState } from "react";
import { type AccountsData } from "../claude-accounts";
import { t as tNow, type TFunction, useT } from "../i18n";
import { Rich } from "../accounts-rich";
import { copyText } from "../copy-text";
import { KitIcon } from "./kit-icons";

/**
 * A REASON IN WORDS, WITH THE CODE KEPT. The store answers with a code or the
 * operating system's own message. A permission refusal and a missing file are
 * said as a phrase in the language on show, and the answer itself stays beside
 * it, because the code is what a report or a search needs.
 */
export function plainReason(reason: string | undefined | null, t: TFunction = tNow): string {
  const raw = (reason ?? "").trim();
  if (!raw) return "";
  const words = /eacces|eperm|permission/i.test(raw) ? t("accounts.empty.reasonDenied")
    : /enoent|no such file|not found/i.test(raw) ? t("accounts.empty.reasonMissing")
    : "";
  if (!words || words.toLowerCase() === raw.toLowerCase()) return raw;
  return `${words} · ${raw}`;
}

/** A command in its box with a Copy button (V4's Figma). */
function CommandBox({ command }: { command: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="ap-state-cmd">
      <code className="ap-cmd" title={command}>{command}</code>
      <button type="button" className="glyph-btn" aria-label={t("accounts.empty.copy")}
        title={copied ? t("accounts.empty.copied") : t("accounts.empty.copy")}
        onClick={() => { void copyText(command).then(ok => { if (ok) { setCopied(true); window.setTimeout(() => setCopied(false), 1500); } }); }}>
        <KitIcon name="copy" />
      </button>
    </div>
  );
}

/**
 * claude-swap not installed: a step not taken yet, said calmly rather than as
 * a fault (owner, 2026-11-11). What it does for the reader, then "Set up",
 * which shows the command and what comes after it. The steps stay in the page
 * while shut, so the button has something to point at.
 */
function CswapSetup({ hint }: { hint?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const stepsId = `${useId()}-steps`;
  return (
    <>
      <span className="ap-state-title">{t("accounts.empty.noCswap")}</span>
      <span className="ap-state-text">{t("accounts.empty.noCswapHint")}</span>
      <button type="button" className="btn primary ap-state-btn" aria-expanded={open} aria-controls={stepsId}
        onClick={() => setOpen(was => !was)}>
        {t("accounts.empty.setUp")}
      </button>
      <div className="ap-state-steps" id={stepsId} hidden={!open}>
        <span className="ap-state-text">{t("accounts.empty.noCswapAbout")}</span>
        {hint && <CommandBox command={hint} />}
        <span className="ap-state-text"><Rich text={t("accounts.empty.thenAdd")} /></span>
      </div>
    </>
  );
}

export default function AccountsEmptyState({ data, onAdd, onRetry, retrying = false, pressProps }: {
  data: Pick<AccountsData, "reason" | "hint" | "version" | "want">;
  /** Opens the sign-in dialog: the "No accounts" state's one button. */
  onAdd?: () => void;
  /** Reads the store again: the "Couldn't read" state's one button. */
  onRetry?: () => void;
  retrying?: boolean;
  /** The panel's request slot, so the retry is inert while another is out. */
  pressProps?: (key: string, busy?: boolean) => Record<string, unknown>;
}) {
  const t = useT();
  return (
    <div className="ap-empty ap-state">
      {/* The deck's own install, still running. Said as a wait rather
          than a fault, and with no command in it: the command belongs
          to `no_cswap`, where there is no install coming, and printed
          here it sent people to race a second installer against the
          one already running. */}
      {data.reason === "cswap_installing" ? (
        <>
          <span className="ap-state-title">{t("accounts.empty.installing")}</span>
          <span className="ap-state-text">{t("accounts.empty.installingHint")}</span>
        </>
      ) : data.reason === "no_cswap" ? (
        <CswapSetup hint={data.hint} />
      ) : data.reason === "cswap_refused" ? (
        <>
          {/* #1799: the deck installed claude-swap and a different version
              answered. The version that answered, the one asked for and the
              way to point the deck at another copy are said in the panel, not
              in a tooltip. No command is offered: the one that looks right
              does nothing for the deck's pinned install and is the wrong tool
              for a pipx one (cswap-install.mjs's upgrade step says why). */}
          <span className="ap-state-title">{t("accounts.empty.refusedTitle")}</span>
          <span className="ap-state-text">{t("accounts.empty.refused")}</span>
          <span className="ap-state-text">
            {t("accounts.empty.refusedHint", {
              answered: data.version ? t("accounts.empty.answeredVersion", { version: data.version }) : t("accounts.empty.answeredOther"),
              wanted: data.want ? t("accounts.empty.wanted", { want: data.want }) : "",
            })}
          </span>
        </>
      ) : data.reason === "no_accounts" ? (
        <>
          <span className="ap-state-title">{t("accounts.empty.none")}</span>
          <span className="ap-state-text">{t("accounts.empty.noneHint")}</span>
          {onAdd && <button type="button" className="btn primary ap-state-btn" onClick={onAdd}>{t("accounts.panel.addAccount")}</button>}
        </>
      ) : (
        <>
          <span className="ap-state-title">{t("accounts.empty.unreadable")}</span>
          <span className="ap-state-text">
            {t("accounts.empty.unreadableHint", { reason: plainReason(data.reason, t) ? t("accounts.empty.reason", { reason: plainReason(data.reason, t) }) : "" })}
          </span>
          {onRetry && (
            <button type="button" className="btn ap-state-btn" {...(pressProps?.("reload", retrying) ?? {})} onClick={onRetry}>
              {retrying ? t("accounts.panel.trying") : t("accounts.panel.tryAgainBtn")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
