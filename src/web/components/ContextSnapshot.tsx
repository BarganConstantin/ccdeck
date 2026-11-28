// What fills the window, as Claude Code's own /context last counted it: the
// Context tab's first block whenever the session has a snapshot (see
// src/server/context-snapshot.mjs for where it comes from, and
// context-snapshot.ts for the rows).
//
// One bar and one row per category, the deferred rows apart, then the lists
// /context printed behind closed disclosures, so the block stays as short as
// the estimate it replaces until someone opens one. A memory file's row opens
// it to read (MemoryFileDialog.tsx), through the view around this one, and the
// Skills list ends in a quiet "All skills" that opens what the project has
// installed (SkillsDialog.tsx), the same way.
import type { ReactNode } from "react";
import { currentLanguage, useT } from "../i18n";
import { formatPercent } from "../i18n/format";
import {
  CATEGORY_KEYS, categorySlug, listCount, mcpGroups, mcpToolCount, snapTokens, snapshotLayout, snapshotTime, type SnapRow,
} from "../context-snapshot";
import { shortAgo } from "../relative-time";
import { useNow } from "../use-now";
import type { ContextSnapshot, ContextSnapshotMore } from "../types";
import PathText from "./PathText";

const fmtN = (n: number): string => n.toLocaleString(currentLanguage());

/** A share of the window to one decimal, in the language's own way: "5.9%",
 *  "5,9 %". */
