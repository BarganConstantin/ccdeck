// #687: "total spend" over a sum that a timer shrinks.
//
// Not an arithmetic defect. Every figure the deck computed was correct; the
// word above it was not. The usage panel's headline read "total spend" and the
// topbar's chip beside it read "cost", and both walked `state.agents` — the
// agents on the canvas at that instant. The canvas evicts finished sessions on
// a two-minute timer with a cap of six, so the figure goes DOWN, on a tick, with
// nothing having changed and nothing on screen to account for it.
//
// The measurement this file starts from is the reporter's, reproduced exactly
// through the real reducer and the shipped constants:
//
//     ten finished sessions on the canvas: 10 agents · $75.00 · 11.00M tok
//     after one prune sweep             :  6 agents · $45.00 ·  6.60M tok
//     the same ten sessions really spent : $75.00
//
// A third of the money gone in one 250ms tick. The token half is the same
// defect in the other currency and the report did not name it: the topbar's
// "tokens" chip and the panel's `in`/`out` strip fall by the same 40%.
//
// WHICH REPAIR, AND WHY NOT THE OTHER. Two were available. Keep a running total
// that survives the prune, so "total" means what it says; or say what is
// actually being summed. The first is wrong here, and the reason is not cost:
// `pruneDoneSessions` evicts on `endedAt`, which `Stop` writes at a TURN
// boundary, and its own doc comment records a replay in which 20 sessions were
// evicted and 7 of them produced more events afterwards under the same session
// id. An accumulator would bank those dollars at eviction and count them again
// when the session came back, so the "total" would over-report — and a figure
// that reads too high is worse than one that reads too low, because nothing on
// screen can contradict it. It would also reset on reload and re-open #575's
// disagreement between the headline and the "By session" table. Meanwhile the
// deck already answers "what has today cost me" from the logs on disk, one
// keystroke away, in the usage-history modal. So the number keeps its scope and
// the label gained it.
//
// WHAT THIS FILE PINS, IN TWO HALVES, BECAUSE NEITHER ALONE IS ENOUGH.
//
//   * A fact about the arithmetic: `boardTotals` sums exactly the agents it is
//     handed, agrees with both accumulators it replaced, and — driven through
//     the real reducer and the real pruners — really does fall across a sweep.
//     That is the property the label has to be true of.
//   * A fact about the text: the labels are declared in the same module as the
//     summation, every surface prints the constant rather than a literal of its
//     own, and the retired phrase comes back nowhere. The suite has no DOM, so
//     markup is read as source the way dead-css.test.ts and
//     panel-memo-revision.test.ts already read theirs — and reading it is what
//     makes "the wording moved without the sum" and "the sum moved without the
//     wording" both failures rather than one.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  boardTotals,
  BOARD_SCOPE_LABEL,
  BOARD_SCOPE_TITLE,
  BOARD_SPEND_LABEL,
  SESSION_SPEND_LABEL,
  type Billable,
} from "../board-usage";
import { costForUsage, fmtCost } from "../pricing";
import { fmtTokens } from "../token-format";
import { applyEvent, initialState, pruneDoneSessions, pruneOldAgents, type GraphState } from "../reducer";
import type { HookEnvelope, HookPayload, TokenUsage } from "../types";

// Sandboxed before anything can read a real one, the way api-events-streaming
// and ccusage-bin-escape do it. Nothing under test here touches the filesystem
// — `boardTotals`, the reducer and the pricing table are pure — but a client
// suite that assumes so is one import away from being wrong.
const SANDBOX = join(
  process.env.TMPDIR ?? process.env.TEMP ?? "/tmp",
  "ccdeck-687-sandbox",
);
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.env.CLAUDE_CONFIG_DIR = join(SANDBOX, "claude");
process.env.CODEX_HOME = join(SANDBOX, "codex");

// ── the board, as the deck really builds and prunes one ─────────────────────

/** The shipped constants, from App.tsx. The point is the deck as it runs. */
const DONE_SESSION_CAP = 6;
const DONE_SESSION_GRACE_MS = 2 * 60_000;
const AGENT_CAP = 200;
const AGENT_GRACE_MS = 5 * 60_000;

const TEN_MIN = 10 * 60_000;

let seq = 0;
const send = (state: GraphState, sid: string, payload: Partial<HookPayload>, at: number) =>
  applyEvent(state, {
    seq: ++seq,
    receivedAt: at,
    payload: { session_id: sid, ...payload } as HookPayload,
  } as HookEnvelope);

