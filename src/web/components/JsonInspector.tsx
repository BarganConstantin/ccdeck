import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { JsonViewer, type CustomNodeDefinition, type FilterFunction, type JsonViewerHandle, type ThemeInput } from "json-edit-react";

export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

type Mode = "tree" | "raw";
const BATCH_SIZE = 50;
const HIGHLIGHT_LIMIT = 200_000;
const SearchContext = createContext("");
const CollapseContext = createContext<{ revision: number; collapsed: boolean } | null>(null);
const viewerTheme: ThemeInput = {
  container: { backgroundColor: "transparent", color: "var(--text)", fontFamily: "var(--font-mono)", padding: "8px 0 8px 20px" },
  property: "var(--text)", string: "var(--ok)", number: "var(--accent)",
  boolean: "var(--accent)", null: "var(--text-secondary)",
  bracket: "var(--text-secondary)", itemCount: "var(--text-secondary)",
  iconCollection: "var(--text-secondary)", iconCopy: "var(--text-secondary)",
  collectionInner: { borderLeft: "1px solid var(--line)" },
  inputHighlight: "var(--ctl-fill)",
};
const wrapperKeys = new Set(["resourceLogs", "resourceMetrics", "resourceSpans", "scopeLogs", "scopeMetrics", "scopeSpans", "logRecords", "metrics", "spans"]);
const initialCollapse: FilterFunction = ({ path, level, size }) => {
  if (size !== null && size > BATCH_SIZE) return level > 0;
  if (level === 0) return false;
  return !path.every(key => typeof key === "number" || wrapperKeys.has(key));
};
// Keep large open collections paged; the library otherwise mounts every child.
const largeCollections: CustomNodeDefinition[] = [{
  condition: ({ size }) => size !== null && size > BATCH_SIZE,
  renderCollectionAsValue: true,
  component: ({ value }) => <JsonCollection value={value as Json[] | { [key: string]: Json }} root />,
}];

function JsonKey({ name }: { name: string | number }) {
  return <><span className="tr-json-key">{typeof name === "string" ? JSON.stringify(name) : name}</span>{": "}</>;
}

function JsonNode({ value, name, root = false }: { value: Json; name?: string | number; root?: boolean }) {
  if (value !== null && typeof value === "object") {
    return <JsonCollection value={value} name={name} root={root} />;
  }
  const kind = value === null ? "null" : typeof value;
  return <div>
    {name !== undefined && <JsonKey name={name} />}
    <span className={`tr-json-${kind}`}>{JSON.stringify(value)}</span>
  </div>;
}

function JsonCollection({ value, name, root }: { value: Json[] | { [key: string]: Json }; name?: string | number; root: boolean }) {
  const [expanded, setExpanded] = useState(root);
  const [limit, setLimit] = useState(BATCH_SIZE);
  const command = useContext(CollapseContext);
  useEffect(() => { if (command) setExpanded(!command.collapsed && root); }, [command, root]);
  const search = useContext(SearchContext).trim().toLowerCase();
  const array = Array.isArray(value);
  // Enumerate keys, never values: closed branches must not walk their children.
  const keys = useMemo(() => Array.isArray(value) ? null : Object.keys(value), [value]);
  const matches = useMemo(() => !search ? null : (keys ?? Array.from({ length: (value as Json[]).length }, (_, i) => i)).filter(key =>
    String(key).toLowerCase().includes(search) || JSON.stringify(Array.isArray(value) ? value[Number(key)] : value[key]).toLowerCase().includes(search)), [value, keys, search]);
  const count = matches ? matches.length : array ? value.length : keys!.length;
  const shown = Math.min(limit, count);
  return <details open={expanded} onToggle={event => {
    // Native toggle events from descendants must not change this branch.
    if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
  }}>
    <summary>
      {name !== undefined && <JsonKey name={name} />}
      <span>{array ? "[" : "{"}{count === 0 ? (array ? "]" : "}") : "…"}</span>
      {count > 0 && <span className="tr-count">{count} {array ? (count === 1 ? "item" : "items") : (count === 1 ? "key" : "keys")}</span>}
    </summary>
    {expanded && count > 0 && <div>
      {Array.from({ length: shown }, (_, index) => {
        const key = matches ? matches[index] : keys ? keys[index] : index;
        const child = Array.isArray(value) ? value[Number(key)] : value[key];
        return <JsonNode key={key} name={key} value={child} />;
      })}
      {shown < count && <button type="button" className="btn" onClick={() => setLimit(current => current + BATCH_SIZE)}>
        Show {Math.min(BATCH_SIZE, count - shown)} more ({count - shown} remaining)
      </button>}
      <div>{array ? "]" : "}"}</div>
    </div>}
  </details>;
}

