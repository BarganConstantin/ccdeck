import { useEffect, useRef, useState } from "react";
import type { ToolCall } from "../types";
import { useModalDismiss } from "./use-modal-dismiss";
// The row that opens this dialog printed the same milliseconds one decimal
// place coarser, so a 1.24s tool read "1.2s" there and "1.24s" here (#374).
// One function now; the sentinel below is the only thing that still differs.
import { toolDuration } from "../duration";
import { copyText } from "../copy-text";
// What a call IS rather than its JSON (#816): an Edit as a change, a Bash call
// as its command and output, a Read or Write as a file and its text, anything
// else as its values with real newlines. See tool-view.ts.
import { clip, copyOf, linesOf, toolView, type Block } from "../tool-view";

export default function ToolModal({
  tool,
  onClose,
}: {
  tool: ToolCall;
  onClose: () => void;
}) {
  // No focusRef: the × is the first control in the dialog, so the hook's own
  // default — the first tabbable — already lands there. What this modal was
  // missing is the ref below, without which there is no boundary to hold Tab
  // inside and the claim on the surface tag is a claim about nothing.
  const dialogRef = useModalDismiss(onClose);

  const status =
    tool.endedAt == null ? "inflight"
    : tool.ok === false  ? "err"
    :                       "done";

  // The full payloads while the reducer still holds them, the previews once it
  // has released them (see `trimmed` below).
  const input = tool.input ?? tool.inputPreview;
  const response = tool.response ?? tool.errorPreview;
  const view = toolView(tool.name, input, response);

  return (
    // The scrim is the dismiss gesture, not the dialog: with role="dialog" on
    // it, a screen reader drew the boundary around the click-to-close backdrop
    // and announced an unnamed "dialog", because neither element carried a
    // name. The name is the tool, which is the only thing that tells one of
    // these apart from the next.
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="tool-modal-title">
        <header className="modal-head">
          <div className="modal-title">
            {/* Decoration, and marked as such (#373). This dot keeps its hue
                and gains no mark, because unlike the row in the tool list this
                dialog already carries all three states in words: the duration
                reads `in-flight…` while a call is open, the Response section is
                tagged `error` when it failed, and done is the one that is
                neither. The dot reinforces that; it is not the only channel. */}
            <span className={`status-dot ${status}`} aria-hidden />
            <span id="tool-modal-title" className="modal-tool-name">{tool.name}</span>
            <span className="modal-tool-id" title={tool.id}>{tool.id.slice(0, 12)}…</span>
          </div>
          <div className="modal-actions">
            <span className="modal-dur">{toolDuration(tool, "in-flight…")}</span>
            <button className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body">
          {tool.trimmed && (
            <div className="modal-section">
              <p className="modal-note">
                Full payloads for this call were released to keep memory bounded — only
                the previews below are still held.
              </p>
            </div>
          )}
          <div className="modal-section">
            <div className="tm-head">
              <h4>Input</h4>
              <CopyButton text={copyOf(tool.name, "input", input)} what="input" />
            </div>
            {view.input.map((b, n) => <ToolBlock key={n} block={b} />)}
          </div>
          <div className="modal-section">
            <div className="tm-head">
              <h4>Response {status === "err" && <span className="err-tag">error</span>}</h4>
              {tool.endedAt != null && <CopyButton text={copyOf(tool.name, "response", response)} what="response" />}
            </div>
            {tool.endedAt == null
              ? <pre>(waiting…)</pre>
              : view.response.map((b, n) => <ToolBlock key={n} block={b} />)}
          </div>
        </section>
      </div>
    </div>
  );
}

/** A diff line's side, spelled out so every class this file draws is a
 *  literal the stylesheet can be checked against. */
const TONE_CLASS = { del: "tm-del", add: "tm-add", ctx: "tm-ctx" } as const;

/**
 * One block of a call. A labelled value that fits on a line is drawn as one;
 * anything longer sits in a well, a change coloured by side, and is held to
 * the clip budget until "show all" — a response can run to 95,000 characters.
 */
function ToolBlock({ block }: { block: Block }) {
  const [open, setOpen] = useState(false);
  if (block.inline) {
    return (
      <p className="tm-inline">
        {block.label && <span className="tm-label">{block.label}</span>}
        <code>{block.text}</code>
      </p>
    );
  }
  const { shown, cut } = clip(linesOf(block), open);
  return (
    <div className="tm-block">
      {block.label && <span className="tm-label">{block.label}</span>}
      <pre className={block.err ? "tm-err" : undefined}>
        {block.lines
          ? shown.map((l, n) => (
              <span key={n} className={l.tone ? TONE_CLASS[l.tone] : undefined}>
                {l.text}{n < shown.length - 1 ? "\n" : ""}
              </span>
            ))
          : shown.map(l => l.text).join("\n")}
      </pre>
      {cut && <button type="button" className="btn tm-more" onClick={() => setOpen(true)}>show all</button>}
    </div>
  );
}

/**
 * Copies what copyOf chose for this side — the command, the output, the file's
 * text, or the raw payload — and reads `copied` for a moment after it lands. A
 * copy that fails leaves the text on screen to select by hand.
 */
function CopyButton({ text, what }: { text: string; what: "input" | "response" }) {
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  return (
    <button type="button" className="btn tm-copy" disabled={!text}
      aria-label={copied ? `The ${what} was copied` : `Copy the ${what}`}
      onClick={() => void copyText(text).then(ok => {
        if (!ok || !alive.current) return;
        setCopied(true);
        window.setTimeout(() => { if (alive.current) setCopied(false); }, 1_600);
      })}>
      {copied ? "copied" : "copy"}
    </button>
  );
}
