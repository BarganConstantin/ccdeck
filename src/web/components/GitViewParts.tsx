// The small parts the git view and the glance share: their glyphs, the three
// commit marks, the collision line, the one-line state of a folder with no
// repository to show, and the card a commit row opens with `i`.
import { pressHow, type PressHow } from "../agent-goto";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MutableRefObject, type Ref } from "react";

import { fitBranch } from "../git-chip";
import { monoMeasure } from "../git-path-fit";

import { copyText } from "../copy-text";
import { failureLasts, failureLine } from "../git-diff-parse";
import type { LogCommit } from "../git-view-types";
import { andList, commitMark, readStateLine, type Collision, type MarkLevel } from "../git-view-words";
import { isEscapeKey } from "../modal-dismiss";

// The view's own glyphs, drawn to the deck's 14px grid at a 1.4 stroke.
const PATHS = {
  branch: <><circle cx="4.4" cy="3.3" r="1.4" /><circle cx="4.4" cy="10.7" r="1.4" /><circle cx="9.8" cy="4.6" r="1.4" /><path d="M4.4 4.7v4.6M9.8 6c0 2.4-2.2 2.8-5.2 3.5" /></>,
  commit: <><circle cx="7" cy="7" r="2.3" /><path d="M1.6 7h3.1M9.3 7h3.1" /></>,
  back: <path d="M8.6 3 4.6 7l4 4" />,
  close: <path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" />,
  chev: <path d="M5.2 3.4 8.8 7l-3.6 3.6" />,
  share: <path d="M2.4 5h8.8l-2.1-2.1M11.6 9H2.8l2.1 2.1" />,
  // two arrows meeting at a bar: "both here", never read as a close ×
  clash: <path d="M7 2.6v8.8M1.4 7h3.4M3.4 5 5.2 7 3.4 9M12.6 7H9.2M10.6 5 8.8 7l1.8 2" />,
  copy: <><rect x="4.8" y="4.8" width="6.8" height="6.8" rx="1.3" /><path d="M9.2 4.8V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v4.7a1 1 0 0 0 1 1h1.3" /></>,
  focus: <><circle cx="7" cy="7" r="2.2" /><path d="M7 1.6v2M7 10.4v2M1.6 7h2M10.4 7h2" /></>,
} as const;
export type GvIconName = keyof typeof PATHS;
export function GvIcon({ name, size = 13 }: { name: GvIconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={name === "clash" ? 1.5 : 1.4}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
  );
}

/** The three marks a commit can carry: seen by ccdeck, from the commit's
 *  message, no agent seen — a shape each, so colour never carries it alone. */
export function GvMark({ level }: { level: MarkLevel }) {
  return (
    <svg className="gv-mark" data-level={level} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {level === "round" ? <circle cx="5" cy="5" r="3.2" /> : <path d="M5 0.9 9.1 5 5 9.1 0.9 5z" />}
    </svg>
  );
}

/** A collision as one line: sharp in the error colour naming the file, quiet
 *  in the muted tier; either is a way to the other agent. */
