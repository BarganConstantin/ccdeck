// Release selection and seen-state stay upstream; this sheet only presents them.
import { useEffect, useId, useState } from "react";
import { compareVersions, groupReleaseNotes, presentReleaseNotes, splitNoteTitle, versionRangeLabel, isVersion, type ReleaseNote, type VersionNotes } from "../release-notes";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { parseInline, type Inline } from "../inline-markdown";
import { RESTART_TO_UPDATE } from "../desktop-update";
import ReleaseActions, { useReleaseUpdateCheck, type UpdateCheckWiring, RESTART_WHY } from "./ReleaseActions";
import { ownRow } from "../own-row";
import AnchoredPopover from "./AnchoredPopover";
import { AccountsGlyph, SessionListGlyph, SkillActivityGlyph, UpdateCheckGlyph, RestartGlyph } from "./rail-glyphs";

interface Props {
  entries: VersionNotes[];
  since: string | null;
  running: string | null;
  firstRun: boolean;
  onClose: () => void;
  onTour?: () => void;
  updateVersion?: string;
  updateBusy?: boolean;
  onUpdateRestart?: () => void;
  updateFailure?: string;
  onRestart?: () => void;
  updateCheck?: UpdateCheckWiring;
}

export default function ReleaseNotesModal({ entries, since, running, firstRun, onClose, onTour, updateVersion, updateBusy, onUpdateRestart, updateFailure, onRestart, updateCheck }: Props) {
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const id = useId();
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  const update = useReleaseUpdateCheck(updateCheck);
  const updating = update?.state.line.action?.kind === "install" || update?.state.line.action?.kind === "npx";
  const canRestart = onRestart && !updateVersion && !updating;
  const { latest, visiblePrevious, history } = presentReleaseNotes(entries, since !== null);
  const historyId = `${id}-history`;
  const hasMenu = !!canRestart || (!!update?.state.canCheck && !updateVersion);
  // A new available update can remove the menu's last action while it is open.
  useEffect(() => { if (!hasMenu) setMenu(null); }, [hasMenu]);
  const range = isVersion(running) ? `v${running}` : versionRangeLabel(entries.slice(0, 1));
  const earlier = running && entries[0] && compareVersions(entries[0].version, running) < 0;
  const context = earlier ? `Running v${running}. Earlier release notes are shown below.`
    : firstRun && running ? `New in v${running}.`
    : since ? `Changes since v${since}.` : null;

  return <div className="modal-backdrop" {...scrimPress} role="presentation">
    <div ref={dialogRef} className="modal release-notes" id={`${id}-dialog`} onClick={e => e.stopPropagation()}
      role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <header className="modal-head">
        <div className="modal-title">
          <span id={`${id}-title`} className="modal-tool-name">What&apos;s new</span>
          {range && <span className="modal-tool-id">{range}</span>}
        </div>
        <div className="modal-actions">
          {hasMenu && <button id={`${id}-options`} type="button" className="glyph-btn" aria-label="More options"
            aria-haspopup="menu" aria-expanded={menu !== null} aria-controls={menu ? `${id}-menu` : undefined}
            onClick={() => setMenu(menu ? null : "first")}
            onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setMenu(e.key === "ArrowUp" ? "last" : "first"); } }}>
            <svg className="glyph" viewBox="0 0 14 14" width="14" height="14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="7" r="1"/><circle cx="7" cy="7" r="1"/><circle cx="11" cy="7" r="1"/></svg>
          </button>}
          <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
        </div>
      </header>
      <span className="rn-live-status" role="status">{updateVersion ? `ccdeck v${updateVersion} is downloaded and verified.` : update?.state.line.said}</span>
      <section className="modal-body" role="region" aria-label="Release notes" tabIndex={0}>
        {updateVersion ? <div className="rn-ready">
          <p>ccdeck v{updateVersion} is downloaded and verified.</p>
          <p className="rn-update-said" role="status">{updateFailure}</p>
        </div> : <>{update?.needsAttention && <ReleaseActions update={update} />}
          <p className="rn-update-said" role="status">{updateFailure}</p></>}
        {context && <p className="rn-context">{context}</p>}
        {!entries.some(entry => entry.notes.length > 0) && <p className="rn-empty">No release notes for this build.</p>}
        {latest && <ReleaseSection key={latest.version} entry={latest} showVersion={since !== null && entries.length > 1} />}
        {visiblePrevious.length > 0 && <section className="rn-upgrade-history" aria-label="Earlier changes in this upgrade">
          <h2 className="rn-group-title">Earlier in this upgrade</h2>
          {visiblePrevious.map(entry => <ReleaseSection key={entry.version} entry={entry} showVersion />)}
        </section>}
        {history.length > 0 && <details className="rn-history">
          <summary aria-controls={historyId}>{since !== null ? "Other changes in this upgrade" : "Previous releases"}</summary>
          <div id={historyId}>{history.map(entry => <ReleaseSection key={entry.version} entry={entry} showVersion />)}</div>
        </details>}
      </section>
      <footer className="rn-footer">
        <div className="rn-footer-links">
          <a href="https://ccdeck.dev/changelog/" target="_blank" rel="noopener noreferrer" aria-label="Full changelog (opens in a new tab)">Full changelog</a>
          {onTour && !updateVersion && <button className="rn-text-button" type="button" onClick={onTour}>Take the tour</button>}
        </div>
        {updateVersion && onUpdateRestart ? <button className="btn primary" type="button" onClick={onUpdateRestart} aria-busy={updateBusy || undefined}>
          {updateBusy ? "Restarting…" : RESTART_TO_UPDATE}
        </button> : <button className="btn primary" type="button" onClick={onClose}>Done</button>}
      </footer>
      {menu && hasMenu && <AnchoredPopover anchorId={`${id}-options`} portalRootId={`${id}-dialog`} id={`${id}-menu`}
        role="menu" labelledBy={`${id}-options`} start={menu} className="ap-pop rn-options-menu" onClose={() => setMenu(null)}>
        {update && <p className="rn-menu-status" id={`${id}-check-status`}>{update.state.line.said}
          {update.state.line.age && <span>{update.state.line.age}</span>}
        </p>}
        {update?.state.canCheck && <button type="button" className="ap-menu-item rn-act" role="menuitem"
          title={update.checkWhy} aria-describedby={`${id}-check-status`} aria-busy={update.state.checking || undefined}
          onClick={() => void update.check()}><UpdateCheckGlyph />Check for updates</button>}
        {update?.state.canCheck && canRestart && <div className="rn-menu-separator" role="separator" />}
        {canRestart && <button type="button" className="ap-menu-item" role="menuitem" title={RESTART_WHY} aria-describedby={`${id}-restart-why`}
          onClick={() => { setMenu(null); onRestart?.(); }}><RestartGlyph />Restart ccdeck</button>}
        <span hidden id={`${id}-restart-why`}>{RESTART_WHY}</span>
      </AnchoredPopover>}
    </div>
  </div>;
}

