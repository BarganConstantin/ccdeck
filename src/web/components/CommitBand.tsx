import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { pressHow } from "../agent-goto";
import { focusCanvasNode } from "../canvas-node-element";
import { BAND_ROW_H, BAND_WINDOW_MS, bandView, laneSlot, type BandCommit, type CardBand } from "../git-commit-band";
import { parseSlotMemory, repoSlots } from "../git-graph-layout";
import { openGitFor } from "../git-open";
import { shortAge } from "../git-view-words";
import { readStored } from "../storage";
import { useNow } from "../use-now";
import { LANE_MEMORY_KEY } from "./GitGraph";

const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** A commit counts as landing — its row slides in and its dot glows — only
 *  when the lane hears of it this fresh: one handed over on a reconnect or a
 *  restart is already there. */
const LANDING_MS = 20_000;
/** How long a landed row keeps its entrance, past the 1s glow. */
const LANDED_MS = 1_200;
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const NO_ROWS: { rows: BandCommit[]; earlier: number } = { rows: [], earlier: 0 };

const sameView = (a: { rows: BandCommit[]; earlier: number } | null, b: { rows: BandCommit[]; earlier: number } | null) =>
  a === b || (!!a && !!b && a.earlier === b.earlier && a.rows.length === b.rows.length && a.rows.every((r, i) => r === b.rows[i]));

/** "now", "2 minutes", "1 minute" — the age a row's accessible name says. */
function ageWords(at: number, now: number): string {
  const m = Math.floor(Math.max(0, now - at) / 60_000);
  return m < 1 ? "just now" : `${m} minute${m === 1 ? "" : "s"} ago`;
}

/**
 * THE LANE UNDER A CARD (git-commit-band.ts): one row a commit its agent was
 * seen making in the last half hour, newest on top — a filled diamond on a
 * thin line in its branch's colour, the subject, who made it when it was a
 * subagent, and its age — and the rest folded into "+N earlier · g".
 *
 * Drawn in the card's node, under the card, with no box of its own: the node
 * is measured with it, so the layout makes room for it as it does for any
 * taller card. Hidden at the zoomed-out faces, keeping its room (git-band.css),
 * and not drawn at all while Git is switched off in Appearance.
 *
 * Time reaches it on the deck's shared beat (use-now.ts): an age moves on, a
 * commit past the half hour leaves, and the lane fades out with the last one.
 *
 * LIVE. A commit that lands slides in from the top while the rows under it
 * move down a row (a FLIP over 200ms on the house curve), its diamond grows
 * in, and the newest glows once and settles. Under reduced motion the row
 * fades in and nothing travels. What was there when the card was drawn — a
 * reload, a reconnect — is simply there.
 *
 * A row opens the git view on its commit; the fold opens it on the agent.
 * One stop for Tab: ↑ and ↓ move between the rows and the fold.
 */