export function CollisionLine({ c, who = [], other, otherCli, where, onFocus, also = [] }: {
  c: Collision;
  /** The session's own agents it is about, by name ("↳ docs-sync"), when the
   *  agent in view is not one of them: they are named before the other agent. */
  who?: string[];
  /** The other agent's name. */
  other: string;
  /** Its CLI, said in the wide view's sentence ("Codex"), when known. */
  otherCli: string | null;
  where: "wide" | "glance";
  /** A press on it: the way to the other agent, told how it was made. */
  onFocus: (how: PressHow) => void;
  /** The other agents of the same kind after `other`, each with its files
   *  when sharp: counted after its name ("+1"), as the card counts them, and
   *  named on hover. */
  also?: { name: string; files: string[] }[];
}) {
  const press = (e: { detail: number }) => onFocus(pressHow(e));
  const them = andList(who);
  const many = Math.max(1, who.length) + 1 + also.length > 2;
  const ended = many ? "None of them has ended." : "Neither has ended.";
  const more = also.length ? ` +${also.length}` : "";
  const alsoSaid = also.length ? ` Also ${also.map(a => (a.files.length ? `${a.name}: ${a.files.join(", ")}` : a.name)).join("; ")}.` : "";
  if (c.level === "sharp") {
    const file = c.files[0] ?? "";
    const moreFiles = c.files.length > 1 ? ` and ${c.files.length - 1} more` : "";
    const since = `since ${c.files.length === 1 ? "it was" : "they were"} last committed. ${ended}`;
    if (where === "glance") {
      const title = who.length
        ? `${them} and ${other} ${many ? "" : "both "}edited ${c.files.join(", ")} ${since}`
        : `${other} also edited ${c.files.join(", ")} ${since}`;
      return (
        <button type="button" className="gv-g-collide" title={`${title}${alsoSaid} Select ${other}.`} onClick={press}>
          <GvIcon name="clash" />
          <span><b>{file}</b>{moreFiles} {who.length ? `edited by ${them} and ${other}${more}` : `also edited by ${other}${more}`}</span>
        </button>
      );
    }
    // The tooltip opens with the line's own words, so a line cut short is whole there.
    const cli = otherCli ? ` (${otherCli})` : "";
    const said = who.length
      ? `${them} and ${other}${cli} ${many ? "" : "both "}edited ${c.files.join(", ")} ${since}${alsoSaid}`
      : `${other}${cli} also edited ${c.files.join(", ")} ${since}${alsoSaid}`;
    return (
      <div className="gv-collide-line" role="note" title={said}>
        <GvIcon name="clash" />
        {who.length
          ? <span><b>{them}</b> and <b>{other}</b>{more}{cli} {many ? "" : "both "}edited <b>{file}</b>{moreFiles} since it was last committed. {ended}</span>
          : <span><b>{other}</b>{more}{cli} also edited <b>{file}</b>{moreFiles} since it was last committed. {ended}</span>}
        <button type="button" className="gv-link" onClick={press}>Focus {other}</button>
      </div>
    );
  }
  const branch = c.reason === "same-branch";
  const what = who.length
    ? `${them} ${branch ? `${who.length > 1 ? "work" : "works"} on the same branch as` : `${who.length > 1 ? "share" : "shares"} a folder with`}`
    : branch ? "Works on this branch in another folder:" : "Shares this folder with";
  const others = andList([other, ...also.map(a => a.name)]);
  const place = branch ? "on the same branch" : "in the same folder";
  const title = who.length
    ? `${them} works ${place} as ${others}. Select ${other}.`
    : `${others} ${also.length ? "work" : "works"} ${place}. Select ${also.length ? other : "it"}.`;
  const button = (
    <button type="button" className="gv-g-quiet" title={title} onClick={press}>
      <GvIcon name="share" /><span>{what} {other}{more}</span>
    </button>
  );
  return where === "glance" ? button : <div className="gv-quiet-line">{button}</div>;
}

/** The one line a pane says when the folder has no repository to show. */
export function ReadStateLine({ state, folder, className = "gv-pane-empty", lineRef }: {
  state: Parameters<typeof readStateLine>[0]; folder: string | null; className?: string;
  lineRef?: Ref<HTMLParagraphElement>;
}) {
  const line = readStateLine(state, folder);
  if (!line) return null;
  return (
    <p className={className} ref={lineRef}>
      {line.folder && <><code title={line.folder}>{line.folder}</code> </>}<b>{line.lead}</b>{line.rest && <span> {line.rest}</span>}
    </p>
  );
}

/** The history pane when its read failed while the folder's other reads
 *  worked: why, and Try again wherever reading again can mend it. */
export function HistoryFailed({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div className="gv-pane-empty">
      <b>Could not read the history.</b>
      <span>{failureLine(reason)}</span>
      {!failureLasts(reason) && <button type="button" className="btn gv-retry" onClick={onRetry}>Try again</button>}
    </div>
  );
}

const HIDDEN: CSSProperties = { visibility: "hidden" };

/** What the commit card says about who made a commit. */
export interface CommitCardFacts {
  commit: LogCommit;
  who: string | null;
  /** "↳" for a subagent, so the name reads as one. */
  sub: boolean;
  hue: number | null;
  /** The CLI and the model the agent ran on, when the deck saw it. */
  model: string | null;
  /** How long the agent had worked when it made the commit. */
  worked: string | null;
  /** The card to show on the canvas: only for an agent the deck saw. */
  cardId: string | null;
}

/**
 * The card a commit row opens with `i` (and its agent chip with a click):
 * who made it and how the deck knows, and its two actions, Show on canvas and
 * Copy SHA. A small dialog: focus starts on its first button, Tab stays
 * between its buttons, and Esc or focus leaving it closes it and hands focus
 * back to the row.
 */
