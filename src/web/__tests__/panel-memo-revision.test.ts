// The consumer half of #536, which is where #575 was still living.
//
// `applyEvent` mutates GraphState in place and returns the same object, so the
// `state` prop the panels receive — `stateRef.current` — never changes identity
// after mount. A `useMemo` keyed on it therefore depends entirely on the rest of
// its dependency array, and for a long time that rest was `state.lastSeq`.
// `lastSeq` is the seq of the last envelope APPLIED: it is written on the
// envelope path and nowhere else, and it is exactly the right dependency for
// anything that really is asking "when did the last event land". It is the wrong
// one for "has anything in here changed", which is the question a memo over this
// state is always asking. #536 added `revision` for that and migrated the four
// memos in App.tsx; the two in UsagePanel and the one in SessionList were not
// part of that pass.
//
// What it cost is #575. The 250ms tick runs four sweeps over the same mutated
// object — `sweepStaleTools`, `sweepStaleSessions`, `pruneOldAgents`,
// `pruneDoneSessions` — and every one of them moves `revision` and leaves
// `lastSeq` alone, because no envelope arrived. Finish for the day with seven or
// more sessions on the board and stop typing: two minutes later
// `pruneDoneSessions` (cap 6, two-minute grace) evicts the oldest finished
// session whole, the canvas drops its cards, and the usage panel's "By session"
// table keeps its row — label, tokens and dollars — so the rows under the table
// sum past the total printed above them and nothing the user can click will
// reconcile the two. The same freeze reaches `s.state`, which draws the row's
// dot and its visually-hidden state word: `sweepStaleSessions` settles a killed
// terminal's root to `done` at ninety minutes, the card on the canvas changes
// with it, and the row keeps its green live dot for as long as the tab is open.
//
// This file checks the claim in two ways, because neither alone is enough.
//
// The first half is a fact about the world: drive the real reducer through a
// real sweep and show `revision` moving while `lastSeq` stands still, then
// show an ordinary event moving both. That is the whole premise the memos rest
// on, and it needs no DOM.
//
// The second half is a fact about the text, and it is the half that fails if the
// fix is reverted. The suite has 232 test files and none of them render React,
// so a dependency array is not reachable by anything executable here — the same
// reason `state-revision.test.ts` could only pin the producer side and said so
// in its own header. So the sources are scanned instead, the way
// `dead-css.test.ts` and `control-edges.test.ts` already scan source text for
// invariants that cannot be run: `lastSeq` may appear in no dependency array
// anywhere in the client, and each of the three migrated memos is pinned by name
// to the field it must now watch.
//
// Between them sits `memo()` below — twenty lines of `useMemo`'s caching rule
// with React removed — which lets the actual failure be reproduced here: the
// same roll-up, keyed both ways, run across a real prune, one of them still
// holding the evicted session's row.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  applyEvent, initialState, pruneDoneSessions, sweepStaleSessions, STALE_SESSION_MS,
} from "../reducer";
import type { GraphState } from "../reducer";
import type { HookEnvelope, HookPayload } from "../types";

/** The shipped constants, from App.tsx — the point is the deck as it runs, not
 *  a prune tuned to make a test pass. */
const DONE_SESSION_CAP = 6;
const DONE_SESSION_GRACE_MS = 2 * 60_000;

let seq = 0;
const send = (state: GraphState, sid: string, payload: Partial<HookPayload>, at: number) =>
  applyEvent(state, {
    seq: ++seq,
    receivedAt: at,
    payload: { session_id: sid, ...payload } as HookPayload,
  } as HookEnvelope);

/** A day's work: `count` sessions, each one started, billed and stopped. */
function aDayOfSessions(count: number): GraphState {
  seq = 0;
  let state = initialState();
  for (let i = 1; i <= count; i++) {
    state = send(state, `s${i}`, { hook_event_name: "SessionStart", cwd: `/p${i}` }, 1_000 + i);
    state = send(state, `s${i}`, {
      hook_event_name: "UsageObserved",
      model: "claude-opus-4-8",
      usage: { input_tokens: 100, output_tokens: 10 },
    } as Partial<HookPayload>, 1_500 + i);
    state = send(state, `s${i}`, { hook_event_name: "Stop" }, 2_000 + i);
  }
  return state;
}