function RawJson({ value }: { value: Json }) {
  const contents = useMemo(() => {
    const text = JSON.stringify(value, null, 2);
    if (text.length > HIGHLIGHT_LIMIT) return text;
    const parts: ReactNode[] = [];
    const tokens = /"(?:\\.|[^"\\])*"(\s*:)?|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g;
    let offset = 0;
    for (const match of text.matchAll(tokens)) {
      const index = match.index!;
      if (index > offset) parts.push(text.slice(offset, index));
      const token = match[0];
      const separator = match[1] || "";
      const kind = separator ? "key" : token[0] === '"' ? "string" : token === "null" ? "null" : token === "true" || token === "false" ? "boolean" : "number";
      parts.push(<span key={index} className={`tr-json-${kind}`}>{separator ? token.slice(0, -separator.length) : token}</span>);
      if (separator) parts.push(separator);
      offset = index + token.length;
    }
    if (offset < text.length) parts.push(text.slice(offset));
    return parts;
  }, [value]);
  return <pre className="tr-value">{contents}</pre>;
}

/** Inspect JSON without mounting closed descendants or truncating the raw value. */
export function JsonInspector({ value, initialMode = "tree" }: { value: Json; initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [search, setSearch] = useState("");
  const [copyError, setCopyError] = useState(false);
  const viewer = useRef<JsonViewerHandle>(null);
  const tree = useRef<HTMLDivElement>(null);
  const [collapseCommand, setCollapseCommand] = useState<{ revision: number; collapsed: boolean } | null>(null);
  // The read-only library marks its controls tabindex=-1. Keep native buttons
  // reachable with Tab as well as by mouse, including newly expanded branches.
  useEffect(() => {
    const root = tree.current;
    if (!root) return;
    const enableKeyboard = () => root.querySelectorAll<HTMLButtonElement>(".jer-editor-container button[tabindex='-1']").forEach(button => { button.tabIndex = 0; });
    enableKeyboard();
    const observer = new MutationObserver(enableKeyboard);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [mode, value]);
  return <div>
    <div className="tr-detail-tabs" role="group" aria-label="JSON view">
      <button type="button" className="btn" aria-pressed={mode === "tree"} onClick={() => setMode("tree")}>Tree</button>
      <button type="button" className="btn" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw JSON</button>
    </div>
    {mode === "raw" ? <RawJson value={value} /> : <>
      <div className="tr-json-tools">
        <label className="tr-json-search">Search JSON<input type="search" value={search} placeholder="Find a key or value…" onChange={event => setSearch(event.target.value)} /></label>
        <button type="button" className="btn" onClick={() => { setCollapseCommand(current => ({ revision: (current?.revision ?? 0) + 1, collapsed: true })); viewer.current?.collapse({ path: [], collapsed: true, includeChildren: true }); }}>Collapse all</button>
        <button type="button" className="btn" onClick={() => { setCollapseCommand(current => ({ revision: (current?.revision ?? 0) + 1, collapsed: false })); viewer.current?.collapse([{ path: [], collapsed: true, includeChildren: true }, { path: [], collapsed: false, includeChildren: false }]); }}>Open root</button>
      </div>
      <p className="tr-note">Copy a value with its copy button; hold ⌘ / Ctrl to copy its path.</p>
      {copyError && <p role="alert" className="tr-capture-error">Clipboard unavailable. Select the value and copy it manually.</p>}
      <SearchContext.Provider value={search}><CollapseContext.Provider value={collapseCommand}><div ref={tree} className="tr-value tr-json-tree">
        {value === null || typeof value !== "object" ? <JsonNode value={value} /> : <JsonViewer
          key={search ? "search" : "browse"} data={value} editorRef={viewer} theme={viewerTheme}
          rootName="" collapse={search ? false : initialCollapse} collapseAnimationTime={0}
          searchText={search || undefined} searchFilter={search ? "all" : undefined}
          searchDebounceTime={200} customNodeDefinitions={largeCollections}
          minWidth={0} maxWidth="100%" baseFontSize="inherit" indent={2}
          stringTruncateLength={300} showIconTooltips onCopy={({ success }) => setCopyError(!success)}
        />}
      </div></CollapseContext.Provider></SearchContext.Provider>
    </>}
  </div>;
}
