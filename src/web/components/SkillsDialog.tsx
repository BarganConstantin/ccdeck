// The skills a Claude Code session's project can use, read-only: opened from
// the foot of the Skills list in the Context tab (ContextSnapshot.tsx). Each
// one says where it is installed and whether the session's last /context
// listed it (loaded, with its tokens) or not (installed). A search keeps the
// ones whose name or description holds it; a row opens the skill's detail in
// the same dialog: its description as plain text and its SKILL.md's path. The
// SKILL.md's body is never asked for.
//
// Portalled to the body, as the memory file viewer is: the Inspector can be a
// sheet with a transform, which would give the fixed scrim the sheet's box.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { currentLanguage, useT } from "../i18n";
import { copyText } from "../copy-text";
import {
  filterSkills, readSessionSkills, SKILL_SOURCE_KEYS, skillInventory, unnamedLoadedSkills, type SkillRow, type SkillsRead,
} from "../context-inventory";
import { snapTokens } from "../context-snapshot";
import type { ContextSnapshot } from "../types";
import { Dialog, DialogHeader } from "./Dialog";
import { SearchGlyph } from "./integration-glyphs";
import { KitIcon } from "./kit-icons";
import { Loader } from "./Loader";
import PathText from "./PathText";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";

const fmtN = (n: number): string => n.toLocaleString(currentLanguage());

export default function SkillsDialog({ session, snapshot, onClose }: {
  session: string;
  /** The session's last /context, which says which skills are loaded. */
  snapshot: ContextSnapshot | null;
  onClose: () => void;
}) {
  const t = useT();
  // No focusRef: the × is the first control, where the hook starts. Escape and
  // the focus back on the button that opened it are the hook's too.
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const [read, setRead] = useState<SkillsRead | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  const backRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // The row the detail was opened from, which takes focus again on the way back.
  const from = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setRead(null);
    void readSessionSkills(session, undefined, controller.signal).then(answer => {
      if (!controller.signal.aborted) setRead(answer);
    });
    return () => controller.abort();
  }, [session]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const rows = useMemo(() => (read?.kind === "ready" ? skillInventory(read.skills, snapshot) : []), [read, snapshot]);
  const shown = filterSkills(rows, query);
  const skill = selected ? rows.find(r => r.key === selected) ?? null : null;

  // Into the detail, focus goes to its way back; out of it, to the row it came from.
  useEffect(() => {
    if (skill) { backRef.current?.focus(); return; }
    const key = from.current;
    if (!key) return;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []).find(el => el.dataset.key === key);
    row?.focus();
  }, [skill?.key]);

  const open = (key: string) => { from.current = key; setCopied(false); setSelected(key); };
  const back = () => setSelected(null);
  const source = (row: SkillRow): string => row.source === "other" ? row.sourceText ?? "" : t(SKILL_SOURCE_KEYS[row.source]);
  const state = (row: SkillRow): string => !row.loaded
    ? t("insights.context.skills.installed")
    : row.tokens !== undefined ? t("insights.context.skills.loadedTokens", { tokens: snapTokens(row.tokens) }) : t("insights.context.skills.loaded");
  const copy = (path: string) => void copyText(path).then(ok => {
    if (!ok || !alive.current) return;
    setCopied(true);
    window.setTimeout(() => { if (alive.current) setCopied(false); }, 1_600);
  });

  const ready = read?.kind === "ready";
  const unnamed = unnamedLoadedSkills(snapshot);
  const count = !ready ? undefined
    : shown.length === rows.length ? fmtN(rows.length)
      : t("insights.context.skills.countOf", { shown: fmtN(shown.length), n: fmtN(rows.length) });

  return createPortal(
    <Dialog scrim={scrimPress} dialogRef={dialogRef} className="ctx-inventory" labelledBy="skills-dialog-title">
      <DialogHeader titleId="skills-dialog-title" title={t("insights.context.skills.title")} note={skill ? undefined : count}
        onClose={onClose} closeLabel={t("insights.audit.closeEsc")} />
      {skill ? (
        <div className="modal-body inv-body">
          <button ref={backRef} type="button" className="btn ctx-snap-act inv-back" onClick={back}>
            <KitIcon name="chevron-left" />{t("insights.context.skills.all")}
          </button>
          <div className="inv-detail">
            <h3 className="inv-detail-name">{skill.name}</h3>
            <p className="inv-detail-meta">{[source(skill), state(skill)].filter(Boolean).join(" · ")}</p>
            <p className="inv-detail-desc" data-empty={!skill.description || undefined}>
              {skill.description || t("insights.context.skills.noDescription")}
            </p>
            {skill.path && <PathText className="inv-detail-path" path={skill.path} keep={2} />}
          </div>
        </div>
      ) : (
        <div className="modal-body inv-body">
          {ready && rows.length > 0 && (
            <label className="inv-search">
              <SearchGlyph />
              <input type="search" value={query} aria-label={t("insights.context.skills.search")} placeholder={t("insights.context.skills.search")}
                onChange={e => setQuery(e.currentTarget.value)} />
            </label>
          )}
          {ready && unnamed > 0 && <p className="inv-note">{t("insights.context.skills.unnamed", { n: fmtN(unnamed) })}</p>}
          {ready && read.truncated && <p className="inv-note">{t("insights.context.skills.truncated", { n: fmtN(rows.length) })}</p>}
          {!ready ? (
            <p className="inv-state" role="status">
              {read === null && <Loader />}
              <span>{t(read === null ? "insights.context.skills.loading" : "insights.context.skills.failed")}</span>
            </p>
          ) : rows.length === 0 ? (
            <p className="inv-state">{t("insights.context.skills.none")}</p>
          ) : shown.length === 0 ? (
            <p className="inv-state" role="status">{t("insights.context.skills.noMatch", { query: query.trim() })}</p>
          ) : (
            <ul className="inv-list" ref={listRef}>
              {shown.map(row => (
                <li key={row.key}>
                  <button type="button" className="ctx-md-open inv-row" data-key={row.key} onClick={() => open(row.key)}>
                    <span className="inv-row-top">
                      <span className="inv-row-name">{row.name}</span>
                      <span className="inv-row-state">{state(row)}</span>
                    </span>
                    <span className="inv-row-sub">{[source(row), row.description].filter(Boolean).join(" · ")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <footer className="modal-foot">
        <span className="mf-readonly">{t("insights.context.memory.readOnly")}</span>
        {skill?.path && (
          <button type="button" className="btn" onClick={() => copy(skill.path!)} data-copied={copied || undefined}>
            {t(copied ? "insights.context.memory.copied" : "insights.context.memory.copyPath")}
          </button>
        )}
      </footer>
    </Dialog>,
    document.body,
  );
}