export function CommitBand({ band, agentId }: { band: CardBand | null; agentId: string }) {
  const now = useNow(1000);
  const view = band ? bandView(band.commits, now) : NO_ROWS;

  // The last lane drawn, kept while it fades out.
  const [last, setLast] = useState<{ rows: BandCommit[]; earlier: number } | null>(view.rows.length ? view : null);
  if (view.rows.length && !sameView(view, last)) setLast(view);
  const shown = view.rows.length ? view : last;
  const leaving = !view.rows.length && last != null;
  // A lane that cannot finish its fade — a tab the browser is not painting —
  // goes on the next beat anyway.
  const leftAt = useRef<number | null>(null);
  if (!leaving) leftAt.current = null;
  else if (leftAt.current == null) leftAt.current = Date.now();
  else if (Date.now() - leftAt.current >= 1_000) setLast(null);

  // Which rows are landing now. Not what the first draw holds — an empty one
  // too, so a card drawn before its first commit animates that commit — and
  // not a commit older than LANDING_MS: those were already there.
  const drawn = useRef<Set<string> | null>(null);
  const landed = useRef(new Map<string, number>());
  const rows = shown?.rows ?? [];
  if (drawn.current == null) drawn.current = new Set(rows.map(r => r.sha));
  else {
    for (const r of rows) {
      if (drawn.current.has(r.sha)) continue;
      drawn.current.add(r.sha);
      if (Date.now() - r.at < LANDING_MS) landed.current.set(r.sha, Date.now());
    }
  }
  for (const [sha, at] of landed.current) if (Date.now() - at > LANDED_MS) landed.current.delete(sha);
  const glowing = rows.find(r => landed.current.has(r.sha))?.sha ?? null;

  // The colours the git view's history gave these branches in this
  // repository, read once per repository and set of branches.
  const branches = rows.map(r => r.branch ?? "").join("\0");
  const remembered = useMemo(
    () => (band?.repo ? repoSlots(parseSlotMemory(readStored(LANE_MEMORY_KEY)), band.repo) : new Map<string, number>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [band?.repo, branches],
  );

  // Rows that moved since the last draw slide from where they were.
  const list = useRef<HTMLOListElement>(null);
  const placed = useRef(new Map<string, number>());
  const order = rows.map(r => r.sha).join(",");
  useLayoutEffect(() => {
    const before = placed.current;
    placed.current = new Map(rows.map((r, i) => [r.sha, i]));
    const el = list.current;
    if (!el || reducedMotion()) return;
    rows.forEach((r, i) => {
      const was = before.get(r.sha);
      if (was === undefined || was === i) return;
      el.children[i]?.animate([{ transform: `translateY(${(was - i) * BAND_ROW_H}px)` }, { transform: "translateY(0)" }], { duration: 200, easing: EASE });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order]);

  // The keyboard on a row that has gone, or in a lane that is fading out:
  // onto the newest row, or back to the card.
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef<string | null>(null);
  useLayoutEffect(() => {
    const was = focused.current;
    if (was == null) return;
    const active = document.activeElement;
    if (leaving) {
      if (root.current?.contains(active)) { focused.current = null; focusCanvasNode(agentId); }
      return;
    }
    if (rows.some(r => r.sha === was) || (active && active !== document.body)) return;
    focused.current = null;
    const next = root.current?.querySelector<HTMLElement>(".git-band-commit");
    if (next) next.focus({ preventScroll: true });
    else focusCanvasNode(agentId);
  });

  // One tab stop: the row last focused, else the newest.
  const [stop, setStop] = useState<string | null>(null);
  const stopAt = rows.some(r => r.sha === stop) ? stop : rows[0]?.sha ?? null;

  if (!shown || !rows.length) return null;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const stops = [...(root.current?.querySelectorAll<HTMLElement>(".git-band-commit, .git-band-fold") ?? [])];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const to = e.key === "Home" ? 0 : e.key === "End" ? stops.length - 1 : Math.max(0, Math.min(stops.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
    stops[to].focus({ preventScroll: true });
  };
  const earlier = shown.earlier;
  return (
    <div
      ref={root}
      className="git-band"
      data-leaving={leaving ? "" : undefined}
      aria-hidden={leaving ? true : undefined}
      onKeyDown={onKeyDown}
      onBlur={e => {
        // Focus that went somewhere else is not looked after; focus that went
        // with its row (a commit leaving the window) is.
        const to = e.relatedTarget as Node | null;
        if (to ? !e.currentTarget.contains(to) : (e.target as Node).isConnected) focused.current = null;
      }}
      onDoubleClick={e => e.stopPropagation()}
      onAnimationEnd={e => { if (leaving && e.target === e.currentTarget && e.animationName === "git-band-out") setLast(null); }}
    >
      {/* The role said out loud: Safari takes it away from a list drawn with no markers. */}
      <ol ref={list} className="git-band-rows" role="list" aria-label={`Commits in the last ${BAND_WINDOW_MS / 60_000} minutes`} data-fold={earlier > 0 ? "" : undefined}>
        {rows.map(r => {
          const slot = laneSlot(r.branch, remembered) + 1;
          const age = shortAge(r.at, now);
          const sel = FULL_SHA.test(r.sha) ? r.sha : null;
          const subject = r.subject || r.short;
          return (
            <li key={r.sha} className="git-band-row" data-slot={slot} data-landed={landed.current.has(r.sha) ? "" : undefined}
              data-glow={r.sha === glowing ? "" : undefined}>
              <button
                type="button"
                className="git-band-commit nodrag"
                tabIndex={leaving || r.sha !== stopAt ? -1 : 0}
                title={[subject, [r.short, "seen by ccdeck", r.who, age === "now" ? "just now" : `${age} ago`].filter(Boolean).join(" · ")].join("\n")}
                aria-label={`${subject}, ${[r.who ? `by ${r.who.slice(2)}` : "", ageWords(r.at, now), `commit ${r.short}, seen by ccdeck`].filter(Boolean).join(", ")}. Open it in the git view`}
                onFocus={() => { focused.current = r.sha; setStop(r.sha); }}
                onClick={e => {
                  e.stopPropagation();
                  if (leaving) return;
                  openGitFor(agentId, pressHow(e), sel ? { sel } : undefined);
                }}
              >
                <span className="git-band-dot" aria-hidden="true" />
                <span className="git-band-subject">{subject}</span>
                {r.who && <span className="git-band-who">{r.who}</span>}
                <span className="git-band-age">{age}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {earlier > 0 && (
        <button
          type="button"
          className="git-band-fold nodrag"
          data-slot={laneSlot(rows[rows.length - 1].branch, remembered) + 1}
          tabIndex={-1}
          title={`${earlier} more ${earlier === 1 ? "commit" : "commits"} in the last ${BAND_WINDOW_MS / 60_000} minutes. Open the git view (g)`}
          aria-label={`${earlier} earlier ${earlier === 1 ? "commit" : "commits"}. Open the git view`}
          onFocus={() => { focused.current = "+fold"; }}
          onClick={e => {
            e.stopPropagation();
            if (leaving) return;
            openGitFor(agentId, pressHow(e));
          }}
        >
          <span>+{earlier} earlier</span>
          <span className="git-band-key" aria-hidden="true">&nbsp;·&nbsp;<kbd>g</kbd></span>
        </button>
      )}
    </div>
  );
}
