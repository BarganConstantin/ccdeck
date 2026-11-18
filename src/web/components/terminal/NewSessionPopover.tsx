// "New session": start Claude or Codex in a project, in the deck's own tmux —
// on Windows, in the session host — and put it on the stage (v3, the Claude
// app's "New chat" place).
//
// FIRST THE FOLDER, THEN THE AGENT, THEN A BUTTON THAT SAYS WHAT IT WILL DO
// (internal #106). One field, "Search projects or enter a path", holds the
// keyboard: empty, the list under it is the reader's recent projects — the
// folders sessions on the board ran in, the stage's own first, the ones
// chosen here before, and bounded local Git discovery (project-picker.ts); typed into,
// the list keeps the projects whose name or path holds every word, and a full
// path is offered as itself ("Use /srv/api"). ↑ and ↓ walk the list, Enter
// CHOOSES — it never starts an agent — and Shift+Delete takes a project off
// the list without touching its folder. "Choose another folder…" opens the
// desktop app's own folder dialog; in a browser, which cannot hand over a
// path on the deck's machine, it asks for the folder's full path in the field.
// Then the agent, Claude's own choices, and "Start Claude in paycore" — or
// Ctrl+Enter from the field.
//
// THE FOLDER IS ASKED ABOUT BEFORE THE START. The deck says whether an agent
// can start there (terminal-api.ts checkFolder): a folder that went away, one
// this account may not open, a file, or a deck that cannot be reached is said
// here, with the folder still chosen and Start there to press again — never
// as a stage that failed after the picker closed, and never by starting
// somewhere else. Once Start has gone through, the form takes no second press:
// one press, one agent.
//
// Shared Button/Input controls adapt shadcn/ui to the deck's theme tokens.
// The agent is the
// usage modal's range strip (.uh-range, a pair of pressed buttons), the
// projects are quick open's rows (.qo-row's height, radius and --selected
// fill, drawn as .ns-option: Settings' station list they once borrowed went
// with its styles), and the search is the shared text field, as a combobox:
// it holds focus and names the highlighted option through
// aria-activedescendant.
//
// A POPOVER, NOT A DIALOG. It hangs off the control that opened it — "+ New
// session" at the top of the navigator, or the empty stage's own button — and
// is AnchoredPopover's: portalled, placed against the window, Escape and the
// outside press close it and focus goes back to the anchor (Escape in a
// search clears the search first). It opens opaque from the first frame (a
// scale from 0.97, no fade), because a translucent form over a running
// terminal is two things read at once.
//
// CLAUDE'S OWN THREE CHOICES, for a new Claude only: the model, how it asks
// for permission, and whether it works in a new git worktree — the choices
// the Claude app's new chat offers, as Claude Code's own flags. Each starts at
// "Default", which passes nothing and leaves the reader's settings in charge;
// no choice here stops it asking (the launcher refuses those modes anyway).
// Codex is started as it is.
//
// The form is its own component with no portal, so the suite can render it
// whole and press its controls without a DOM; what it asks of the world
// (the deck, the dialog, the storage, the clock) comes in through `deps`.
import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import AnchoredPopover from "../AnchoredPopover";
import { checkFolder, discoverProjectFolders, type DiscoveredProject, type FolderAnswer, type FolderProblem, type LaunchOptions, type TerminalProvider } from "../../terminal-api";
import { sessionHue } from "../../session-hue";
import { canChooseFolder, chooseFolder } from "../../desktop-folder";
import { isApplePlatform, platformName } from "../../platform";
import { elidePath, folderName, type ProjectChoice } from "./stage-model";
import {
  browserStore, looksRelative, matchProjects, pickerProjects, projectKey, projectPaths, readKept, saveKept, typedFolder,
  withRecent, withoutRecent, type KeptProjects, type ProjectStore,
} from "./project-picker";
import { ProviderGlyph } from "./stage-icons";
import SelectShell from "../SelectShell";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { KitIcon } from "../kit-icons";
import { t as tNow, useT } from "../../i18n";

