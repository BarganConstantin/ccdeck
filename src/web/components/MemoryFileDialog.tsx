// One memory file, read-only: opened from a row of the Context tab's memory
// lists (ContextSnapshot.tsx's, loaded by Claude Code, and ContextView's, found
// on disk). The text is shown as plain text in a <pre> and nothing else: a
// memory file is the user's own instructions to the CLI, and drawing it as
// markup would run whatever it holds.
//
// Portalled to the body, as the share dialog is: the Inspector can be a sheet
// with a transform, which would give the fixed scrim the sheet's box.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { copyText } from "../copy-text";
import {
  fileName, MEMORY_SCOPE_KEYS, MEMORY_SOURCE_KEYS, readMemoryFile, type MemoryFileRead, type MemoryFileTarget,
} from "../memory-file";
import { Dialog, DialogHeader } from "./Dialog";
import { Loader } from "./Loader";
import PathText from "./PathText";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

export default function MemoryFileDialog({ target, session, provider, onClose }: {
  target: MemoryFileTarget;
  session: string;
  provider: "claude" | "codex";
  onClose: () => void;
}) {
  const t = useT();
  // No focusRef: the × is the first control, where the hook starts. Escape and
  // the focus back on the row that opened it are the hook's too.
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const [read, setRead] = useState<MemoryFileRead | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    const controller = new AbortController();
    setRead(null);
    void readMemoryFile(session, provider, target.path, undefined, controller.signal).then(answer => {
      if (!controller.signal.aborted) setRead(answer);
    });
    return () => controller.abort();
  }, [session, provider, target.path]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const file = read?.kind === "ready" ? read.file : null;
  // The answer's path is the one on disk; until it comes, the row's own.
  const path = file?.path ?? target.path;
  const where = [file ? t(MEMORY_SCOPE_KEYS[file.scope]) : "", t(MEMORY_SOURCE_KEYS[target.source])].filter(Boolean).join(" · ");
  const copy = () => void copyText(path).then(ok => {
    if (!ok || !alive.current) return;
    setCopied(true);
    window.setTimeout(() => { if (alive.current) setCopied(false); }, 1_600);
  });

  return createPortal(
    <Dialog scrim={scrimPress} dialogRef={dialogRef} className="memory-file" labelledBy="memory-file-title">
      <DialogHeader titleId="memory-file-title" title={fileName(target.path)} onClose={onClose} closeLabel={t("insights.audit.closeEsc")} />
      <div className="modal-body mf-body">
        <div className="mf-where">
          <PathText className="mf-path" path={path} keep={2} />
          <span className="mf-scope">{where}</span>
        </div>
        {file ? (
          <>
            {file.truncated && <p className="mf-note">{t("insights.context.memory.truncated")}</p>}
            <pre className="mf-text">{file.text}</pre>
          </>
        ) : (
          <p className="mf-state" role="status">
            {read === null && <Loader />}
            <span>{t(read === null ? "insights.context.memory.loading" : "insights.context.memory.failed")}</span>
          </p>
        )}
      </div>
      <footer className="modal-foot">
        <span className="mf-readonly">{t("insights.context.memory.readOnly")}</span>
        <button type="button" className="btn" onClick={copy} data-copied={copied || undefined}>
          {t(copied ? "insights.context.memory.copied" : "insights.context.memory.copyPath")}
        </button>
      </footer>
    </Dialog>,
    document.body,
  );
}
