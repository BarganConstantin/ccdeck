import { useMemo, useState, type ReactNode } from "react";

export type Json = null | string | number | boolean | Json[] | { [key: string]: Json };

type Mode = "tree" | "raw";
const BATCH_SIZE = 50;
const HIGHLIGHT_LIMIT = 200_000;

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
  const array = Array.isArray(value);
  // Enumerate keys, never values: closed branches must not walk their children.
  const keys = useMemo(() => Array.isArray(value) ? null : Object.keys(value), [value]);
  const count = array ? value.length : keys!.length;
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
        const key = keys ? keys[index] : index;
        const child = Array.isArray(value) ? value[index] : value[key];
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
  return <div>
    <div className="tr-detail-tabs" role="group" aria-label="JSON view">
      <button type="button" className="btn" aria-pressed={mode === "tree"} onClick={() => setMode("tree")}>Tree</button>
      <button type="button" className="btn" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw JSON</button>
    </div>
    {mode === "raw" ? <RawJson value={value} /> : <div className="tr-value tr-json-tree"><JsonNode value={value} root /></div>}
  </div>;
}