export const NEW_SESSION_POPOVER_ID = "ns-pop";
const TITLE_ID = "ns-title";
const FIELD_ID = "ns-search";
const LIST_ID = "ns-projects";
const KEYS_ID = "ns-keys";
const WORKTREE_ID = "ns-worktree-label";
const optionId = (i: number) => `ns-opt-${i}`;
const DISCOVERY_MSG = {
  loading: "board.newSession.discovery.loading",
  partial: "board.newSession.discovery.partial",
  unavailable: "board.newSession.discovery.unavailable",
};

/** The one sentence under the choices: where the session runs, and that
 *  closing the panel never stops it. */
export const NEW_SESSION_NOTE_MSG = "board.newSession.note";
/** The same on Windows, which has no tmux: the panel's sessions run in its session host. */
export const NEW_SESSION_NOTE_WINDOWS_MSG = "board.newSession.noteWindows";

/** What the form asks of the world. The product passes nothing. */
export interface NewSessionDeps {
  /** Whether an agent can start in this folder (the deck's answer). */
  checkFolder(cwd: string): Promise<FolderAnswer>;
  loadProjects?(signal: AbortSignal): Promise<{ projects: DiscoveredProject[]; truncated?: boolean }>;
  /** The desktop app's folder dialog: a path, null when closed without one,
   *  undefined when it could not be asked. Left out where there is none. */
  chooseFolder?: () => Promise<string | null | undefined>;
  store: ProjectStore | null;
  now(): number;
  /** ⌘ rather than Ctrl in what the keys hint says. */
  apple: boolean;
}

function productDeps(): NewSessionDeps {
  return {
    checkFolder: cwd => checkFolder(cwd),
    loadProjects: async signal => {
      const answer = await discoverProjectFolders({ signal });
      if (!answer.ok) throw new Error("Project discovery unavailable");
      return answer;
    },
    ...(canChooseFolder() ? { chooseFolder } : {}),
    store: browserStore(),
    now: () => Date.now(),
    apple: isApplePlatform(platformName()),
  };
}

export interface NewSessionFormProps {
  /** The board's folders, the stage's own first (stage-board.ts boardProjects). */
  projects: ProjectChoice[];
  initialAgent?: TerminalProvider;
  /** The deck's sessions run in the Windows session host, not tmux. */
  windows?: boolean;
  onStart(agent: TerminalProvider, cwd: string, options?: LaunchOptions): void;
  onCancel(): void;
  deps?: Partial<NewSessionDeps>;
  searchRef?: MutableRefObject<HTMLInputElement | null>;
}

/** `label` is a catalog key where the choice is a word (Default), the model's own name otherwise. */
export const MODEL_CHOICES: Array<{ value: LaunchOptions["model"] | null; label: string; named?: true }> = [
  { value: null, label: "board.newSession.default" },
  { value: "opus", label: "Opus", named: true },
  { value: "sonnet", label: "Sonnet", named: true },
  { value: "haiku", label: "Haiku", named: true },
];

/** `label` and `title` are catalog keys. */
export const MODE_CHOICES: Array<{ value: LaunchOptions["permissionMode"] | null; label: string; title: string }> = [
  { value: null, label: "board.newSession.default", title: "board.newSession.modeDefaultTip" },
  { value: "auto", label: "board.newSession.modeAuto", title: "board.newSession.modeAutoTip" },
  { value: "acceptEdits", label: "board.newSession.modeEdits", title: "board.newSession.modeEditsTip" },
  { value: "plan", label: "board.newSession.modePlan", title: "board.newSession.modePlanTip" },
];

/** The options a start passes: only what was chosen, so Default is nothing. */
export function launchOptions(model: LaunchOptions["model"] | null, mode: LaunchOptions["permissionMode"] | null, worktree: boolean): LaunchOptions | undefined {
  const o: LaunchOptions = {};
  if (model) o.model = model;
  if (mode) o.permissionMode = mode;
  if (worktree) o.worktree = true;
  return Object.keys(o).length ? o : undefined;
}

const AGENTS: Array<{ agent: TerminalProvider; label: string }> = [
  { agent: "claude", label: "Claude" },
  { agent: "codex", label: "Codex" },
];

/** The start button's words: what it will do, named. */
export function startLabel(agent: TerminalProvider, target: { name: string } | null): string {
  const who = agent === "codex" ? "Codex" : "Claude";
  return target ? tNow("board.newSession.startIn", { agent: who, project: target.name }) : tNow("board.newSession.start", { agent: who });
}

