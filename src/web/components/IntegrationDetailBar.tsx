// The top line of an item in an integration panel's detail (#2178, #2179).
//
//   <IntegrationDetailBar reference="acme/widgets#463" copyLabel="reference"
//     copyValue? href? openLabel="Open in GitHub" narrow={narrow} onClose={close} />
//   <IntegrationCopy value label />      the copy button on its own
//
// The forges' bar, promoted to the host so Jira's detail opens the same way:
// what the item is, copyable; where it lives on the provider ("Open in … ↗",
// a new tab); and Close. On a narrow screen the host's Back stands where Close
// would, so `narrow` drops it. A long reference gives way from its path and
// never from its number: "acme/very-long-name#463" shortens to
// "acme/very-lo…#463", and a Jira key is all number. The bar sticks to the
// top of the detail pane, edge to edge across the panel's padding, which a
// panel gives as --ig-detail-pad (20px unless it says otherwise).
import { useEffect, useState } from "react";
import { copyText } from "../copy-text";
import { useT, type TFunction } from "../i18n";
import { ExternalLinkGlyph } from "./action-glyphs";
import { CheckGlyph, CopyGlyph, CrossGlyph } from "./integration-glyphs";

/** The part of a reference that may shorten, and the part that may not. */
export function referenceParts(reference: string): { path: string; num: string } {
  const sigil = /^(.*?)([#!]\d+)$/.exec(reference);
  if (sigil) return { path: sigil[1], num: sigil[2] };
  if (/^[A-Z][A-Z0-9_]*-\d+$/.test(reference)) return { path: "", num: reference };
  return { path: reference, num: "" };
}

/** What is copied, in words: a known label ("key", "reference", "pipeline id")
 *  in the language on show; any other label comes back as written. */
function copyThing(t: TFunction, label: string): string {
  return label === "key" ? t("integrations.bar.thing.key")
    : label === "reference" ? t("integrations.bar.thing.reference")
    : label === "pipeline id" ? t("integrations.bar.thing.pipelineId") : label;
}

/** The provider link's words: "Open in GitHub" says its name in any language. */
function openText(t: TFunction, label: string): string {
  const named = /^Open in (.+)$/.exec(label);
  return named ? t("integrations.bar.openIn", { name: named[1] }) : label;
}

/** Copy, with a moment of "copied" after it lands. `label` names what is copied. */
export function IntegrationCopy({ value, label }: { value: string; label: string }) {
  const t = useT();
  const thing = copyThing(t, label);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <>
      <button type="button" className="glyph-btn ig-copy" data-done={done || undefined}
        aria-label={t("integrations.bar.copy", { thing })} title={done ? t("integrations.bar.copied") : t("integrations.bar.copy", { thing })}
        onClick={event => { event.stopPropagation(); void copyText(value).then(ok => setDone(!!ok)); }}>
        {done ? <CheckGlyph /> : <CopyGlyph />}
      </button>
      <span className="vis-hidden" role="status">{done ? t("integrations.bar.copiedThing", { thing: `${thing[0].toUpperCase()}${thing.slice(1)}` }) : ""}</span>
    </>
  );
}

export default function IntegrationDetailBar({ reference, context, copyValue, copyLabel, href, openLabel, narrow, onClose }: {
  /** What the item is: "acme/widgets#463", "group/project!5144", "PROJ-123". */
  reference: string;
  /** Optional project context; Copy still copies only the reference. */
  context?: string;
  /** What Copy puts on the clipboard, when it is not the reference itself. */
  copyValue?: string;
  /** What Copy copies, in words: "reference", "key", "pipeline id". */
  copyLabel: string;
  /** The item's own page on the provider, or null when it has none. */
  href: string | null;
  /** "Open in Jira", "Open in GitHub", "Open in GitLab". */
  openLabel: string;
  /** The host's Back stands in for Close. */
  narrow: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { path, num } = referenceParts(reference);
  return (
    <div className="ig-detail-bar">
      <span className="ig-ref">
        {context && <><span className="ig-ref-context" title={context}>{context}</span><span className="ig-ref-separator" aria-hidden>/</span></>}
        <code className="ig-ref-text" title={reference}>
          {path && <span className="ig-ref-path">{path}</span>}
          {num && <span className="ig-ref-num">{num}</span>}
        </code>
        <IntegrationCopy value={copyValue ?? reference} label={copyLabel} />
      </span>
      <span className="ig-detail-bar-end">
        {href && (
          <a className="ig-open" href={href} target="_blank" rel="noreferrer noopener">
            {openText(t, openLabel)}<ExternalLinkGlyph />
          </a>
        )}
        {!narrow && (
          <button type="button" className="glyph-btn ig-detail-close" aria-label={t("integrations.bar.closeDetails")} title={t("integrations.close")} onClick={onClose}>
            <CrossGlyph />
          </button>
        )}
      </span>
    </div>
  );
}
