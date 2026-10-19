// The project (GitLab) or repository (GitHub) the panel's tabs read, as the
// toolbar's first control (#2179).
//
// A button that names the current one — the group quiet, the project's own
// name last and never cut — or "All projects" where the tab reads across them.
// It opens a popover the way the radio's filters do (AnchoredPopover, with
// RadioFilter's combobox-and-listbox keys): a search the forge answers, so a
// project on the fourth page is one word away; the unfiltered list by recent
// activity, which is what the owner opens most; "All projects" first where the
// tab allows it; the current one marked; Load more for the next page.
//
// PORTALLED INTO ITS OWN SPAN, AND HUNG OFF IT. The panel lives in the
// integrations host's modal, so the popover is drawn inside that dialog —
// under its aria-modal boundary and above its scrim — rather than on <body>,
// where the modal would cover it and a screen reader would treat it as outside
// the dialog. The span is also what it is anchored to: the deck's popovers
// end-align with their anchor, and the span is the popover's width with the
// button at its start, so the list opens under the button, the way a select
// does, instead of running out of the panel's left edge.
//
// ESCAPE IS ANSWERED HERE as well as by the deck's dismiss stack, and stopped,
// so one press closes the popover and never the modal under it, whichever
// listener hears it first.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ForgeRepo } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import { allReposLabel, repoNounPlural, splitRepoPath } from "../../forge-lists";
import { useForgePages } from "../../use-forge-read";
import AnchoredPopover from "../AnchoredPopover";
import { useForge } from "./ForgeContext";
import { Ago, ListEnd, LoadingRows, ReadFailure } from "./ForgeParts";

interface Props {
  value: string | null;
  allowAll: boolean;
  onChange: (repo: string | null) => void;
}