/** The catalog key for why a folder cannot be started in. */
export const FOLDER_PROBLEM_MSG: Record<Exclude<FolderProblem, "unavailable">, string> = {
  relative: "board.newSession.problemRelative",
  missing: "board.newSession.problemMissing",
  denied: "board.newSession.problemDenied",
  "not-folder": "board.newSession.problemNotFolder",
  offline: "board.newSession.problemOffline",
};

/** A path to show for an example of "a full path" on this deck. */
const pathExample = (windows: boolean) => (windows ? "C:\\path\\to\\project" : "/path/to/project");

interface Chosen { cwd: string; name: string }

export function NewSessionForm({ projects, initialAgent = "claude", windows = false, onStart, onCancel, deps: given, searchRef }: NewSessionFormProps) {
  const t = useT();
  const [deps] = useState<NewSessionDeps>(() => ({ ...productDeps(), ...given }));
  const [kept, setKept] = useState<KeptProjects>(() => readKept(deps.store));
  const [discovered, setDiscovered] = useState<ProjectChoice[]>([]);
  const [discovery, setDiscovery] = useState<"loading" | "ready" | "partial" | "unavailable">(deps.loadProjects ? "loading" : "ready");
  const all = pickerProjects(projects, kept.recents, kept.forgotten, discovered);
  useEffect(() => {
    const controller = new AbortController();
    void deps.loadProjects?.(controller.signal).then(found => {
      if (controller.signal.aborted) return;
      setDiscovered(found.projects.map(p => ({ ...p, hue: sessionHue(p.cwd) })));
      setDiscovery(found.truncated ? "partial" : "ready");
    }).catch(() => {
      if (!controller.signal.aborted) setDiscovery("unavailable");
    });
    return () => controller.abort();
  }, [deps]);
  const [chosen, setChosen] = useState<Chosen | null>(() => (all[0] ? { cwd: all[0].cwd, name: all[0].name } : null));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [agent, setAgent] = useState<TerminalProvider>(initialAgent);
  const [model, setModel] = useState<LaunchOptions["model"] | null>(null);
  const [mode, setMode] = useState<LaunchOptions["permissionMode"] | null>(null);
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState<"checking" | "picking" | null>(null);
  const [problem, setProblem] = useState<{ code: FolderProblem; cwd: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const localFieldRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = searchRef ?? localFieldRef;
  // Set once Start has gone through: the form takes no second one.
  const startedRef = useRef(false);
  // A folder question in flight: a second press waits for its answer.
  const askingRef = useRef(false);

  const searching = query.trim() !== "";
  const typed = searching ? typedFolder(all, query) : null;
  const shown = searching ? [...(typed ? [typed] : []), ...matchProjects(all, query)] : all;
  const at = shown.length ? Math.min(Math.max(active, 0), shown.length - 1) : -1;
  useEffect(() => {
    const list = listRef.current;
    const row = list?.children[at];
    if (!list || !row) return;
    const box = list.getBoundingClientRect(), item = row.getBoundingClientRect();
    // Move only this scroller: scrollIntoView can also move the dialog/page.
    if (item.top < box.top) list.scrollTop -= box.top - item.top;
    else if (item.bottom > box.bottom) list.scrollTop += item.bottom - box.bottom;
  }, [at, query, shown.length]);
  const paths = projectPaths(all);
  const place = (cwd: string) => Math.max(0, all.findIndex(p => p.cwd === cwd));

  const keep = (change: (k: KeptProjects) => KeptProjects) => {
    setKept(k => {
      const next = change(k);
      saveKept(next, deps.store);
      return next;
    });
  };

  const clearSays = () => { setProblem(null); setNote(null); };

  // A project from the list becomes the folder; the search steps aside so the
  // whole list shows again with it marked.
  const choose = (p: ProjectChoice) => {
    setChosen({ cwd: p.cwd, name: p.name });
    setQuery("");
    setActive(place(p.cwd));
    clearSays();
  };

  /** Ask the deck about a folder that is not on the list yet — typed in full,
   *  or chosen in the dialog — and take it if an agent can start there. */
  const adopt = async (path: string) => {
    if (askingRef.current) return;
    askingRef.current = true;
    clearSays();
    setBusy("checking");
    const answer = await deps.checkFolder(path);
    askingRef.current = false;
    setBusy(null);
    if (!answer.ok && answer.code !== "unavailable") {
      setProblem({ code: answer.code, cwd: path });
      return;
    }
    const cwd = answer.ok ? answer.cwd : projectKey(path);
    keep(k => withRecent(k, cwd, deps.now()));
    setChosen({ cwd, name: folderName(cwd) });
    setQuery("");
    setActive(0);
  };

  const pickOption = (p: ProjectChoice) => {
    if (typed && p.cwd === typed.cwd) void adopt(p.cwd);
    else choose(p);
  };

  const forget = (p: ProjectChoice) => {
    const next = withoutRecent(kept, p.cwd);
    saveKept(next, deps.store);
    setKept(next);
    if (chosen && projectKey(chosen.cwd) === projectKey(p.cwd)) {
      const rest = pickerProjects(projects, next.recents, next.forgotten, discovered);
      setChosen(rest[0] ? { cwd: rest[0].cwd, name: rest[0].name } : null);
    }
    setProblem(null);
    setNote(t("board.newSession.forgotten", { name: p.name }));
    fieldRef.current?.focus();
  };

  // "Choose another folder…": the app's dialog, or, with none, the field and
  // what to type in it.
  const askForPath = () => {
    setProblem(null);
    setNote(t("board.newSession.typePath", { example: pathExample(windows) }));
    fieldRef.current?.focus();
  };
  const pick = async () => {
    if (busy) return;
    if (!deps.chooseFolder) return askForPath();
    clearSays();
    setBusy("picking");
    let path: string | null | undefined;
    try { path = await deps.chooseFolder(); } catch { path = undefined; }
    setBusy(null);
    if (path === undefined) return askForPath();
    if (path === null) {
      setNote(t("board.newSession.pickCancelled"));
      fieldRef.current?.focus();
      return;
    }
    await adopt(path);
    fieldRef.current?.focus();
  };

  const start = async () => {
    if (!chosen || startedRef.current || askingRef.current) return;
    askingRef.current = true;
    clearSays();
    setBusy("checking");
    const answer = await deps.checkFolder(chosen.cwd);
    askingRef.current = false;
    setBusy(null);
    // A deck that gives no answer this page reads (an older one) still checks
    // the folder at the launch itself; any answer it does give is kept to.
    if (!answer.ok && answer.code !== "unavailable") {
      setProblem({ code: answer.code, cwd: chosen.cwd });
      return;
    }
    const cwd = answer.ok ? answer.cwd : chosen.cwd;
    startedRef.current = true;
    keep(k => withRecent(k, cwd, deps.now()));
    const options = agent === "claude" ? launchOptions(model, mode, worktree) : undefined;
    if (options) onStart(agent, cwd, options);
    else onStart(agent, cwd);
  };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!shown.length) return;
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : shown.length - 1;
      setActive((at < 0 ? 0 : at + step) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { void start(); return; }
      const p = at >= 0 ? shown[at] : undefined;
      if (p) pickOption(p);
    } else if (e.key === "Delete" && e.shiftKey) {
      const p = at >= 0 ? shown[at] : undefined;
      if (!p || (typed && p.cwd === typed.cwd)) return;
      e.preventDefault();
      forget(p);
    } else if (e.key === "Escape" && query) {
      // The search goes first; a second Escape closes the popover.
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
      setActive(chosen ? place(chosen.cwd) : 0);
    }
  };

  const emptyText = !searching
    ? t("board.newSession.noProjects")
    : looksRelative(query)
      ? t(windows ? "board.newSession.pathHintWindows" : "board.newSession.pathHint")
      : t("board.newSession.noMatches", { query: query.trim() });
  const problemText = problem && problem.code !== "unavailable" ? t(FOLDER_PROBLEM_MSG[problem.code]) : null;
  const keysHint = t("board.newSession.keysHint", { mod: deps.apple ? "⌘" : "Ctrl" });

  return (
    <div className="ns-form" data-searching={searching || undefined} aria-busy={busy ? true : undefined}>
      <div className="ns-head">
        <h3 id={TITLE_ID} className="ns-title">{t("board.newSession.title")}</h3>
        <Button variant="ghost" size="icon" className="ns-close" aria-label={t("common.close")} onClick={onCancel}><KitIcon name="close" /></Button>
      </div>
      <label className="ns-label" id="ns-project-label" htmlFor={FIELD_ID}>{t("board.newSession.project")}</label>
      <div className="ns-search">
      <KitIcon name="search" />
      <Input
        ref={fieldRef}
        id={FIELD_ID}
        className="ns-field"
        type="text"
        name="project-search"
        role="combobox"
        aria-expanded={shown.length > 0}
        aria-controls={LIST_ID}
        aria-activedescendant={at >= 0 ? optionId(at) : undefined}
        aria-autocomplete="list"
        aria-label={t("board.newSession.searchLabel")}
        aria-describedby={KEYS_ID}
        spellCheck={false}
        autoComplete="off"
        placeholder={t("board.newSession.searchLabel")}
        value={query}
        onChange={e => { setQuery(e.target.value); setActive(0); clearSays(); }}
        onKeyDown={onFieldKey}
      />
      </div>
      <span id={KEYS_ID} className="ns-keys">{keysHint}</span>
      <div ref={listRef} className="ns-list" id={LIST_ID} role="listbox" aria-labelledby="ns-project-label" hidden={shown.length === 0}>
        {shown.map((q, i) => {
          const isTyped = !!typed && q.cwd === typed.cwd;
          const isChosen = !!chosen && chosen.cwd === q.cwd && !isTyped;
          return (
            <div
              key={`${isTyped ? "typed:" : ""}${q.cwd}`}
              id={optionId(i)}
              className="ns-option"
              role="option"
              aria-selected={isChosen}
              data-highlighted={i === at || undefined}
              data-chosen={isChosen || undefined}
              title={q.cwd}
              // The field keeps the keyboard: a press on a row is not a press
              // that moves focus out of it.
              onMouseDown={e => e.preventDefault()}
              onClick={() => pickOption(q)}
            >
              <span className="ns-folder" aria-hidden="true"><KitIcon name="folder" /></span>
              <span className="ns-project-copy">
                <span className="ns-name">{isTyped ? t("board.newSession.usePath", { name: q.name }) : q.name}</span>
                <span className="ns-path">{isTyped ? elidePath(q.cwd, 56) : paths.get(q.cwd) ?? elidePath(q.cwd, 56)}</span>
              </span>
              {isChosen && (
                <svg className="ns-check" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.5 6.5l2.25 2.25L9.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {!isTyped && (
                <span
                  className="ns-forget"
                  aria-hidden="true"
                  title={t("board.newSession.forget", { name: q.name })}
                  onClick={e => { e.stopPropagation(); forget(q); }}
                >
                  ×
                </span>
              )}
            </div>
          );
        })}
      </div>
      {shown.length === 0 && discovery !== "loading" && <p className="ns-empty" role="status">{emptyText}</p>}
      {discovery !== "ready" && <p className="ns-discovery" role="status">{t(DISCOVERY_MSG[discovery])}</p>}
      {/* Pending is said, never a `disabled` that drops focus (#620): pick()
          takes no second press while the dialog is up. */}
      <Button variant="ghost" className="ns-choose" onClick={() => void pick()} aria-disabled={busy === "picking" || undefined}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3.1l1.5 1.5H13c.69 0 1.25.56 1.25 1.25v6.5c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
        {t("board.newSession.chooseFolder")}
      </Button>
      {problemText ? (
        <p className="ns-problem" role="alert">
          {problemText} <span className="ns-problem-path" title={problem!.cwd}>{elidePath(problem!.cwd, 48)}</span>
        </p>
      ) : chosen ? (
        <p className="ns-where">
          <span className="ns-where-k">{t("board.newSession.folder")}</span>
          <span className="ns-where-v" title={chosen.cwd}>{elidePath(chosen.cwd, 56)}</span>
        </p>
      ) : null}
      <p className="ns-said" role="status">{busy === "checking" ? t("board.newSession.checking") : note ?? ""}</p>
      <span className="ns-label ns-label-gap" id="ns-agent-label">{t("board.newSession.agent")}</span>
      <div className="uh-range ns-agents" role="group" aria-labelledby="ns-agent-label">
        {AGENTS.map(a => (
          <Button
            key={a.agent}
            type="button"
            className="uh-range-btn"
            aria-pressed={agent === a.agent}
            onClick={() => setAgent(a.agent)}
          >
            <ProviderGlyph provider={a.agent} size={16} /> {a.label}
          </Button>
        ))}
      </div>
      {agent === "claude" && (
        <details className="ns-options">
          <summary className="ns-options-summary">
            <span>{t("board.newSession.options")}</span>
            <span className="ns-options-value">{!model && !mode && !worktree ? t("board.newSession.usesSettings") : <>{model ? MODEL_CHOICES.find(c => c.value === model)?.label : t("board.newSession.default")}{" · "}{t(MODE_CHOICES.find(c => c.value === mode)!.label)}{worktree ? ` · ${t("board.newSession.worktreeShort")}` : ""}</>}</span>
            <svg className="ns-options-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
          </summary>
          <div className="ns-options-fields">
            <label className="ns-setting" htmlFor="ns-model">
              <span className="ns-label" id="ns-model-label">{t("board.newSession.model")}</span>
              <SelectShell><select id="ns-model" aria-labelledby="ns-model-label" className="sm-select" value={model ?? ""} onChange={e => setModel(MODEL_CHOICES.find(c => c.value === e.currentTarget.value)?.value ?? null)}>
                {MODEL_CHOICES.map(c => <option key={c.label} value={c.value ?? ""}>{c.named ? c.label : t(c.label)}</option>)}
              </select></SelectShell>
            </label>
            <label className="ns-setting" htmlFor="ns-mode">
              <span className="ns-label" id="ns-mode-label">{t("board.newSession.permissions")}</span>
              <SelectShell><select id="ns-mode" aria-labelledby="ns-mode-label" className="sm-select" value={mode ?? ""} title={t(MODE_CHOICES.find(c => c.value === mode)!.title)} onChange={e => setMode(MODE_CHOICES.find(c => c.value === e.currentTarget.value)?.value ?? null)}>
                {MODE_CHOICES.map(c => <option key={c.label} value={c.value ?? ""}>{t(c.label)}</option>)}
              </select></SelectShell>
            </label>
          </div>
          <label className="ns-worktree">
            <span className="ns-worktree-label" id={WORKTREE_ID}>{t("board.newSession.worktree")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={worktree}
              aria-labelledby={WORKTREE_ID}
              className="switch"
              title={t("board.newSession.worktreeTip")}
              onClick={() => setWorktree(w => !w)}
            >
              <span className="switch-knob" />
            </button>
          </label>
        </details>
      )}
      <p className="ns-note">{t(windows ? NEW_SESSION_NOTE_WINDOWS_MSG : NEW_SESSION_NOTE_MSG)}</p>
      <div className="ns-acts">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        {/* Unavailable with no folder; while a folder is being asked about it
            is pending, said and not disabled (#620): start() takes one press. */}
        <Button variant="primary" className="primary" disabled={!chosen} aria-disabled={busy !== null || undefined} title={chosen?.cwd} onClick={() => void start()}>
          {startLabel(agent, chosen)}
        </Button>
      </div>
    </div>
  );
}

export interface NewSessionPopoverProps {
  /** The id of the control it hangs off. */
  anchorId: string;
  projects: ProjectChoice[];
  initialAgent?: TerminalProvider;
  windows?: boolean;
  onStart(agent: TerminalProvider, cwd: string, options?: LaunchOptions): void;
  onClose(): void;
}

export default function NewSessionPopover(p: NewSessionPopoverProps) {
  const searchRef = useRef<HTMLInputElement | null>(null);
  return (
    <AnchoredPopover
      anchorId={p.anchorId}
      id={NEW_SESSION_POPOVER_ID}
      className="ns-pop"
      role="dialog"
      labelledBy={TITLE_ID}
      onClose={p.onClose}
      focusRef={searchRef}
      // Both of its anchors — the navigator's "+ New session" and the empty
      // stage's button — sit at the left end of what they open into; an end
      // aligned popover from the stage's button would hang out over the
      // navigator instead of opening on the stage.
      align="start"
    >
      <NewSessionForm
        searchRef={searchRef}
        projects={p.projects}
        initialAgent={p.initialAgent}
        windows={p.windows}
        onStart={(agent, cwd, options) => { p.onStart(agent, cwd, options); p.onClose(); }}
        onCancel={p.onClose}
      />
    </AnchoredPopover>
  );
}