function pct1(n: number): string {
  try {
    return new Intl.NumberFormat(currentLanguage(), { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 100);
  } catch { return `${n.toFixed(1)}%`; }
}

export default function ContextSnapshotView({ snapshot, currentUsed, cwd, head = true, onOpenMemory, onOpenSkills }: {
  snapshot: ContextSnapshot;
  /** The tab's own estimate of what the session holds now; what it holds past
   *  the snapshot is drawn as "Since then". */
  currentUsed: number;
  cwd?: string;
  /** The "22% used · 130k / 600k" line over the bar. The Inspector leaves it
   *  out: its head prints the same figure (contextFill reads the snapshot). */
  head?: boolean;
  /** A memory file's row was pressed: its path as /context printed it, `~/` and all. */
  onOpenMemory: (path: string) => void;
  /** "All skills" at the foot of the Skills list was pressed. Left out, the
   *  list has no such button. */
  onOpenSkills?: () => void;
}) {
  const t = useT();
  // The foot says how old the snapshot is; half a minute is as fine as
  // "3m ago" needs.
  const now = useNow(30_000);
  const layout = snapshotLayout(snapshot, currentUsed);
  const name = (row: SnapRow): string => {
    if (row.id === "since") return t("insights.context.snap.since");
    if (row.id === "free") return t("insights.context.cat.free");
    const key = CATEGORY_KEYS[categorySlug(row.name)];
    return key ? t(key) : row.name;
  };
  const at = snapshotTime(snapshot);
  const ago = shortAgo(Math.max(0, now - at));

  return (
    <section className="ctx-window-row ctx-snap">
      {head && (
        <div className="ctx-snap-head">
          <span className="ctx-snap-used">{t("insights.context.snap.used", { pct: formatPercent(Math.round(layout.pct)) })}</span>
          <span className="ctx-snap-total" title={`${fmtN(layout.used)} / ${fmtN(layout.max)}`}>{`${snapTokens(layout.used)} / ${snapTokens(layout.max)}`}</span>
        </div>
      )}
      <div className="ctx-snap-bar" role="img" aria-label={t("insights.context.snap.bar")}>
        {layout.rows.filter(r => r.tone !== "free").map(r => (
          <span
            key={r.id}
            className="ctx-snap-seg"
            data-tone={r.tone}
            style={{ width: `${Math.min(100, (r.tokens / layout.max) * 100).toFixed(2)}%` }}
            title={`${name(r)}: ${snapTokens(r.tokens)}`}
          />
        ))}
      </div>
      <ul className="ctx-snap-rows">
        {layout.rows.map(r => <Row key={r.id} row={r} label={name(r)} title={r.id === "since" ? t("insights.context.snap.sinceTitle") : undefined} />)}
      </ul>
      {layout.deferred.length > 0 && (
        <ul className="ctx-snap-rows ctx-snap-deferred">
          {layout.deferred.map(r => <Row key={r.id} row={r} label={name(r)} pctTitle={t("insights.context.snap.deferredTitle")} />)}
        </ul>
      )}
      <Lists snapshot={snapshot} cwd={cwd} onOpenMemory={onOpenMemory} onOpenSkills={onOpenSkills} />
      <p className="ctx-window-note ctx-snap-foot" title={Number.isFinite(at) ? new Date(at).toLocaleString(currentLanguage()) : undefined}>
        {t(snapshot.estimated ? "insights.context.snap.fromEstimate" : "insights.context.snap.from", { ago })}
      </p>
    </section>
  );
}

/** One category: its swatch, its name, its tokens and its share of the window,
 *  or a dash for a deferred one, which is not in the window at all. */
function Row({ row, label, title, pctTitle }: { row: SnapRow; label: string; title?: string; pctTitle?: string }) {
  return (
    <li className="ctx-snap-row" title={title}>
      <span className="ctx-snap-key" data-tone={row.tone} aria-hidden="true" />
      <span className="ctx-snap-name">{label}</span>
      <span className="ctx-snap-tok" title={fmtN(row.tokens)}>{snapTokens(row.tokens)}</span>
      <span className="ctx-snap-pct" title={pctTitle}>{row.pct === null ? "—" : pct1(row.pct)}</span>
    </li>
  );
}

/** The lists /context printed, each behind a closed disclosure with its count:
 *  the MCP tools by server, the memory files, the custom agents, the skills.
 *  A list /context did not print is left out. A memory file's row is a button
 *  that opens the file; the skills end in one that opens the inventory. */
function Lists({ snapshot, cwd, onOpenMemory, onOpenSkills }: {
  snapshot: ContextSnapshot; cwd?: string; onOpenMemory: (path: string) => void; onOpenSkills?: () => void;
}) {
  const t = useT();
  const more = snapshot.more ?? {};
  const groups = mcpGroups(snapshot);
  const memory = snapshot.memory ?? [];
  const agents = snapshot.agents ?? [];
  const skills = snapshot.skills ?? [];
  return (
    <>
      {groups.length > 0 && (
        <List label={t("insights.context.cat.mcpTools")} count={mcpToolCount(snapshot)}>
          {groups.flatMap(g => [
            <li key={`s:${g.server}`} className="ctx-snap-group">
              <span className="ctx-snap-item">{g.server}</span>
              {/* A server with some tools loaded and the rest deferred says
                  so, "3 of 42 loaded": its figure is the three, not the 42. */}
              <span className="ctx-snap-meta">{g.tools.length > 0 && g.deferred > 0
                ? t("insights.context.snap.loadedOf", { loaded: fmtN(g.tools.length), n: fmtN(g.tools.length + g.deferred) })
                : t("insights.context.snap.tools", { count: g.tools.length + g.deferred, n: g.tools.length + g.deferred })}</span>
              {g.tools.length > 0
                ? <span className="ctx-md-size" title={g.deferred > 0 ? t("insights.context.snap.notLoaded", { tokens: snapTokens(g.tokens + g.deferredTokens) }) : fmtN(g.tokens)}>{snapTokens(g.tokens)}</span>
                : <span className="ctx-md-size" title={t("insights.context.snap.notLoaded", { tokens: snapTokens(g.deferredTokens) })}>{"—"}</span>}
            </li>,
            ...g.tools.map(tool => (
              <li key={`t:${g.server}:${tool.name}`} className="ctx-snap-sub">
                <span className="ctx-snap-item">{tool.name}</span>
                <span className="ctx-md-size" title={fmtN(tool.tokens)}>{snapTokens(tool.tokens)}</span>
              </li>
            )),
          ])}
          <More more={more.mcpTools} />
          <More more={more.mcpServers} />
        </List>
      )}
      {memory.length > 0 && (
        <List label={t("insights.context.cat.memory")} count={listCount(memory, more.memory)}>
          {memory.map(m => (
            <li key={`${m.type}:${m.path}`} title={m.type}>
              <button type="button" className="ctx-md-open" aria-haspopup="dialog" onClick={() => onOpenMemory(m.path)}>
                <PathText className="ctx-md-path" path={m.path} cwd={cwd} keep={2} />
                <span className="ctx-md-size" title={fmtN(m.tokens)}>{snapTokens(m.tokens)}</span>
              </button>
            </li>
          ))}
          <More more={more.memory} />
        </List>
      )}
      {agents.length > 0 && (
        <List label={t("insights.context.cat.agents")} count={listCount(agents, more.agents)}>
          {agents.map(a => (
            <li key={`${a.source}:${a.type}`}>
              <span className="ctx-snap-item">{a.type}</span>
              <span className="ctx-snap-meta">{a.source}</span>
              <span className="ctx-md-size" title={fmtN(a.tokens)}>{snapTokens(a.tokens)}</span>
            </li>
          ))}
          <More more={more.agents} />
        </List>
      )}
      {skills.length > 0 && (
        <List label={t("insights.context.cat.skills")} count={listCount(skills, more.skills)}
          action={onOpenSkills && { label: t("insights.context.skills.all"), open: onOpenSkills }}>
          {skills.map(s => (
            <li key={`${s.source}:${s.name}`}>
              <span className="ctx-snap-item">{s.name}</span>
              <span className="ctx-snap-meta">{s.source}</span>
              <span className="ctx-md-size" title={fmtN(s.tokens)}>{snapTokens(s.tokens)}</span>
            </li>
          ))}
          <More more={more.skills} />
        </List>
      )}
    </>
  );
}

/** A list behind a disclosure, closed until it is opened: the memory-file
 *  section's own toggle (ContextModal.tsx), so the two read alike. `action` is
 *  a quiet text button under the open list that opens a dialog: no row of its
 *  own while the list is closed. */
function List({ label, count, action, children }: {
  label: string;
  count: number;
  action?: { label: string; open: () => void };
  children: ReactNode;
}) {
  return (
    <details className="ctx-snap-list">
      <summary className="ctx-files-toggle">
        <span>{label}</span><span className="ctx-files-count">{fmtN(count)}</span>
      </summary>
      <ul className="ctx-md-list ctx-snap-items">{children}</ul>
      {action && (
        <button type="button" className="btn ctx-snap-act" aria-haspopup="dialog" onClick={action.open}>{action.label}</button>
      )}
    </details>
  );
}

/** The bounded list's last row: how many it folded away, and their tokens. */
function More({ more }: { more?: ContextSnapshotMore }) {
  const t = useT();
  if (!more || !(more.count > 0)) return null;
  return (
    <li className="ctx-snap-more">
      <span className="ctx-snap-item">{t("insights.context.snap.more", { count: more.count, n: fmtN(more.count) })}</span>
      <span className="ctx-md-size" title={fmtN(more.tokens)}>{snapTokens(more.tokens)}</span>
    </li>
  );
}
