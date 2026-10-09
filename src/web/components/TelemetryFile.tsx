import { useRef, useState } from "react";
import { parseTelemetryFile, type TelemetryFileRow } from "../telemetry-inspection";
export function TelemetryFile({ sessionFilter = "all", onSessions }: { sessionFilter?: string; onSessions?: (ids: string[]) => void }) {
  const [rows, setRows] = useState<TelemetryFileRow[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const request = useRef(0);
  const inspect = async (file: File | undefined) => {
    if (!file) return;
    const current = ++request.current;
    setError(""); setLoading(true); setCopied(false);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Choose a file smaller than 10 MB.");
      const contents = await file.text();
      const parsed = parseTelemetryFile(contents);
      if (current !== request.current) return;
      onSessions?.([...new Set(parsed.flatMap(row => row.sessionIds))]);
      setRows(parsed); setName(file.name); setSelected(null); setSearch("");
      if (!parsed.length) setError("This file is empty. Choose a JSON or JSONL telemetry file.");
    } catch (value) { if (current === request.current) setError(value instanceof Error ? value.message : "Could not read this file."); }
    finally { if (current === request.current) setLoading(false); }
  };
  const matches = rows.filter(row => (sessionFilter === "all" || (sessionFilter === "unidentified" ? !row.sessionIds.length : row.sessionIds.includes(sessionFilter))) && (!search || row.raw.toLowerCase().includes(search.toLowerCase())));
  const shown = matches.slice(0, 200);
  const chosen = selected === null ? shown[0] : matches.find(row => row.line === selected);
  return <div className="tr-file">
    <div className="tr-file-toolbar"><div><h3>Inspect a telemetry file</h3><p className="tr-note">Open a local JSON or JSONL file. It stays in your browser and is not uploaded.</p></div>
      <label className="btn tr-file-picker">{loading ? "Reading…" : name ? "Choose another file" : "Open file"}<input type="file" accept=".json,.jsonl,.ndjson,application/json" aria-label="Open telemetry file" onChange={e => { void inspect(e.target.files?.[0]); e.target.value = ""; }} /></label></div>
    {error && <p className="tr-capture-error" role="alert">{error}</p>}
    <div className="tr-workspace"><section className="tr-feed" aria-label="File records">
      <h3>{name || "File records"} <span className="tr-count">{matches.length}</span></h3>
      {rows.length > 0 && <input type="search" className="tr-input tr-search" aria-label="Search file contents" placeholder="Search contents…" value={search} onChange={e => { setSearch(e.target.value); setSelected(null); }} />}
      {shown.length ? <ul className="tr-connections">{shown.map(row => <li key={row.line}><button className="tr-message" aria-pressed={chosen?.line === row.line} onClick={() => { setSelected(row.line); setCopied(false); }}><span className="tr-event-top"><span>Line {row.line}</span><span className={!row.valid ? "tr-tone-enabled" : ""}>{row.valid ? "JSON" : "Invalid JSON"}</span></span><strong>{row.label}</strong>{row.timestamp && <span>{row.timestamp}</span>}<span>{row.sessionIds.join(", ") || "Unidentified session"}</span></button></li>)}</ul> : <div className="tr-empty-capture"><h4>{rows.length ? "No matching records" : "Your saved records, in one place"}</h4><p className="tr-note">{rows.length ? "Try another session or search." : "Choose a file to browse its rows and inspect the original JSON. A saved file is separate from live network capture."}</p></div>}
      {matches.length > shown.length && <p className="tr-note">Showing the first 200 matching rows. Search to narrow the list.</p>}
    </section><section className="tr-inspector" aria-label="File record contents">
      {chosen ? <><div className="tr-feed-head"><h3>Line {chosen.line}</h3><button className="btn" onClick={() => { navigator.clipboard.writeText(chosen.raw).then(() => setCopied(true), () => setError("Clipboard unavailable. Select the JSON and copy it manually.")); }}>{copied ? "Copied" : "Copy JSON"}</button></div><p className="tr-note">Original file contents. This does not prove the record was sent or received.</p><pre className="tr-value">{chosen.raw}</pre></> : <div className="tr-inspector-empty"><h3>Inspect a record</h3><p className="tr-note">Select a row to read its original contents.</p></div>}
    </section></div>
  </div>;
}
