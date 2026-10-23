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
// searches all of them. The index is fetched with the section, not with the
// deck: it is some forty kilobytes nobody else reads.
import { useEffect, useId, useMemo, useState } from "react";
import { CLAUDE_SETTINGS_DOCS } from "../../server/claude-settings-catalog.mjs";
import { isEscapeKey } from "../modal-dismiss";
import { SettingRow, SettingsGroup } from "./SettingsParts";

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

const KIND_WORD: Record<IndexedKey["kind"], string> = {
  boolean: "on or off", choice: "a choice", number: "a number", text: "text", structured: "a list or object",
};

/** The line under a key: where it lives, what it takes, since when. */
export function indexNote(entry: IndexedKey): string {
  const where = entry.scope === "Global config" ? "kept in ~/.claude.json"
    : entry.scope === "Managed" ? "managed settings only" : null;
  return [entry.topic, KIND_WORD[entry.kind], where, entry.since ? `Claude Code ${entry.since}+` : null].filter(Boolean).join(" · ");
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

export default function ClaudeSettingsIndex({ present }: { present: Record<string, string> | null }) {
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
      .map((key): IndexedKey => ({ key, topic: "Not in Claude Code's reference", scope: null, kind: "structured", default: null, since: null, anchor: "" }));
    return [...known, ...unknown];
  }, [keys, present, query]);
  const shown = rows.slice(0, INDEX_LIMIT);
  const searching = query.trim() !== "";

  return (
    <SettingsGroup
      id="claude-group-all"
      settingId="claude-all-settings"
      title="All Claude Code settings"
      note={searching ? undefined : "The keys your settings.json sets. Filter to look up any of them, and open the reference for what each does."}
      aside={keys ? <span className="settings-caption-count">{keys.length}</span> : undefined}
      list={false}
    >
      <div className="settings-filter">
        <label className="vis-hidden" htmlFor={filterId}>Filter Claude Code settings</label>
        <input
          id={filterId}
          type="search"
          className="settings-filter-field"
          placeholder={keys ? `Filter ${keys.length} settings` : "Filter settings"}
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
                note={indexNote(entry)}
                control={
                  <>
                    {value !== null && <span className="settings-read" title="In your settings.json">{value}</span>}
                    {entry.anchor && (
                      <a className="settings-link" href={`${CLAUDE_SETTINGS_DOCS}#${entry.anchor}`} target="_blank" rel="noreferrer"
                        aria-label={`${entry.key} in Claude Code's settings reference`}>Reference</a>
                    )}
                  </>
                }
              />
            );
          })}
        </div>
      )}
      {searching && rows.length === 0 && keys && <p className="settings-empty" role="status">No setting matches “{query.trim()}”.</p>}
      {rows.length > INDEX_LIMIT && <p className="settings-foot" role="status">{rows.length - INDEX_LIMIT} more. Type more of the name to narrow the list.</p>}
      {!searching && present && keys && rows.length === 0 && <p className="settings-empty">Your settings.json sets nothing yet.</p>}
    </SettingsGroup>
  );
}