/**
 * `useMemo`, minus React: recompute when any dependency fails Object.is against
 * last time's, otherwise hand back the cached value. That is the entire contract
 * the panels are relying on, and it is enough to watch a row outlive the session
 * it describes without mounting anything.
 */
function memo<T>(compute: () => T, deps: () => unknown[]): () => T {
  let last: unknown[] | null = null;
  let cached: T;
  return () => {
    const now = deps();
    const stale = last === null
      || now.length !== last.length
      || now.some((d, i) => !Object.is(d, last![i]));
    if (stale) { last = now; cached = compute(); }
    return cached;
  };
}

/** The shape of `bySessions` in UsagePanel, cut down to what this is about: one
 *  row per root, carrying the state that draws the dot and the tokens that are
 *  supposed to sum to the total printed above the table. */
const sessionRows = (state: GraphState) =>
  [...state.agents.values()]
    .filter(a => a.kind === "root")
    .map(a => ({ sessionId: a.sessionId, state: a.state, tokens: a.usage.inputTokens + a.usage.outputTokens }));

describe("the sweeps move revision and leave lastSeq alone", () => {
  it("evicts a finished session on the shipped constants without touching lastSeq", () => {
    const state = aDayOfSessions(9);
    const seqBefore = state.lastSeq;
    const revBefore = state.revision;

    // Two minutes and change after the last of them ended, which is the tick
    // that does this on a deck nobody is typing into any more.
    expect(pruneDoneSessions(state, 2_009 + DONE_SESSION_GRACE_MS + 1_000, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS)).toBe(true);

    expect([...state.agents.values()].filter(a => a.kind === "root")).toHaveLength(DONE_SESSION_CAP);
    expect(state.revision).toBeGreaterThan(revBefore);
    // The half that made the memo wrong: nothing arrived, so nothing moved here.
    expect(state.lastSeq).toBe(seqBefore);
  });

  it("settles a session nobody has heard from without touching lastSeq", () => {
    const state = aDayOfSessions(1);
    // Un-stop it: a terminal killed mid-turn leaves an `active` root behind,
    // which is the case sweepStaleSessions exists for.
    const root = [...state.agents.values()].find(a => a.kind === "root")!;
    root.state = "active";
    root.endedAt = undefined;
    const seqBefore = state.lastSeq;
    const revBefore = state.revision;

    expect(sweepStaleSessions(state, 2_001 + STALE_SESSION_MS + 1_000, STALE_SESSION_MS)).toBe(true);

    expect(root.state).toBe("done");
    expect(state.revision).toBeGreaterThan(revBefore);
    expect(state.lastSeq).toBe(seqBefore);
  });

  it("moves both counters when an event actually arrives", () => {
    // The other direction, and the reason this is not a blanket rename: an
    // envelope moves `lastSeq` too, and a reader that genuinely wants the last
    // applied seq — the reducer's own out-of-order guard — must keep getting it.
    const state = aDayOfSessions(1);
    const seqBefore = state.lastSeq;
    const revBefore = state.revision;
    send(state, "s1", { hook_event_name: "UserPromptSubmit", prompt: "one more thing" }, 9_000);
    expect(state.lastSeq).toBeGreaterThan(seqBefore);
    expect(state.revision).toBeGreaterThan(revBefore);
  });
});