/**
 * The reporter's board: ten sessions, one every ten minutes, each spending
 * 1,000,000 input and 100,000 output on `claude-opus-5`, all stopped.
 *
 * `ModelObserved` before `UsageObserved` because that is the order the reducer
 * needs — usage lands on the root and the model is what prices it, and a board
 * built without the first event prices out at nothing and would pass every
 * assertion below for the wrong reason.
 */
function aDayOfSessions(count: number): GraphState {
  seq = 0;
  let state = initialState();
  for (let i = 1; i <= count; i++) {
    const t = i * TEN_MIN;
    state = send(state, `s${i}`, { hook_event_name: "SessionStart", cwd: `/p${i}` }, t);
    state = send(state, `s${i}`, { hook_event_name: "ModelObserved", model: "claude-opus-5" } as Partial<HookPayload>, t + 500);
    state = send(state, `s${i}`, {
      hook_event_name: "UsageObserved",
      usage: { input_tokens: 1_000_000, output_tokens: 100_000 },
    } as Partial<HookPayload>, t + 1_000);
    state = send(state, `s${i}`, { hook_event_name: "Stop" }, t + 2_000);
  }
  return state;
}

/** The tick that evicts, two minutes and change after the last of them ended. */
const afterTheGrace = (count: number) =>
  count * TEN_MIN + 2_000 + DONE_SESSION_GRACE_MS + 1_000;

describe("the figure the deck prints is a figure about the canvas", () => {
  it("falls from $75.00 to $45.00 across one prune sweep, with nothing refunded", () => {
    const state = aDayOfSessions(10);

    const before = boardTotals(state.agents.values());
    expect(state.agents.size).toBe(10);
    expect(fmtCost(before.cost.total)).toBe("$75.00");
    expect(fmtTokens(before.sum)).toBe("11.00M");

    // What the ten sessions actually spent, banked before the sweep can reach
    // them. This is the number "total spend" was claiming to be.
    const trulySpent = before.cost.total;

    expect(pruneDoneSessions(state, afterTheGrace(10), DONE_SESSION_CAP, DONE_SESSION_GRACE_MS)).toBe(true);

    const after = boardTotals(state.agents.values());
    expect(state.agents.size).toBe(DONE_SESSION_CAP);
    expect(fmtCost(after.cost.total)).toBe("$45.00");
    expect(fmtTokens(after.sum)).toBe("6.60M");

    // The whole of the defect in one line: the figure moved and the spending
    // did not. A label saying "total" over the left-hand side is a claim about
    // a period; over the right-hand side it is false.
    expect(after.cost.total).toBeLessThan(trulySpent);
    expect(after.cost.total / trulySpent).toBeCloseTo(0.6, 10);
  });

  it("falls one level down too, on a session that is still running", () => {
    // `pruneOldAgents` evicts finished agents out of sessions nobody has
    // stopped, which is why the two per-session labels are in this issue as
    // well: a row on the sidebar can shed subagents while its session is live.
    seq = 0;
    let state = initialState();
    state = send(state, "live", { hook_event_name: "SessionStart", cwd: "/p" }, 0);
    for (let i = 0; i < 260; i++) {
      state = send(state, "live", { hook_event_name: "SubagentStart", parent_tool_use_id: `tu${i}`, subagent_type: "worker" }, 10 + i);
      state = send(state, "live", {
        hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: `call${i}`, parent_tool_use_id: `tu${i}`,
      } as Partial<HookPayload>, 11 + i);
      state = send(state, "live", {
        hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: `call${i}`, parent_tool_use_id: `tu${i}`,
        tool_response: { usage: { input_tokens: 1_000_000, output_tokens: 100_000 } },
      } as Partial<HookPayload>, 12 + i);
      state = send(state, "live", { hook_event_name: "SubagentStop", parent_tool_use_id: `tu${i}` }, 13 + i);
    }

    const before = boardTotals(state.agents.values());
    expect(state.agents.size).toBeGreaterThan(AGENT_CAP);
    expect(pruneOldAgents(state, AGENT_GRACE_MS + 60_000, AGENT_CAP, AGENT_GRACE_MS)).toBe(true);
    const after = boardTotals(state.agents.values());

    // #685 answered this half. When this case was written the subagents each
    // carried their own tokens, so evicting them took the session's figure down
    // with them — 67.10M tokens out of a session nobody had stopped. A session
    // is now billed as one bill: the server totals the main transcript together
    // with every `subagents/agent-*.jsonl` beside it and the reducer ASSIGNS
    // that to the root, so a subagent node carries nothing of its own and there
    // is nothing to lose when one is evicted.
    //
    // So the assertion is inverted rather than deleted, and it is worth more
    // this way than it was: it pins that the roll-up of a live session survives
    // its subagents being pruned. Restore the per-agent fold and it goes red.
    // The whole-session case above still shrinks, and still should — there the
    // root itself leaves the board, which is exactly what the label now says.
    const root = [...state.agents.values()].find(a => a.kind === "root");
    expect(root?.state).toBe("active");
    expect(after.sum).toBe(before.sum);
  });
});

