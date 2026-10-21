import { useId, useRef, useState, type RefObject } from "react";
import { type RadioCollection, type RadioFilters } from "../radio-discovery";
import { tabStripMove } from "../tablist-keys";
import { RadioFilterOptions, type RadioFilterOption } from "./RadioFilter";
import RadioIcon from "./RadioIcon";
import AnchoredPopover from "./AnchoredPopover";

export default function RadioDiscoveryToolbar({ collection, favoriteCount, onCollectionChange, query, onQueryChange, searchRef, filters, onFilterChange, countryOptions, genreOptions, languageOptions }: {
  collection: RadioCollection; favoriteCount: number; onCollectionChange: (value: RadioCollection) => void;
  query: string; onQueryChange: (value: string) => void; searchRef: RefObject<HTMLInputElement>;
  filters: RadioFilters; onFilterChange: (name: keyof RadioFilters, value: string) => void;
  countryOptions: RadioFilterOption[]; genreOptions: RadioFilterOption[]; languageOptions: RadioFilterOption[];
}) {
  const id = useId();
  const [fieldIndex, setFieldIndex] = useState<number | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false);
  const collections: { value: RadioCollection; label: string }[] = [{ value: "discover", label: "Discover" }, { value: "favorites", label: "Favorites" }, { value: "recent", label: "Recent" }];
  const fields = [{ name: "country" as const, label: "Country", options: countryOptions }, { name: "genre" as const, label: "Genre", options: genreOptions }, { name: "language" as const, label: "Language", options: languageOptions }];
  const active = fields.filter(field => filters[field.name]);
  const returnFocus = () => requestAnimationFrame(() => toggleRef.current?.focus({ preventScroll: true }));
  const clear = () => { fields.forEach(field => onFilterChange(field.name, "")); returnFocus(); };
  return <div className="radio-discovery-toolbar">
    <div className="radio-collections" role="tablist" aria-label="Station collection" onKeyDown={event => {
      const index = collections.findIndex(tab => tab.value === collection);
      const move = tabStripMove(event, index, collections.length);
      if (move.kind === "pass") return;
      event.preventDefault(); event.stopPropagation(); onCollectionChange(collections[move.index].value);
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[move.index]?.focus();
    }}>
      {collections.map(tab => <button type="button" className="radio-collection" role="tab" id={`radio-tab-${tab.value}`} key={tab.value} aria-selected={collection === tab.value} aria-controls="radio-station-results" tabIndex={collection === tab.value ? 0 : -1} onClick={() => onCollectionChange(tab.value)}>{tab.label}{tab.value === "favorites" && favoriteCount > 0 && <span className="radio-tab-count">{favoriteCount}</span>}</button>)}
    </div>
    <div className="radio-search-tools">
      <div className="radio-search"><RadioIcon name="search" /><label className="vis-hidden" htmlFor="radio-search">Search stations and streams</label><input ref={searchRef} id="radio-search" type="search" placeholder="Search stations" value={query} onChange={event => onQueryChange(event.target.value)} />{query && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => { onQueryChange(""); searchRef.current?.focus(); }}><RadioIcon name="close" /></button>}</div>
      <button type="button" ref={toggleRef} id={`${id}-trigger`} className="radio-filter-toggle" aria-label={`Filters${active.length ? `, ${active.length} active` : ""}`} aria-expanded={expanded} aria-haspopup="dialog" aria-controls={expanded ? `${id}-popup` : undefined} data-active={expanded || active.length > 0} onClick={() => { setFieldIndex(null); setExpanded(current => !current); }}><RadioIcon name="filters" /><span>Filters</span>{active.length > 0 && <span className="radio-tab-count">{active.length}</span>}</button>
    </div>
    {expanded && <AnchoredPopover anchorId={`${id}-trigger`} boundaryId="radio-panel" portalRootId="radio-panel" id={`${id}-popup`} className="radio-filter-popup" role="dialog" labelledBy={`${id}-trigger`} onClose={() => { setExpanded(false); }}>
      <div className="radio-filter-heading"><strong>{fieldIndex === null ? "Filter stations" : fields[fieldIndex].label}</strong><button type="button" className="icon-btn" aria-label="Close filters" onClick={() => { setExpanded(false); returnFocus(); }}><RadioIcon name="close" /></button></div>
      {fieldIndex === null ? <>
        <div className="radio-filter-overview">
        <div className="radio-filter-fields">{fields.map((field, index) => {
          const value = field.options.find(option => option.value === filters[field.name])?.label ?? filters[field.name];
          return <button key={field.name} type="button" id={`${id}-${field.name}`} className="radio-filter-field" data-filtered={!!filters[field.name]} aria-label={`${field.label}: ${value}`} onClick={() => setFieldIndex(index)}><span>{field.label}</span><span title={value}>{value}</span><RadioIcon name="back" /></button>;
        })}</div>
        <p className="radio-filter-note">Genre and language apply to directory radio. Choose Global streams for YouTube and custom streams.</p>
        </div>
        <div className="radio-filter-footer">{active.length > 0 && <button type="button" className="radio-reset" onClick={() => { fields.forEach(field => onFilterChange(field.name, "")); requestAnimationFrame(() => document.getElementById(`${id}-done`)?.focus({ preventScroll: true })); }}>Clear filters</button>}<button type="button" className="btn" id={`${id}-done`} onClick={() => { setExpanded(false); returnFocus(); }}>Done</button></div>
      </> : <>
        <button type="button" className="radio-filter-back" onClick={() => { const field = fields[fieldIndex]; setFieldIndex(null); requestAnimationFrame(() => document.getElementById(`${id}-${field.name}`)?.focus({ preventScroll: true })); }}><RadioIcon name="back" />All filters</button>
        <RadioFilterOptions key={fields[fieldIndex].name} label={fields[fieldIndex].label} value={filters[fields[fieldIndex].name]} options={fields[fieldIndex].options} allowCustom={fields[fieldIndex].name !== "country"} onSelect={value => { const field = fields[fieldIndex]; onFilterChange(field.name, value); setFieldIndex(null); requestAnimationFrame(() => document.getElementById(`${id}-${field.name}`)?.focus({ preventScroll: true })); }} />
      </>}
    </AnchoredPopover>}
    {active.length > 0 && <div className="radio-active-filters" role="group" aria-label="Active filters"><div className="radio-active-filter-list">{active.map(field => {
      const value = field.options.find(option => option.value === filters[field.name])?.label ?? filters[field.name];
      return <button type="button" className="radio-filter-chip" key={field.name} aria-label={`Remove ${field.label.toLowerCase()} filter: ${value}`} title={`${field.label}: ${value}`} onClick={() => { onFilterChange(field.name, ""); returnFocus(); }}><span>{field.label}: {value}</span><RadioIcon name="close" /></button>;
    })}</div><button type="button" className="radio-reset" onClick={clear}>Clear filters</button></div>}
  </div>;
}
