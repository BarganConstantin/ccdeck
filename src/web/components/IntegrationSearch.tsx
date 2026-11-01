// The search field of an integration panel's list (#2178, #2179).
//
//   <IntegrationSearch value={q} onChange={setQ} label="Search issues by key or summary"
//     placeholder="Search key or summary" inputRef? onKeyDown? />
//
// One field for Jira and the forges, at the deck's control height, with the
// magnifier inside its start and a clear button inside its end once there is
// something to clear. Escape empties it first: while it has focus and text,
// it is the top entry on the deck's dismiss stack, so the detail and then the
// modal close only on the Escapes after that (the order is the same at every
// width). The placeholder is in --text-secondary, which stays at 4.5:1 on the
// field's fill in every theme where --muted did not. `label` is the accessible
// name; the placeholder is only a hint. Lay it out with flex: it grows from
// 220px and shrinks to nothing, so a panel sets only where it sits.
import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useT } from "../i18n";
import { modalStack } from "../modal-dismiss";
import { CrossGlyph, SearchGlyph } from "./integration-glyphs";

export default function IntegrationSearch({ value, onChange, label, placeholder, inputRef, onKeyDown }: {
  value: string;
  onChange: (value: string) => void;
  /** The field's accessible name: what it searches. */
  label: string;
  placeholder?: string;
  /** For a panel that moves focus here itself (a "/" shortcut, a picker that closed). */
  inputRef?: RefObject<HTMLInputElement>;
  /** A panel's own keys, e.g. Enter to open a pasted link. Escape is the field's. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const t = useT();
  const ownRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? ownRef;
  const [focused, setFocused] = useState(false);
  const clearing = focused && value !== "";
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!clearing) return;
    return modalStack.push(() => onChangeRef.current(""), 0, "popover");
  }, [clearing]);

  return (
    <div className="ig-search" data-filled={value !== "" || undefined}>
      <SearchGlyph />
      <input ref={ref} type="search" className="ig-search-input" aria-label={label} placeholder={placeholder}
        value={value} onChange={e => onChange(e.target.value)} onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} />
      {value !== "" && (
        <button type="button" className="glyph-btn ig-search-clear" aria-label={t("integrations.search.clearAria")} title={t("integrations.search.clear")}
          onClick={() => { onChange(""); ref.current?.focus(); }}>
          <CrossGlyph />
        </button>
      )}
    </div>
  );
}