describe("boardTotals sums exactly what it is handed", () => {
  const billable = (input: number, output: number, model?: string): Billable => ({
    model,
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    } as TokenUsage,
  });

  it("counts nothing over an empty board", () => {
    const t = boardTotals([]);
    expect(t.cost.total).toBe(0);
    expect(t.sum).toBe(0);
    expect(fmtCost(t.cost.total)).toBe("—");
  });

  it("moves by exactly one agent's worth when one agent joins or leaves", () => {
    const two = [billable(1_000_000, 100_000, "claude-opus-5"), billable(500_000, 50_000, "claude-opus-5")];
    const one = two.slice(0, 1);
    const gap = boardTotals(two).cost.total - boardTotals(one).cost.total;
    expect(gap).toBeCloseTo(costForUsage(two[1].usage, two[1].model).total, 10);
    expect(boardTotals(two).sum - boardTotals(one).sum).toBe(550_000);
  });

  it("keeps an unpriced agent's tokens and leaves its dollars at zero", () => {
    // The Codex-only deck #400 is about, reached from this side: the token
    // strip is the only aggregate such a deck renders, which is why it carries
    // the scope word in its own right rather than inheriting it from a headline
    // that is not there.
    const t = boardTotals([billable(4_000_000, 200_000, "some-model-nobody-prices")]);
    expect(t.sum).toBe(4_200_000);
    expect(t.cost.total).toBe(0);
  });

  it("agrees with both accumulators it replaced, over the same board", () => {
    // The pattern duplicated-helpers.test.ts sets: correcting a copy leaves it
    // able to drift, so the shared function is swept against a LOCAL
    // re-implementation of each copy it replaced. These two are App.tsx's
    // topbar memo and UsagePanel's headline memo, byte for byte as they read
    // before this change.
    const state = aDayOfSessions(4);
    const agents = [...state.agents.values()];

    // App.tsx's, verbatim.
    let inT = 0, outT = 0, cacheR = 0, cacheC = 0;
    let costSum = 0, costInput = 0, costOutput = 0, costCacheR = 0, costCacheW = 0;
    for (const a of agents) {
      inT += a.usage.inputTokens;
      outT += a.usage.outputTokens;
      cacheR += a.usage.cacheReadTokens;
      cacheC += a.usage.cacheCreateTokens;
      const c = costForUsage(a.usage, a.model);
      costSum += c.total;
      costInput += c.input;
      costOutput += c.output;
      costCacheR += c.cacheRead;
      costCacheW += c.cacheWrite;
    }

    // UsagePanel's, verbatim.
    const totalCostAcc = { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let totalIn = 0, totalOut = 0, totalCacheR = 0, totalCacheC = 0;
    for (const a of agents) {
      const c = costForUsage(a.usage, a.model);
      totalCostAcc.total += c.total;
      totalCostAcc.input += c.input;
      totalCostAcc.output += c.output;
      totalCostAcc.cacheRead += c.cacheRead;
      totalCostAcc.cacheWrite += c.cacheWrite;
      totalIn += a.usage.inputTokens;
      totalOut += a.usage.outputTokens;
      totalCacheR += a.usage.cacheReadTokens;
      totalCacheC += a.usage.cacheCreateTokens;
    }

    const shared = boardTotals(agents);
    expect(shared.cost).toEqual({
      total: costSum, input: costInput, output: costOutput, cacheRead: costCacheR, cacheWrite: costCacheW,
    });
    expect(shared.cost).toEqual(totalCostAcc);
    expect([shared.inputTokens, shared.outputTokens, shared.cacheReadTokens, shared.cacheCreateTokens])
      .toEqual([inT, outT, cacheR, cacheC]);
    expect([shared.inputTokens, shared.outputTokens, shared.cacheReadTokens, shared.cacheCreateTokens])
      .toEqual([totalIn, totalOut, totalCacheR, totalCacheC]);
    expect(shared.sum).toBe(inT + outT);
  });
});

// ── the wording, read as source ─────────────────────────────────────────────

const web = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(web, rel), "utf8");

/** Every client source that ends up in the bundle. The suite's own files are
 *  excluded: this one quotes the retired label on purpose. */
