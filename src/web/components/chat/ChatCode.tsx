// A code block in Chat: a slim band with its language and a Copy button over
// the code, coloured by chat-highlight.ts when the language is one it reads.
// Copy says "Copied" for COPIED_MS, and a screen reader hears it once.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useT } from "../../i18n";
import { copyText } from "../../copy-text";
import { CopyGlyph } from "../terminal/stage-icons";
import { highlight, languageOf, type HighlightLanguage, type Token } from "./chat-highlight";
import "./chat-rich.css";

/** How long Copy says Copied. */
export const COPIED_MS = 1500;

/** Tokens as spans of their kind; plain text as text. */
export function tokenNodes(tokens: readonly Token[]): ReactNode[] {
  return tokens.map((token, i) => (token.kind ? <span key={i} className={`hl-${token.kind}`}>{token.text}</span> : token.text));
}

/** The code, coloured when its language is known and it is not too long to colour quickly. */
export function HighlightedCode({ code, language }: { code: string; language: HighlightLanguage | null }) {
  const tokens = useMemo(() => (language ? highlight(code, language) : null), [code, language]);
  return <>{tokens ? tokenNodes(tokens) : code}</>;
}

/** A Copy button that says Copied for a moment, and says it once to a screen reader. */
export function CopyButton({ text, label, className }: { text: string; label: string; className: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return <>
    <button type="button" className={className} aria-label={copied ? t("board.stage.copied") : label} title={label}
      data-copied={copied || undefined} onClick={() => { void copyText(text).then(ok => setCopied(ok)); }}>
      <CopyGlyph /><span className="chat-copy-word" aria-hidden="true">{t(copied ? "board.stage.copied" : "board.stage.copy")}</span>
    </button>
    <span className="chat-sr" role="status" aria-live="polite">{copied ? t("board.stage.copied") : ""}</span>
  </>;
}

/** One fenced block: the band, then the code, scrolled sideways inside itself. */
export default function ChatCode({ code, language }: { code: string; language?: string }) {
  const t = useT();
  const known = languageOf(language);
  return (
    <div className="chat-code" data-language={known ?? undefined}>
      <div className="chat-code-head">
        <span className="chat-code-lang">{language ?? ""}</span>
        {code.trim() && <CopyButton text={code.replace(/\r?\n$/, "")} label={t("board.chat.rich.copyCode")} className="chat-code-copy" />}
      </div>
      <pre><code data-language={language || undefined}><HighlightedCode code={code} language={known} /></code></pre>
    </div>
  );
}