export function CommitCard({ facts, anchor, onShow, onClose }: {
  facts: CommitCardFacts;
  anchor: DOMRect | null;
  onShow: (cardId: string, how: PressHow) => void;
  onClose: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const [copied, setCopied] = useState(false);
  const { commit, who } = facts;
  const mark = commitMark(commit.agent);
  const short = commit.sha.slice(0, 7);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = anchor ?? { left: window.innerWidth / 2, top: window.innerHeight / 2, bottom: window.innerHeight / 2, width: 0 };
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width - w - 12), window.innerWidth - w - 8);
    const top = r.bottom + 6 + h > window.innerHeight - 8 ? r.top - h - 6 : r.bottom + 6;
    // Placed before it is first painted, and shown, so focus can land in it.
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.visibility = "visible";
    el.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isEscapeKey(e.key)) { e.preventDefault(); e.stopPropagation(); onClose(true); return; }
    if (e.key !== "Tab") return;
    const buttons = [...(ref.current?.querySelectorAll<HTMLElement>("button") ?? [])];
    if (!buttons.length) return;
    e.preventDefault();
    const at = buttons.indexOf(document.activeElement as HTMLElement);
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  };
  return (
    <div
      ref={ref} className="gv-card" role="dialog" aria-label={`${who ?? "Commit"}, commit ${short}`} style={HIDDEN}
      onKeyDown={onKeyDown}
      onBlur={e => { if (!ref.current?.contains(e.relatedTarget as Node | null)) onClose(false); }}
    >
      <div className="gv-pop-head" style={facts.hue != null ? { "--session-hue": facts.hue } as CSSProperties : undefined}>
        {mark.level === "seen" ? <i className="gv-swatch" aria-hidden="true" /> : <GvMark level={mark.level} />}
        <b>{facts.sub ? "↳ " : ""}{who ?? "No agent seen"}</b>
        <span className="gv-pop-level"><GvMark level={mark.level} />{mark.words}</span>
      </div>
      {mark.level === "trailer" && (
        <p className="gv-pop-line">The message carries a <code>Co-authored-by</code> line naming {who}. ccdeck did not see this commit being made, so it cannot say which session or model.</p>
      )}
      {mark.level === "round" && <p className="gv-pop-line">No agent was seen making this commit. That does not mean a person made it.</p>}
      <dl className="gv-pop-dl">
        {facts.model && <><dt>Model</dt><dd>{facts.model}</dd></>}
        {facts.worked && <><dt>Worked</dt><dd>{facts.worked}</dd></>}
        <dt>Author</dt><dd>{commit.author.name}</dd>
      </dl>
      <div className="gv-pop-foot gv-card-actions">
        <span className="gv-card-sha" title={commit.sha}>{short}</span>
        {facts.cardId && (
          <button type="button" className="btn gv-card-btn" onClick={e => onShow(facts.cardId!, pressHow(e))}>
            <GvIcon name="focus" /><span>Show on canvas</span>
          </button>
        )}
        <button type="button" className="btn gv-card-btn" aria-label={`Copy commit SHA ${short}`}
          onClick={() => { void copyText(commit.sha).then(ok => setCopied(ok)); }}>
          <GvIcon name="copy" /><span>{copied ? "Copied" : "Copy SHA"}</span>
        </button>
      </div>
    </div>
  );
}

/** The branch name, cut by measuring its box: the ticket first and never cut
 *  inside it (git-chip.ts), the whole name in the tooltip. A name with a short
 *  form of its own — a detached HEAD's bare SHA, whose glyph already says
 *  detached — shows that instead of being cut. React's own text node is
 *  rewritten, so React keeps owning it. */
/** The size the header's and the glance's branch names are set in
 *  (git-view.css), stated rather than asked of the element on every fit. */
export const BRANCH_PX = 12;

export function useFittedName(name: string, watch: MutableRefObject<HTMLElement | null>, room: unknown = null, short: string | null = null) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    const text = el?.firstChild;
    if (!el || !text || text.nodeType !== 3) return;
    // Each spelling is measured in the label's own font, as the card's chip
    // measures its own: a wide character (CJK, an emoji) takes two cells of
    // the mono stack, and a count of characters would miss it. The spellings
    // cut between the characters a reader sees, never inside one.
    const fit = () => {
      text.nodeValue = name;
      const room = el.clientWidth;
      const full = el.scrollWidth;
      if (full <= room + 1 || !name.length) return;
      if (short) { text.nodeValue = short; return; }
      const measure = monoMeasure(BRANCH_PX);
      text.nodeValue = fitBranch(name, t => measure(t) <= room);
    };
    // The first fit waits for the first frame, which paints the CSS ellipsis;
    // the observer then answers every width the box is given, and `room`
    // changing — something beside the name arrived — fits it again.
    const raf = requestAnimationFrame(fit);
    const host = watch.current;
    const ro = host && typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
    if (ro && host) ro.observe(host);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [name, room, short]);
  return ref;
}

