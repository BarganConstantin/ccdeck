// Search in Settings (#2176): the field at the top of the nav, and the list of
// matching settings that stands in the pane while it holds a query. The index
// and the ranking are settings-search.ts; SettingsModal.tsx owns the query and
// what a chosen result does.
//
// A COMBOBOX, WITH THE RESULTS AS ITS LISTBOX. Up and Down move a highlight
// through the results while focus stays in the field (aria-activedescendant),
// rather than walking real focus onto each result. Three reasons, each of
// which the other way gets wrong. The reader keeps typing: a letter pressed
// with focus on a result would be lost, or — since the dialog answers T on
// anything that is not a field — would change the theme. Escape keeps its two
// meanings in one place: it empties the field, and pressed again it closes
// Settings, which a result holding focus could not tell apart. And a screen
// reader hears the field, the count and the highlighted result as one control,
// the pattern every platform's own search-with-suggestions uses. The results
// are <button>s with role="option" so a pointer can press them; tabIndex -1,
// so they are not Tab stops of their own, as a listbox's options never are.
// The station search in the radio panel (RadioFilter.tsx) is the same shape.
import { useEffect, type KeyboardEvent, type RefObject } from "react";
import { resultPlace, resultSpoken, resultsLine, searchKeyIntent, type SettingsEntry } from "../settings-search";
import SettingsSectionGlyph from "./SettingsSectionGlyph";

export const SEARCH_FIELD_ID = "settings-search-field";
export const SEARCH_RESULTS_ID = "settings-search-results";
const optionId = (index: number) => `settings-result-${index}`;

interface FieldProps {
  inputRef: RefObject<HTMLInputElement>;
  query: string;
  onQuery: (query: string) => void;
  results: readonly SettingsEntry[];
  active: number;
  onActive: (index: number) => void;
  onOpen: (entry: SettingsEntry) => void;
}

export function SettingsSearchField({ inputRef, query, onQuery, results, active, onActive, onOpen }: FieldProps) {
  const searching = query.trim() !== "";
  const listed = searching && results.length > 0;

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    // A key that ends an IME composition is the composition's, not the list's.
    if (event.nativeEvent.isComposing) return;
    const intent = searchKeyIntent(event.key, query, searching ? results.length : 0, active);
    if (intent.kind === "pass") return;
    event.preventDefault();
    if (intent.kind === "move") onActive(intent.index);
    else if (intent.kind === "open") onOpen(results[intent.index]);
    else {
      // Escape, with a query to clear: this press is the field's. Stopped
      // here, before the window's listener (use-deck-shortcuts.ts) hands it
      // to the dialog stack and Settings closes on a press that only meant
      // "start again". With the field empty it is passed on, and closes.
      event.stopPropagation();
      onQuery("");
    }
  };

  return (
    <div className="settings-search">
      {/* Named by a visually hidden word rather than the placeholder alone,
          like Keyboard's filter: a placeholder is gone once somebody types,
          and is not a name. The glyph is the field's sign, not its name. */}
      <label className="vis-hidden" htmlFor={SEARCH_FIELD_ID}>Search settings</label>
      <svg className="settings-search-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
           strokeWidth="1.4" strokeLinecap="round" aria-hidden focusable="false">
        <circle cx="6" cy="6" r="4.2" />
        <path d="m9.2 9.2 3.3 3.3" />
      </svg>
      <input
        ref={inputRef}
        id={SEARCH_FIELD_ID}
        type="search"
        className="settings-filter-field settings-search-field"
        placeholder="Search settings"
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={listed}
        aria-controls={listed ? SEARCH_RESULTS_ID : undefined}
        aria-activedescendant={listed ? optionId(Math.min(active, results.length - 1)) : undefined}
        aria-keyshortcuts="Control+F Meta+F"
        value={query}
        onChange={event => onQuery(event.target.value)}
        onKeyDown={onKey}
      />
    </div>
  );
}

interface ResultsProps {
  query: string;
  results: readonly SettingsEntry[];
  active: number;
  onOpen: (entry: SettingsEntry) => void;
}

/** The pane while the field holds a query: its head, in the shape every
 *  section's head has, and the results in one list in the shape every group
 *  has (SettingsParts.tsx), so the page reads as one more page of Settings. */
export function SettingsSearchResults({ query, results, active, onOpen }: ResultsProps) {
  const line = resultsLine(results.length, query);
  // The highlight kept in view as the arrows walk it, inside the pane's
  // scroll-padding so it never sits under a soft edge.
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div className="settings-pane" role="region" aria-labelledby="settings-search-title">
      <div className="settings-pane-head">
        <div className="settings-pane-heading">
          <h2 className="settings-pane-title" id="settings-search-title">Search</h2>
          {/* Seen here; heard from the region beside the field, which is
              mounted for as long as the dialog is (#1763): a status mounted
              together with its first words is routinely not announced. */}
          <p className="settings-pane-note" aria-hidden>{line}</p>
        </div>
      </div>
      {results.length > 0 && (
        <div className="settings-group">
          <div className="settings-list" id={SEARCH_RESULTS_ID} role="listbox" aria-label="Matching settings">
            {results.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                role="option"
                id={optionId(index)}
                className="settings-result"
                tabIndex={-1}
                aria-selected={index === active}
                aria-label={resultSpoken(entry)}
                /* The keyboard's highlight, which is focus the DOM does not
                   hold: data-highlighted is that focus's spelling in the
                   sheet, which draws it as the focus ring is drawn. */
                data-highlighted={index === active}
                // Focus stays in the field through a press, so the press that
                // opens a result does not first drop it on a button the
                // opening is about to unmount.
                onMouseDown={event => event.preventDefault()}
                onClick={() => onOpen(entry)}
              >
                <SettingsSectionGlyph section={entry.section} />
                <span className="settings-result-text">
                  <span className="settings-result-name">{entry.label}</span>
                  <span className="settings-result-place">{resultPlace(entry)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The count, said to a screen reader as it changes. Mounted always, beside
 *  the field, and empty while there is no query. */
export function SettingsSearchStatus({ query, count }: { query: string; count: number }) {
  return <p className="vis-hidden" role="status">{query.trim() ? resultsLine(count, query) : ""}</p>;
}