function clientSources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : clientSources(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

/** The same text with its comments gone — the only form an "appears nowhere"
 *  assertion may read. This repo's prose quotes the code it retires, and
 *  board-usage.ts's own header spells out the phrase this issue removed, so a
 *  search over raw source would find the sentence saying a thing is gone and
 *  conclude that it is not. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const sources: Array<[string, string]> = clientSources(web)
  // Forward slashes on every platform, so a failure reads the same on Windows.
  .map(p => [p.slice(web.length).replaceAll("\\", "/"), readFileSync(p, "utf8")]);

const boardUsage = read("board-usage.ts");
const app = code(read("App.tsx"));
const panel = code(read("components/UsagePanel.tsx"));
const sessionList = code(read("components/SessionList.tsx"));
const sessionSummary = code(read("components/SessionSummary.tsx"));

describe("the label lives in the same module as the sum", () => {
  it("declares the summation and every label it may be printed under in one file", () => {
    // The structural half of the fix, and the reason the rest of this block can
    // be trusted. A label declared next to the loop it describes is a label the
    // next person cannot change without reading what is summed — and a scope
    // that is changed without its label fails the string cases below.
    const declared = code(boardUsage);
    expect(declared).toContain("export function boardTotals(");
    for (const name of [
      "BOARD_SPEND_LABEL", "BOARD_SCOPE_LABEL",
      "BOARD_SCOPE_TITLE", "SESSION_SPEND_LABEL",
    ]) {
      expect(declared, `${name} is not declared beside the sum`).toContain(`export const ${name}`);
    }
  });

  it("says board of the board figures and session of the session ones", () => {
    expect(BOARD_SPEND_LABEL).toBe("spend on this board");
    expect(BOARD_SCOPE_LABEL).toBe("on this board");
    expect(SESSION_SPEND_LABEL).toBe("session spend");
    // Two more used to be here — the topbar chips' "board tokens" and "board
    // cost". Both readouts were dropped rather than reworded: a figure needing
    // a qualifier and a three-line tooltip to be honest is not worth 12px of a
    // fixed row when ccusage answers the same question properly one panel over.
    // topbar-strip-shape.test.ts is what keeps them from coming back.

    // The rule the strings above are one spelling of: every label naming an
    // aggregate names the scope that aggregate is over, and none of them claims
    // a whole. "total" is the word this issue is about — it is a claim about a
    // period, and no figure on these surfaces covers one.
    for (const label of [BOARD_SPEND_LABEL, BOARD_SCOPE_LABEL]) {
      expect(label, `${label} does not name the board`).toMatch(/\bboard\b/);
      expect(label, `${label} still claims a total`).not.toMatch(/\btotal\b/i);
    }
    expect(SESSION_SPEND_LABEL).toMatch(/\bsession\b/);
    expect(SESSION_SPEND_LABEL).not.toMatch(/\btotal\b/i);
  });

  it("points the reader at the surface that does not forget, and that surface is really there", () => {
    // The tooltip's three jobs: what is counted, why it falls, where the
    // durable answer is. The third is a promise about a keystroke, so it is
    // checked against the keymap rather than merely asserted — a rebound H
    // would leave this sentence sending people nowhere.
    expect(BOARD_SCOPE_TITLE).toMatch(/on the board right now/);
    expect(BOARD_SCOPE_TITLE).toMatch(/evicted/);
    expect(BOARD_SCOPE_TITLE).toMatch(/ccusage/);
    expect(BOARD_SCOPE_TITLE).toMatch(/\bH\b/);
    expect(app).toContain(`if (e.key === "h" || e.key === "H") setUsageHistoryOpen(o => !o);`);
    expect(app).toContain("<UsageHistoryModal");

    // The strip's numbers add up both CLIs, so the sentence attached to them
    // may name neither — the same rule codex-copy.test.ts holds the tooltips to.
    for (const product of ["Claude Code", "Codex", "Claude ", "OpenAI"]) {
      expect(BOARD_SCOPE_TITLE, `the scope sentence names ${product}`).not.toContain(product);
    }
  });
});

describe("every surface that prints one of these figures prints the shared label", () => {
  it("has retired the phrase from the client entirely", () => {
    // The one assertion that fails if any single surface is reverted, and the
    // reason it is a sweep rather than four file checks: the phrase went onto
    // three surfaces over three separate changes, so the next copy will not be
    // in a file this file knows to look at.
    const offenders = sources
      .filter(([, src]) => /total spend/i.test(code(src)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("labels the usage panel's headline and its token strip", () => {
    // The panel has two sources now — ccusage for a period, the canvas when
    // ccusage did not answer — and only the second one is a board figure. So
    // the label and the sentence are on the board BRANCH of each conditional
    // rather than unconditional: `fromRange ? <period word> : <board word>`.
    // Asserted as the whole expression, because the half that matters is the
    // one after the colon and a bare `toContain(BOARD_SPEND_LABEL)` would pass
    // on a panel that had stopped rendering it at all.
    expect(panel).toContain(`<span className="up-total-label">{fromRange ? periodNoun : BOARD_SPEND_LABEL}</span>`);
    // The class carries the stale dim now (a template literal), and the title
    // is what this issue is about — asserted as the whole attribute so the
    // board branch cannot quietly lose its sentence.
    expect(panel).toContain('<div className={`up-total${staleCls}`} title={fromRange ? undefined : BOARD_SCOPE_TITLE}>');
    expect(panel).toContain('<div className={`up-tokens-row${staleCls}`} title={fromRange ? undefined : BOARD_SCOPE_TITLE}>');
    // The unpriced deck: no headline renders there, so the strip says it itself.
    expect(panel).toContain(`{!hasCost && <span className="up-tok up-scope">{BOARD_SCOPE_LABEL}</span>}`);
  });

  it("prints no board figure at all under a ccusage headline", () => {
    // #687 was "do not print the board's number under a word that claims a
    // period". The first answer kept the number and gave it its own labelled
    // line; the second is that under a panel which now answers today, this
    // month and all time from the logs, a second money figure answers a
    // question nobody asked at that moment — and it invited the comparison it
    // could never win, $7,385 on the board beneath $170 for today, which reads
    // as a contradiction until you have opened a tooltip.
    //
    // So the line is gone, and this is what keeps it gone. The board figures
    // are still on the topbar, with the sentence, and the board BRANCH below
    // still prints them when ccusage has not answered at all.
    expect(panel).not.toContain('className="up-live"');
    expect(panel).not.toMatch(/\{BOARD_SCOPE_LABEL\} now/);
    // And the sheet lost its rules with it — a selector nothing emits is the
    // shape unstyled-class.test.ts and dead-css.test.ts both exist to prevent.
    expect(read("styles.css"), "the rule outlived its markup").not.toContain(".up-live");
  });

  it("has no unlabelled board figure left in the topbar", () => {
    // This case used to check the opposite: that BOTH topbar chips printed the
    // constants and BOTH carried the sentence — the tokens figure falls by the
    // same 40% the dollars do, and the report named only the dollars.
    //
    // The chips are gone, so the claim inverts. The strip carries no aggregate
    // at all now, which satisfies #687 the other way round: there is no figure
    // there to mislabel. What the case still has to catch is a board number
    // reappearing in the bar WITHOUT the scope the panel gives its own.
    const strip = app.slice(
      app.indexOf(`<span className="status">`),
      app.indexOf(`<div className="vis-hidden"`),
    );
    expect(strip, "the .status strip is gone from App.tsx").toBeTruthy();
    expect(strip).not.toContain("boardTotals");
    expect(strip).not.toMatch(/fmtCost\(|fmtTokens\(/);
  });

  it("labels the sidebar row and the end-of-session recap", () => {
    expect(sessionList).toContain(`title={SESSION_SPEND_LABEL}`);
    expect(sessionSummary).toContain(`<div className="ss-cost-label">{SESSION_SPEND_LABEL}</div>`);
  });
});

describe("no surface computes a board figure of its own", () => {
  it("keeps neither accumulator the shared function replaced", () => {
    // The other direction of "one without the other". If a future edit re-inlines
    // a sum here, the label above it stops being the one board-usage.ts declares
    // and the scope can drift without the words moving — which is exactly how
    // this defect was built in the first place.
    for (const [path, src] of sources) {
      if (path === "board-usage.ts") continue;
      const body = code(src);
      expect(body, `${path} accumulates a board cost of its own`).not.toMatch(/totalCostAcc/);
      expect(body, `${path} accumulates board tokens of its own`).not.toMatch(/let\s+inT\s*=\s*0/);
      expect(body, `${path} accumulates a board cost of its own`).not.toMatch(/costSum\s*\+=/);
    }
  });

  it("has the one aggregate surface left reading the shared module", () => {
    // Two, until the topbar chips went. The module stays where it is with one
    // caller: what it exists to guarantee is that the words over a board figure
    // are declared beside the loop that produces it, and that is worth as much
    // to one surface as to two — the panel is where the next such label will be
    // written, and re-inlining the sum there is how #687 was built.
    expect(panel).toMatch(/import \{[^}]*boardTotals[^}]*\} from "\.\.\/board-usage";/);
    expect(panel).toContain("boardTotals(state.agents.values())");
    expect(app, "the topbar computes a board figure again").not.toContain("boardTotals");
  });
});
