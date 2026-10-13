import { useEffect, useId, useRef, useState } from "react";
import AnchoredPopover from "./AnchoredPopover";
import RadioIcon from "./RadioIcon";

export interface RadioFilterOption { value: string; label: string }

export function RadioFilterOptions({ label, value, options, allowCustom, onSelect }: {
  label: string; value: string; options: RadioFilterOption[];
  allowCustom?: boolean; onSelect: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(Math.max(0, options.findIndex(option => option.value === value)));
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const matches = options.filter(option => option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  if (allowCustom && query.trim() && !matches.some(option => option.value.toLowerCase() === query.trim().toLowerCase())) {
    matches.push({ value: query.trim(), label: query.trim() });
  }
  const index = Math.min(active, matches.length - 1);
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, query]);
  return <>
    <div className="radio-filter-search"><RadioIcon name="search" /><input ref={input} role="combobox" aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}…`} autoComplete="off" value={query} aria-expanded={matches.length > 0} aria-autocomplete="list" aria-controls={matches.length ? `${id}-options` : undefined} aria-activedescendant={index >= 0 ? `${id}-option-${index}` : undefined} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); setActive(matches.length ? (Math.max(0, index) + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length : 0);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault(); setActive(event.key === "Home" ? 0 : Math.max(0, matches.length - 1));
      } else if (event.key === "Enter" && index >= 0) {
        event.preventDefault(); onSelect(matches[index].value);
      }
    }} /></div>
    {matches.length > 0 ? <div ref={list} id={`${id}-options`} className="radio-filter-options" role="listbox" aria-label={`${label} options`}>
      {matches.map((option, i) => <button type="button" className="radio-filter-option" role="option" tabIndex={-1} id={`${id}-option-${i}`} key={option.value} aria-selected={option.value === value} data-active={i === index} onPointerMove={() => setActive(i)} onClick={() => onSelect(option.value)}><span>{option.label}</span>{option.value === value && <RadioIcon name="check" />}</button>)}
    </div> : <div className="radio-filter-options"><p role="status">No matches</p></div>}
  </>;
}

export default function RadioFilter({ label, value, options, allowCustom, onChange }: {
  label: string; value: string; options: RadioFilterOption[]; allowCustom?: boolean; onChange: (value: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = options.find(option => option.value === value)?.label ?? value;
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <>
    <button ref={trigger} id={id} type="button" className="radio-filter-trigger" data-filtered={!!value} aria-label={`${label}: ${selected}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(current => !current)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}><span>{value ? selected : label}</span><RadioIcon name="back" /></button>
    {open && <AnchoredPopover anchorId={id} boundaryId="radio-panel" portalRootId="radio-panel" id={`${id}-popup`} className="radio-filter-popup" role="dialog" labelledBy={id} onClose={close}><RadioFilterOptions label={label} value={value} options={options} allowCustom={allowCustom} onSelect={next => { onChange(next); close(); }} /></AnchoredPopover>}
  </>;
}
