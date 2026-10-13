import { useRef, useState, type RefObject } from "react";
import { type RadioCollection, type RadioFilters } from "../radio-discovery";
import RadioFilter, { type RadioFilterOption } from "./RadioFilter";
import RadioIcon from "./RadioIcon";

export default function RadioDiscoveryToolbar({ collection, favoriteCount, onCollectionChange, query, onQueryChange, searchRef, filters, onFilterChange, countryOptions, genreOptions, languageOptions }: {
  collection: RadioCollection; favoriteCount: number; onCollectionChange: (value: RadioCollection) => void;
  query: string; onQueryChange: (value: string) => void; searchRef: RefObject<HTMLInputElement>;
  filters: RadioFilters; onFilterChange: (name: keyof RadioFilters, value: string) => void;
  countryOptions: RadioFilterOption[]; genreOptions: RadioFilterOption[]; languageOptions: RadioFilterOption[];
}) {
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
      let next = index;
      if (event.key === "ArrowRight") next = (index + 1) % collections.length;
      else if (event.key === "ArrowLeft") next = (index + collections.length - 1) % collections.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = collections.length - 1;
      else return;
      event.preventDefault(); event.stopPropagation(); onCollectionChange(collections[next].value);
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
    }}>
      {collections.map(tab => <button type="button" className="radio-collection" role="tab" id={`radio-tab-${tab.value}`} key={tab.value} aria-selected={collection === tab.value} aria-controls="radio-station-results" tabIndex={collection === tab.value ? 0 : -1} onClick={() => onCollectionChange(tab.value)}>{tab.label}{tab.value === "favorites" && favoriteCount > 0 && <span className="radio-tab-count">{favoriteCount}</span>}</button>)}
    </div>
    <div className="radio-search-tools">
      <div className="radio-search"><RadioIcon name="search" /><label className="vis-hidden" htmlFor="radio-search">Search stations and streams</label><input ref={searchRef} id="radio-search" type="search" placeholder="Search stations" value={query} onChange={event => onQueryChange(event.target.value)} />{query && <button type="button" className="icon-btn" aria-label="Clear search" onClick={() => { onQueryChange(""); searchRef.current?.focus(); }}><RadioIcon name="close" /></button>}</div>
      {!expanded && <div className="radio-quick-country"><RadioFilter label="Country" value={filters.country} options={countryOptions} onChange={value => onFilterChange("country", value)} /></div>}
      <button type="button" ref={toggleRef} className="radio-filter-toggle" aria-label={`Filters${active.length ? `, ${active.length} active` : ""}`} aria-expanded={expanded} aria-controls="radio-filter-fields" data-active={expanded || active.length > 0} onClick={() => setExpanded(current => !current)}><RadioIcon name="filters" /><span>Filters</span>{active.length > 0 && <span className="radio-tab-count">{active.length}</span>}</button>
    </div>
    <div id="radio-filter-fields" hidden={!expanded} className="radio-filters" role="group" aria-label="Station filters">{fields.map(field => <RadioFilter key={field.name} label={field.label} value={filters[field.name]} options={field.options} allowCustom={field.name !== "country"} onChange={value => onFilterChange(field.name, value)} />)}</div>
    {active.length > 0 && <div className="radio-active-filters" role="group" aria-label="Active filters">{active.map(field => {
      const value = field.options.find(option => option.value === filters[field.name])?.label ?? filters[field.name];
      return <button type="button" className="radio-filter-chip" key={field.name} aria-label={`Remove ${field.label.toLowerCase()} filter: ${value}`} title={`${field.label}: ${value}`} onClick={() => { onFilterChange(field.name, ""); returnFocus(); }}><span>{field.label}: {value}</span><RadioIcon name="close" /></button>;
    })}<button type="button" className="radio-reset" onClick={clear}>Clear filters</button></div>}
  </div>;
}