describe("a By-session roll-up keyed the two ways", () => {
  it("keeps the evicted session's row when it watches lastSeq, and drops it when it watches revision", () => {
    const state = aDayOfSessions(9);
    const watchingLastSeq = memo(() => sessionRows(state), () => [state, state.lastSeq]);
    const watchingRevision = memo(() => sessionRows(state), () => [state, state.revision]);
    // First render, with the panel open and the deck still busy.
    expect(watchingLastSeq()).toHaveLength(9);
    expect(watchingRevision()).toHaveLength(9);

    pruneDoneSessions(state, 2_009 + DONE_SESSION_GRACE_MS + 1_000, DONE_SESSION_CAP, DONE_SESSION_GRACE_MS);

    // #575 as reported: three sessions are off the canvas, and the table still
    // has their rows and their tokens in it. The strip above the table is
    // computed from the live state, so the rows now sum past the total.
    const stale = watchingLastSeq();
    expect(stale).toHaveLength(9);
    expect(stale.reduce((n, r) => n + r.tokens, 0))
      .toBeGreaterThan(sessionRows(state).reduce((n, r) => n + r.tokens, 0));

    expect(watchingRevision()).toHaveLength(DONE_SESSION_CAP);
  });

  it("keeps the swept session's dot green when it watches lastSeq", () => {
    const state = aDayOfSessions(1);
    const root = [...state.agents.values()].find(a => a.kind === "root")!;
    root.state = "active";
    root.endedAt = undefined;
    const watchingLastSeq = memo(() => sessionRows(state), () => [state, state.lastSeq]);
    const watchingRevision = memo(() => sessionRows(state), () => [state, state.revision]);
    expect(watchingLastSeq()[0].state).toBe("active");
    expect(watchingRevision()[0].state).toBe("active");

    sweepStaleSessions(state, 2_001 + STALE_SESSION_MS + 1_000, STALE_SESSION_MS);

    // `state-${s.state}` on the dot and `stateLabel(s.state)` in the
    // visually-hidden span: a screen reader went on reading "active" ninety
    // minutes after the terminal was gone.
    expect(watchingLastSeq()[0].state).toBe("active");
    expect(watchingRevision()[0].state).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// The source scan. Nothing here renders, so the dependency arrays are checked
// as text — the same tactic dead-css.test.ts and control-edges.test.ts use for
// invariants with no runtime to assert against.

const web = fileURLToPath(new URL("..", import.meta.url));

/** Every client source that ends up in the bundle. The suite's own files are
 *  excluded: this very file names `state.lastSeq` inside a dependency array on
 *  purpose, to show what it does. */
function clientSources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : clientSources(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}
const sources: [string, string][] = clientSources(web)
  // Forward slashes on every platform, so a failure message reads the same on
  // Windows as it does in CI.
  .map(p => [p.slice(web.length).replaceAll("\\", "/"), readFileSync(p, "utf8")]);

/** Every `[...]` that does not cross a newline. Every dependency array in this
 *  client is written on one line — `}, [state, state.revision, now]);` — so this
 *  is a superset of them, and the extra it picks up is an ordinary array
 *  literal, which has no business naming `lastSeq` either. */
const bracketGroups = (src: string) => [...src.matchAll(/\[[^[\]\n]*\]/g)].map(m => m[0]);

/** What a memo watches on the state: all three of these open their dependency
 *  array as `[state, state.something`, because the prop's identity never moves
 *  and the field beside it is the whole of the recompute rule. */
function watchedField(file: string, anchor: string): string {
  const src = sources.find(([p]) => p === file)?.[1];
  if (src == null) throw new Error(`no such client source: ${file}`);
  const at = src.indexOf(anchor);
  if (at < 0) throw new Error(`anchor is no longer in ${file}: ${anchor}`);
  const m = src.slice(at).match(/\[\s*state\s*,\s*state\.(\w+)/);
  if (m == null) throw new Error(`no [state, state.…] dependency array after the anchor in ${file}`);
  return m[1];
}

describe("no memo in the client watches lastSeq", () => {
  it("names lastSeq in no dependency array anywhere", () => {
    // `lastSeq` has one legitimate reader — the out-of-order guard in
    // reducer.ts, which reads it as a bare comparison and not from an array —
    // and no business appearing in a dependency list at all.
    const offenders = sources.flatMap(([path, src]) =>
      bracketGroups(src).filter(g => /\blastSeq\b/.test(g)).map(g => `${path}  ${g}`));
    expect(offenders).toEqual([]);
  });

  it("rebuilds the usage panel's By-session rows on revision, which is the row that outlived its session", () => {
    expect(watchedField("components/UsagePanel.tsx", "const bySessions = useMemo(")).toBe("revision");
  });

  it("rebuilds the usage panel's headline totals on revision rather than on the clock beside them", () => {
    // This one lists `now` as well, for `burnRate`, and `now` is a fresh
    // Date.now() on every 250ms tick — so it recomputed regardless of what its
    // state dependency said, and the strip stayed honest through a prune by
    // luck. Migrated anyway: the day this memo gets a cheaper refresh rule, the
    // luck goes with it and nothing in the diff would explain the bug arriving.
    expect(watchedField("components/UsagePanel.tsx", "const { byModel, totalCost, totalTokens, burnRate } = useMemo("))
      .toBe("revision");
  });

  it("rebuilds the session list's rows on revision, for the same reason", () => {
    expect(watchedField("components/SessionList.tsx", "const rows = useMemo(")).toBe("revision");
  });
});
