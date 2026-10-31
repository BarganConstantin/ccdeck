// Settings › Claude Code › All settings: every key Claude Code documents
// (src/server/claude-settings-index.json, scripts/claude-settings-index.mjs),
// to look up rather than to change.
//
// READ-ONLY ON PURPOSE. A wrong type in settings.json makes Claude Code skip
// the whole file, hooks and all, so only the short list above writes, and only
// values it has been taught. Here a key says what it is — topic, the kind of
// value it takes, the version that added it — and what the user file holds
// for it where that is safe to show, and links to Claude Code's reference for
// what it does: those words are Anthropic's, and the reference keeps them
// current.
//
// NOTHING UNTIL ASKED. With an empty filter the list is the keys the user's
// own file sets, which is the short answer to "what have I changed"; a filter
// searches all of them. While that file cannot be read the list says nothing
// of it, rather than calling it empty. The index is fetched with the section,
// not with the deck: it is some forty kilobytes nobody else reads.
import { useEffect, useId, useMemo, useState } from "react";
import { CLAUDE_SETTINGS_DOCS } from "../../server/claude-settings-catalog.mjs";
import { isEscapeKey } from "../modal-dismiss";
import { SettingRow, SettingsGroup } from "./SettingsParts";
import { t as tNow, useLanguage, useT, type TFunction } from "../i18n";

export interface IndexedKey {
  key: string;
  topic: string | null;
  scope: string | null;
  kind: "boolean" | "choice" | "number" | "text" | "structured";
  options?: string[];
  default: string | null;
  since: string | null;
  anchor: string;
}

/** How many rows a filter shows before it asks for more letters. */
export const INDEX_LIMIT = 40;

const KIND_KEY: Record<IndexedKey["kind"], string> = {
  boolean: "settings.claudeIndex.kind.boolean", choice: "settings.claudeIndex.kind.choice", number: "settings.claudeIndex.kind.number",
  text: "settings.claudeIndex.kind.text", structured: "settings.claudeIndex.kind.structured",
};

/** The line under a key: where it lives, what it takes, since when. */
export function indexNote(entry: IndexedKey, t: TFunction = tNow): string {
  const where = entry.scope === "Global config" ? t("settings.claudeIndex.globalConfig")
    : entry.scope === "Managed" ? t("settings.claudeIndex.managedOnly") : null;
  return [entry.topic, t(KIND_KEY[entry.kind]), where, entry.since ? t("settings.claudeIndex.since", { since: entry.since }) : null].filter(Boolean).join(" · ");
}

/** The keys a filter matches, in the reference's order: by name first, then
 *  by topic, so "memory" lists autoMemoryEnabled before the topic's others. */
export function matchKeys(keys: readonly IndexedKey[], query: string): IndexedKey[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byName = keys.filter(k => k.key.toLowerCase().includes(q));
  const byTopic = keys.filter(k => !byName.includes(k) && (k.topic ?? "").toLowerCase().includes(q));
  return [...byName, ...byTopic];
}

let loaded: Promise<IndexedKey[]> | null = null;
const loadIndex = () => (loaded ??= import("../../server/claude-settings-index.json").then(m => m.default.keys as IndexedKey[]));

/** `present` is null while the user's settings.json cannot be read, and
 *  `noFile` says it is not there at all. */
export default function ClaudeSettingsIndex({ present, noFile = false }: { present: Record<string, string> | null; noFile?: boolean }) {
  const t = useT();
  const language = useLanguage();
  const [keys, setKeys] = useState<IndexedKey[] | null>(null);
  const [query, setQuery] = useState("");
  const filterId = useId();
  useEffect(() => {
    let live = true;
    loadIndex().then(k => { if (live) setKeys(k); }, () => { loaded = null; });
    return () => { live = false; };
  }, []);

  const rows = useMemo(() => {
    if (!keys) return [];
    if (query.trim()) return matchKeys(keys, query);
    if (!present) return [];
    // The user's own keys, in the reference's order, and any it does not
    // document after them: a key Claude Code dropped, or a typo.
    const known = keys.filter(k => Object.hasOwn(present, k.key));
    const unknown = Object.keys(present).filter(name => !keys.some(k => k.key === name)).sort()
      .map((key): IndexedKey => ({ key, topic: tNow("settings.claudeIndex.notInRef"), scope: null, kind: "structured", default: null, since: null, anchor: "" }));
    return [...known, ...unknown];
  }, [keys, present, query, language]);
  const shown = rows.slice(0, INDEX_LIMIT);
  const searching = query.trim() !== "";

  return (
    <SettingsGroup
      id="claude-group-all"
      settingId="claude-all-settings"
      title={t("settings.claudeIndex.title")}
      note={searching ? undefined : present && !noFile
        ? t("settings.claudeIndex.notePresent")
        : t("settings.claudeIndex.noteAll")}
      aside={keys ? <span className="settings-caption-count">{keys.length}</span> : undefined}
      list={false}
    >
      <div className="settings-filter">
        <label className="vis-hidden" htmlFor={filterId}>{t("settings.claudeIndex.filterLabel")}</label>
        <input
          id={filterId}
          type="search"
          className="settings-filter-field"
          placeholder={keys ? t("settings.claudeIndex.filterCount", { count: keys.length }) : t("settings.claudeIndex.filter")}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (isEscapeKey(event.key) && query) { event.stopPropagation(); setQuery(""); }
          }}
        />
      </div>
      {shown.length > 0 && (
        <div className="settings-list settings-keys">
          {shown.map(entry => {
            const value = present && Object.hasOwn(present, entry.key) ? present[entry.key] : null;
            return (
              <SettingRow
                key={entry.key}
                as="div"
                name={<code className="claude-key">{entry.key}</code>}
                note={indexNote(entry, t)}
                control={
                  <>
                    {value !== null && <span className="settings-read" title={t("settings.claudeIndex.inFile")}>{value}</span>}
                    {entry.anchor && (
                      <a className="settings-link" href={`${CLAUDE_SETTINGS_DOCS}#${entry.anchor}`} target="_blank" rel="noreferrer"
                        aria-label={t("settings.claudeIndex.referenceAria", { key: entry.key })}>{t("settings.claudeIndex.reference")}</a>
                    )}
                  </>
                }
              />
            );
          })}
        </div>
      )}
      {searching && rows.length === 0 && keys && <p className="settings-empty" role="status">{t("settings.claudeIndex.noMatch", { query: query.trim() })}</p>}
      {rows.length > INDEX_LIMIT && <p className="settings-foot" role="status">{t("settings.claudeIndex.more", { count: rows.length - INDEX_LIMIT })}</p>}
      {!searching && present && !noFile && keys && rows.length === 0 && <p className="settings-empty">{t("settings.claudeIndex.empty")}</p>}
    </SettingsGroup>
  );
}