export default function RepoPicker({ value, allowAll, onChange }: Props) {
  const { kind } = useForge();
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const noun = forgeWords[kind].repo;
  const shown = value ?? (allowAll ? allReposLabel(kind) : `Choose a ${noun.toLowerCase()}`);
  const parts = value ? splitRepoPath(value) : null;

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);

  return (
    <span className="fgl-repo" id={`${id}-layer`}>
      <button
        ref={trigger}
        id={`${id}-trigger`}
        type="button"
        className="btn fgl-repo-trigger"
        aria-label={`${noun}: ${shown}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={value ?? undefined}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
        }}
      >
        <RepoGlyph />
        {parts
          ? <span className="fgl-repo-path"><span className="fgl-repo-group">{parts.group}</span><span className="fgl-repo-name">{parts.name}</span></span>
          : <span className="fgl-repo-all">{shown}</span>}
        <ChevronGlyph />
      </button>
      {open && (
        <AnchoredPopover
          anchorId={`${id}-layer`}
          portalRootId={`${id}-layer`}
          id={`${id}-popup`}
          className="fgl-repo-pop"
          role="dialog"
          labelledBy={`${id}-trigger`}
          onClose={close}
        >
          <RepoOptions value={value} allowAll={allowAll} onPick={repo => { onChange(repo); close(); }} onEscape={close} />
        </AnchoredPopover>
      )}
    </span>
  );
}

type Option = { value: string | null; repo: ForgeRepo | null };

function RepoOptions({ value, allowAll, onPick, onEscape }: {
  value: string | null; allowAll: boolean; onPick: (repo: string | null) => void; onEscape: () => void;
}) {
  const { kind, api, scope, refresh } = useForge();
  const id = useId();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const plural = repoNounPlural(kind);

  // The forge searches; one request per pause in typing, not per key.
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(t);
  }, [query]);

  const repos = useForgePages<ForgeRepo>(api, scope, "repos", { search: search || undefined }, refresh);
  const items = repos.data?.items;
  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    if (allowAll && !search) out.push({ value: null, repo: null });
    // The current project stays in reach before the page that holds it loads.
    if (value && !search && items && !items.some(r => r.path === value)) out.push({ value, repo: null });
    for (const r of items ?? []) out.push({ value: r.path, repo: r });
    return out;
  }, [allowAll, search, value, items]);

  // A new answer starts on the current project when it is there, else on the
  // top; Load more keeps the place.
  const [active, setActive] = useState(0);
  const answered = items != null;
  useEffect(() => {
    setActive(Math.max(0, options.findIndex(o => o.value === value)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, answered]);
  const index = Math.min(active, options.length - 1);

  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, options.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((Math.max(0, index) + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : Math.max(0, n - 1));
    } else if (e.key === "Enter" && index >= 0 && options[index]) {
      e.preventDefault();
      onPick(options[index].value);
    }
  };

  const typing = query.trim() !== search;
  const phase = items == null ? (repos.error ? "failed" : "loading") : options.length ? "rows" : "empty";

  return (
    <div
      className="fgl-repo-body"
      onKeyDown={e => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }}
    >
      <label className="fgl-repo-search">
        <span className="fg-sr">Search {plural}</span>
        <SearchGlyph />
        <input
          ref={input}
          className="ap-manage-input"
          role="combobox"
          placeholder={`Search ${plural}…`}
          autoComplete="off"
          spellCheck={false}
          value={query}
          aria-expanded={options.length > 0}
          aria-autocomplete="list"
          aria-controls={`${id}-options`}
          aria-activedescendant={phase === "rows" && index >= 0 ? `${id}-option-${index}` : undefined}
          aria-busy={typing || repos.loading}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      <div ref={list} className="fgl-repo-scroll">
        {repos.error && items && <ReadFailure error={repos.error} onRetry={repos.reload} compact />}
        {phase === "loading" && <LoadingRows rows={4} label={`Loading ${plural}`} />}
        {phase === "failed" && repos.error && <ReadFailure error={repos.error} onRetry={repos.reload} />}
        {phase === "empty" && (
          <p className="fgl-repo-none" role="status">{search ? `No ${plural} match “${search}”.` : `This token can see no ${plural}.`}</p>
        )}
        <div id={`${id}-options`} className="fgl-repo-options" role="listbox" aria-label={forgeWords[kind].repo} hidden={phase !== "rows"}>
          {phase === "rows" && options.map((o, i) => (
            <RepoOption
              key={o.value ?? "(all)"}
              id={`${id}-option-${i}`}
              option={o}
              selected={o.value === value}
              active={i === index}
              onHover={() => { if (i !== index) setActive(i); }}
              onPick={() => onPick(o.value)}
            />
          ))}
        </div>
        {repos.data && (
          <ListEnd pages={repos} label={`More ${plural}`} />
        )}
      </div>
    </div>
  );
}

function RepoOption({ id, option, selected, active, onHover, onPick }: {
  id: string; option: Option; selected: boolean; active: boolean; onHover: () => void; onPick: () => void;
}) {
  const { kind } = useForge();
  const parts = option.value ? splitRepoPath(option.value) : null;
  return (
    <button
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      className="fgl-repo-option"
      aria-selected={selected}
      data-active={active}
      onPointerMove={onHover}
      onClick={onPick}
    >
      <span className="fgl-repo-option-text">
        {parts
          ? <>
              <span className="fgl-repo-option-name">{parts.name}</span>
              {parts.group && <span className="fgl-repo-option-group">{parts.group.slice(0, -1)}</span>}
            </>
          : <span className="fgl-repo-option-name">{allReposLabel(kind)}</span>}
      </span>
      {option.repo?.archived && <span className="fg-badge">archived</span>}
      {option.repo?.lastActivityAt != null && <span className="fgl-repo-option-when"><Ago at={option.repo.lastActivityAt} /></span>}
      <span className="fgl-repo-check" aria-hidden="true">{selected && <CheckGlyph />}</span>
    </button>
  );
}

function RepoGlyph() {
  return (
    <svg className="fgl-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 2.5h8a1 1 0 0 1 1 1v8.5h-8.5a1 1 0 0 0-1 1z" />
      <path d="M3.5 13a1 1 0 0 0 1 1h8v-2" />
      <path d="M6 5.5h4" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg className="fgl-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 4l2.5 2.5L7.5 4" />
    </svg>
  );
}

function SearchGlyph() {
  return (
    <svg className="fgl-glyph" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}