function ReleaseSection({ entry, showVersion }: { entry: VersionNotes; showVersion: boolean }) {
  const { highlights, visible, more } = groupReleaseNotes(entry.notes);
  const moreId = useId();
  return <section className="rn-release">
    {showVersion && <h2 className="rn-version">v{entry.version}</h2>}
    {entry.summary && <h2 className="rn-summary">{entry.summary}</h2>}
    <ul className="rn-notes">
      {highlights.map((note, i) => <Note key={`h${i}`} note={note} highlight />)}
      {visible.map((note, i) => <Note key={`v${i}`} note={note} />)}
    </ul>
    {more.length > 0 && <details className="rn-more">
      <summary aria-controls={moreId}>More improvements <span>{more.length} {more.length === 1 ? "update" : "updates"}</span></summary>
      <ul className="rn-notes" id={moreId}>{more.map((note, i) => <Note key={i} note={note} />)}</ul>
    </details>}
  </section>;
}

const NOTE_ICONS = { plans: SessionListGlyph, accounts: AccountsGlyph, skills: SkillActivityGlyph };

function Note({ note, highlight }: { note: ReleaseNote; highlight?: boolean }) {
  const { rest } = splitNoteTitle(note.title);
  const Icon = note.icon ? ownRow(NOTE_ICONS, note.icon) : undefined;
  return <li className="rn-note" data-highlight={highlight || undefined} data-required={note.priority === "required" || undefined}>
    <div><h3 className="rn-note-title">{Icon && <span className="rn-title-icon" aria-hidden="true"><Icon /></span>}{rest.trimStart()}</h3>
      <p className="rn-note-body">{renderInline(parseInline(note.body))}</p>
      {note.notice && <p className="rn-note-notice"><strong>Important: </strong>{renderInline(parseInline(note.notice))}</p>}
    </div>
  </li>;
}

function renderInline(nodes: Inline[]): React.ReactNode[] {
  return nodes.map((n, i) => {
    if (n.kind === "text") return n.text;
    if (n.kind === "code") return <code key={i} className="rn-code">{n.text}</code>;
    return <strong key={i} className="rn-strong">{renderInline(n.kids)}</strong>;
  });
}
