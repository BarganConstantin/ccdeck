// "New session": start Claude or Codex in a project, in the deck's own tmux,
// and put it on the stage (v3, the Claude app's "New chat" place).
//
// THREE CHOICES AND A BUTTON THAT SAYS WHAT IT WILL DO. The agent; the
// project, from every folder a session on the board ran in — the stage's own
// first — or a full path typed in; and a button that reads "Start Claude in
// paycore", so the press is never a guess. One sentence says what the reader
// cannot see: the session joins the board and closing the stage never stops
// it.
//
// BUILT FROM THE DECK'S OWN CONTROLS, so their focus, press and contrast are
// the ones already measured rather than a new kind each: the agent is the
// usage modal's range strip (.uh-range, a pair of pressed buttons), the
// project is Settings' station list (.appearance-source-list, options a
// highlight ring walks), and the path is the shared text field. The field is
// the combobox: it holds focus, ↑ and ↓ walk the projects under it through
// aria-activedescendant, typing a path sets the list aside, and Enter starts.
// One focus stop for "which folder", whichever way it is answered.
//
// A POPOVER, NOT A DIALOG. It hangs off the control that opened it — "+ New
// session" at the top of the navigator, or the empty stage's own button — and
// is AnchoredPopover's: portalled, placed against the window, Escape and the
// outside press close it and focus goes back to the anchor. It opens opaque
// from the first frame (a scale from 0.97, no fade), because a translucent
// form over a running terminal is two things read at once.
//
// CLAUDE'S OWN THREE CHOICES, for a new Claude only: the model, how it asks
// for permission, and whether it works in a new git worktree — the choices
// the Claude app's new chat offers, as Claude Code's own flags. Each starts at
// "Default", which passes nothing and leaves the reader's settings in charge;
// no choice here stops it asking (the launcher refuses those modes anyway).
// Codex is started as it is.
//
// The form is its own component with no portal, so the suite can render it
// whole and press its controls without a DOM.
import { useState, type CSSProperties, type KeyboardEvent } from "react";
import AnchoredPopover from "../AnchoredPopover";
import type { LaunchOptions, TerminalProvider } from "../../terminal-api";
import { elidePath, folderName, isAbsolutePath, type ProjectChoice } from "./stage-model";
import { ProviderGlyph } from "./stage-icons";

export const NEW_SESSION_POPOVER_ID = "ns-pop";
const TITLE_ID = "ns-title";
const LIST_ID = "ns-projects";
const WORKTREE_ID = "ns-worktree-label";
const optionId = (i: number) => `ns-opt-${i}`;

export interface NewSessionFormProps {
  projects: ProjectChoice[];
  initialAgent?: TerminalProvider;
  onStart(agent: TerminalProvider, cwd: string, options?: LaunchOptions): void;
  onCancel(): void;
}

export const MODEL_CHOICES: Array<{ value: LaunchOptions["model"] | null; label: string }> = [
  { value: null, label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

export const MODE_CHOICES: Array<{ value: LaunchOptions["permissionMode"] | null; label: string; title: string }> = [
  { value: null, label: "Default", title: "As your Claude Code settings say" },
  { value: "auto", label: "Auto", title: "Claude approves what it judges safe, and asks about the rest" },
  { value: "acceptEdits", label: "Edits", title: "File edits go ahead; everything else asks" },
  { value: "plan", label: "Plan", title: "Plans first, changes nothing until you approve" },
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

/** Where a start would go: the typed folder when there is one, else the
 *  chosen project. Null when the typed text is not a folder the deck can use. */
export function startTarget(projects: ProjectChoice[], chosen: number, typed: string): { cwd: string; name: string } | null {
  const path = typed.trim();
  if (path) return isAbsolutePath(path) ? { cwd: path, name: folderName(path) } : null;
  const p = projects[chosen];
  return p ? { cwd: p.cwd, name: p.name } : null;
}

/** The start button's words: what it will do, named. */
export function startLabel(agent: TerminalProvider, target: { name: string } | null): string {
  const who = agent === "codex" ? "Codex" : "Claude";
  return target ? `Start ${who} in ${target.name}` : `Start ${who}`;
}

export function NewSessionForm({ projects, initialAgent = "claude", onStart, onCancel }: NewSessionFormProps) {
  const [agent, setAgent] = useState<TerminalProvider>(initialAgent);
  const [chosen, setChosen] = useState(0);
  const [typed, setTyped] = useState("");
  const [model, setModel] = useState<LaunchOptions["model"] | null>(null);
  const [mode, setMode] = useState<LaunchOptions["permissionMode"] | null>(null);
  const [worktree, setWorktree] = useState(false);
  const target = startTarget(projects, chosen, typed);
  const listing = typed.trim() === "";
  const start = () => {
    if (!target) return;
    const options = agent === "claude" ? launchOptions(model, mode, worktree) : undefined;
    if (options) onStart(agent, target.cwd, options);
    else onStart(agent, target.cwd);
  };

  // The field's keys: ↑/↓ walk the projects (and leave a half-typed path, the
  // way choosing from a list means not typing one), Enter starts.
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && projects.length) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : projects.length - 1;
      setChosen(i => (listing ? (i + step) % projects.length : i));
      setTyped("");
    } else if (e.key === "Enter") {
      e.preventDefault();
      start();
    }
  };

  return (
    <div className="ns-form">
      <h3 id={TITLE_ID} className="ns-title">New session</h3>
      <span className="ns-label" id="ns-agent-label">Agent</span>
      <div className="uh-range ns-agents" role="group" aria-labelledby="ns-agent-label">
        {AGENTS.map(a => (
          <button
            key={a.agent}
            type="button"
            className="uh-range-btn"
            aria-pressed={agent === a.agent}
            onClick={() => setAgent(a.agent)}
          >
            <ProviderGlyph provider={a.agent} size={11} /> {a.label}
          </button>
        ))}
      </div>
      <span className="ns-label" id="ns-project-label">Project</span>
      {projects.length > 0 && (
        <div className="appearance-source-list ns-list" id={LIST_ID} role="listbox" aria-labelledby="ns-project-label">
          {projects.map((q, i) => (
            <div
              key={q.cwd}
              id={optionId(i)}
              className="appearance-source-option ns-option"
              role="option"
              aria-selected={listing && i === chosen}
              data-highlighted={(listing && i === chosen) || undefined}
              title={q.cwd}
              style={{ "--ns-hue": q.hue } as CSSProperties}
              onClick={() => { setChosen(i); setTyped(""); }}
            >
              <i className="ns-dot" aria-hidden="true" />
              <span className="ns-name">{q.name}</span>
              <span className="ns-path">{elidePath(q.cwd, 22)}</span>
            </div>
          ))}
        </div>
      )}
      <input
        className="ap-manage-input ns-field"
        type="text"
        name="project-path"
        role="combobox"
        aria-expanded={projects.length > 0}
        aria-controls={projects.length ? LIST_ID : undefined}
        aria-activedescendant={listing && projects.length ? optionId(chosen) : undefined}
        aria-autocomplete="none"
        spellCheck={false}
        autoComplete="off"
        placeholder="/absolute/path to another folder"
        aria-label="Project, or another folder as a full path"
        aria-invalid={!listing && !target ? true : undefined}
        value={typed}
        onChange={e => setTyped(e.target.value)}
        onKeyDown={onFieldKey}
      />
      {!listing && !target && <p className="ns-note" role="status">A full path, starting with /.</p>}
      {agent === "claude" && (
        <>
          <span className="ns-label ns-label-gap" id="ns-model-label">Model</span>
          <div className="uh-range ns-choices" role="group" aria-labelledby="ns-model-label">
            {MODEL_CHOICES.map(c => (
              <button key={c.label} type="button" className="uh-range-btn" aria-pressed={model === c.value} onClick={() => setModel(c.value)}>
                {c.label}
              </button>
            ))}
          </div>
          <span className="ns-label" id="ns-mode-label">Permissions</span>
          <div className="uh-range ns-choices" role="group" aria-labelledby="ns-mode-label">
            {MODE_CHOICES.map(c => (
              <button key={c.label} type="button" className="uh-range-btn" aria-pressed={mode === c.value} title={c.title} onClick={() => setMode(c.value)}>
                {c.label}
              </button>
            ))}
          </div>
          <label className="ns-worktree">
            <span className="ns-worktree-label" id={WORKTREE_ID}>In a new git worktree</span>
            <button
              type="button"
              role="switch"
              aria-checked={worktree}
              aria-labelledby={WORKTREE_ID}
              className="switch"
              title="Claude works on a branch of its own, in a folder of its own, beside the project"
              onClick={() => setWorktree(w => !w)}
            >
              <span className="switch-knob" />
            </button>
          </label>
        </>
      )}
      <p className="ns-note">It joins the board as its own cluster and opens here, inside the deck's tmux — closing the stage never stops it.</p>
      <div className="ns-acts">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={!target} onClick={start}>{startLabel(agent, target)}</button>
      </div>
    </div>
  );
}

export interface NewSessionPopoverProps {
  /** The id of the control it hangs off. */
  anchorId: string;
  projects: ProjectChoice[];
  initialAgent?: TerminalProvider;
  onStart(agent: TerminalProvider, cwd: string, options?: LaunchOptions): void;
  onClose(): void;
}

export default function NewSessionPopover(p: NewSessionPopoverProps) {
  return (
    <AnchoredPopover
      anchorId={p.anchorId}
      id={NEW_SESSION_POPOVER_ID}
      className="ns-pop"
      role="dialog"
      labelledBy={TITLE_ID}
      onClose={p.onClose}
      // Both of its anchors — the navigator's "+ New session" and the empty
      // stage's button — sit at the left end of what they open into; an end
      // aligned popover from the stage's button would hang out over the
      // navigator instead of opening on the stage.
      align="start"
    >
      <NewSessionForm
        projects={p.projects}
        initialAgent={p.initialAgent}
        onStart={(agent, cwd, options) => { p.onStart(agent, cwd, options); p.onClose(); }}
        onCancel={p.onClose}
      />
    </AnchoredPopover>
  );
}
