import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, appendFile, realpath, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error server module
import { createProjectRollup } from "../../server/account-projects.mjs";
// @ts-expect-error server module
import { accountKey } from "../../server/lan-sync.mjs";
// @ts-expect-error server module
import { codexCostState, foldCodexCost, codexCostBuckets } from "../../server/codex-cost-usage.mjs";
import { usageByModelFromWire } from "../usage-wire";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UsageSessionBreakdown from "../components/UsageSessionBreakdown";
import { boardModelTable, boardSessionTable } from "../board-usage";
import { agentCost, agentUnpricedTokens } from "../usage-models";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const line = (input_tokens: number) => JSON.stringify({ type: "assistant", timestamp: "2026-10-18T10:00:00Z", cwd: "/demo/project", message: { model: "claude-sonnet-5", usage: { input_tokens, output_tokens: 0 } } }) + "\n";

describe("account cost audit", () => {
  it("does not charge a second independent Claude directory to the active account", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccdeck-cost-scope-")); dirs.push(dir);
    const roots = [join(dir, "managed", "projects"), join(dir, "independent", "projects")];
    for (let i = 0; i < roots.length; i++) {
      await mkdir(join(roots[i], "demo"), { recursive: true });
      await writeFile(join(roots[i], "demo", `${i}.jsonl`), line((i + 1) * 1000));
    }
    const swapLog = join(dir, "swap.jsonl");
    await writeFile(swapLog, JSON.stringify({ at: Date.parse("2026-10-18T09:00:00Z"), slot: 1, email: "owner@example.test", orgUuid: "org", source: "start", projectsRoot: await realpath(roots[0]) }) + "\n");
    const rollup = createProjectRollup({ roots, state: join(dir, "state.json"), swapLog, storeRoot: join(dir, "empty-store"), now: () => Date.parse("2026-10-18T11:00:00Z") });
    await rollup.tick();
    const report = await rollup.report(accountKey("owner@example.test", "org"), 0);
    expect(report.projects[0].models["claude-sonnet-5"].i).toBe(1000);
    expect(report.unattributed["claude-sonnet-5"].i).toBe(2000);
    // Root order changes must not reassign history or reuse old cursors.
    const restarted = createProjectRollup({ roots: [...roots].reverse(), state: join(dir, "state.json"), swapLog, storeRoot: join(dir, "empty-store"), now: () => Date.parse("2026-10-18T11:00:00Z") });
    await restarted.tick();
    const again = await restarted.report(accountKey("owner@example.test", "org"), 0);
    expect(again.projects[0].models["claude-sonnet-5"].i).toBe(1000);
    expect(again.unattributed["claude-sonnet-5"].i).toBe(2000);
    // Downtime fences apply to both the previous and new primary root.
    await appendFile(join(roots[0], "demo", "0.jsonl"), line(5000).replace("10:00:00", "11:30:00"));
    const afterGap = createProjectRollup({ roots: [...roots].reverse(), state: join(dir, "state.json"), swapLog, storeRoot: join(dir, "empty-store"), now: () => Date.parse("2026-10-18T12:00:00Z") });
    await afterGap.tick();
    const fenced = await afterGap.report(accountKey("owner@example.test", "org"), 0);
    expect(fenced.projects[0].models["claude-sonnet-5"].i).toBe(1000);
    expect(fenced.unattributed["claude-sonnet-5"].i).toBe(7000);
    // A later scoped switch can attribute the independent root, without
    // stealing usage already attributed to the original directory.
    await appendFile(swapLog, JSON.stringify({ at: Date.parse("2026-10-18T12:01:00Z"), slot: 2, email: "second@example.test", orgUuid: "org", source: "manual", projectsRoot: await realpath(roots[1]) }) + "\n");
    await appendFile(join(roots[1], "demo", "1.jsonl"), line(4000).replace("10:00:00", "12:02:00"));
    await afterGap.tick();
    expect((await afterGap.report(accountKey("second@example.test", "org"), 0)).projects[0].models["claude-sonnet-5"].i).toBe(4000);
  });
  it("rebuilds wrongly attributed v7 caches and retains legacy usage as unattributed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ccdeck-legacy-scope-")); dirs.push(dir);
    const root = join(dir, "projects");
    await mkdir(join(root, "demo"), { recursive: true });
    const file = join(root, "demo", "s.jsonl");
    await writeFile(file, line(3000));
    const alias = join(dir, "alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const swapLog = join(dir, "swap.jsonl");
    await writeFile(swapLog, JSON.stringify({ at: Date.parse("2026-10-18T09:00:00Z"), slot: 1, email: "owner@example.test", orgUuid: "org", source: "start" }) + "\n");
    const stateFile = join(dir, "state.json");
    await writeFile(stateFile, JSON.stringify({ version: 7, cursors: { [file]: (await readFile(file)).length }, tally: { wrong: {} } }));
    const rollup = createProjectRollup({ roots: [root, alias], state: stateFile, swapLog, storeRoot: join(dir, "empty-store"), now: () => Date.parse("2026-10-18T11:00:00Z") });
    await rollup.tick();
    const report = await rollup.report(accountKey("owner@example.test", "org"), 0);
    expect(report.projects).toEqual([]);
    expect(report.unattributed["claude-sonnet-5"].i).toBe(3000);
    expect(rollup._state().tally.wrong).toBeUndefined();
    await rollup.tick();
    expect((await rollup.report(accountKey("owner@example.test", "org"), 0)).unattributed["claude-sonnet-5"].i).toBe(3000);
  });
  it("recognizes proven ChatGPT auto-review as no-charge without dropping its tokens", () => {
    const state = codexCostState();
    for (const obj of [
      { timestamp: "2026-10-18T09:00:00Z", type: "session_meta", payload: { creator_account_id: "chatgpt-account", model: "codex-auto-review" } },
      { timestamp: "2026-10-18T10:00:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, output_tokens: 100 } } } },
    ]) foldCodexCost(state, obj);
    const usageByModel = usageByModelFromWire(codexCostBuckets(state));
    const agent = { model: "codex-auto-review", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 }, usageByModel };
    expect(agentCost(agent).total).toBe(0);
    expect(agentUnpricedTokens(agent)).toBe(0);
    expect(usageByModel!["codex-auto-review"].inputTokens).toBe(1000);
    expect(boardModelTable([agent])[0].priced).toBe(true);
    const sessions = boardSessionTable([{ ...agent, kind: "root", sessionId: "free", state: "active" }]);
    expect(sessions[0]).toMatchObject({ cost: 0, priced: true, unpricedTokens: 0 });
    const html = renderToStaticMarkup(createElement(UsageSessionBreakdown, { fromRange: false, rangeSessionRows: [], boardSessionRows: sessions, boardStates: new Map(), sessionsOpen: true, setSessionsOpen: () => {}, periodNoun: "today", sessionScale: { kind: "exact", sum: 0, total: 0 } }));
    expect(html).not.toContain("not priced");
    const unknown = { ...agent, usageByModel: undefined };
    expect(boardModelTable([agent, unknown])[0].priced).toBe(false);
    expect(boardModelTable([unknown, agent])[0].priced).toBe(false);
  });
});

describe("conservative auto-review pricing", () => {
  it("does not label unknown cache-only usage as fully priced", () => {
    const agent = { model: "unknown-claude", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1000, cacheCreateTokens: 0 } };
    expect(boardModelTable([agent])[0].priced).toBe(false);
  });
  it.each([
    [undefined, "2026-10-18T09:00:00Z"],
    ["  ", "2026-10-18T09:00:00Z"],
    ["chatgpt-account", "2026-10-05T09:00:00Z"],
    ["chatgpt-account", "2026-10-06T09:00:00Z"],
    ["chatgpt-account", undefined],
  ])("leaves uncertain authentication or historical pricing unknown (%s, %s)", (creator_account_id, timestamp) => {
    const state = codexCostState();
    foldCodexCost(state, { timestamp, type: "session_meta", payload: { creator_account_id, model: "codex-auto-review" } });
    foldCodexCost(state, { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, output_tokens: 100 } } } });
    const agent = { model: "codex-auto-review", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheCreateTokens: 0 }, usageByModel: usageByModelFromWire(codexCostBuckets(state)) };
    expect(agentUnpricedTokens(agent)).toBe(1100);
  });
  it("does not erase cumulative usage preceding the no-charge policy", () => {
    const state = codexCostState();
    foldCodexCost(state, { timestamp: "2026-10-06T23:00:00Z", type: "session_meta", payload: { creator_account_id: "account", model: "codex-auto-review" } });
    for (const [timestamp, input_tokens] of [["2026-10-07T01:00:00Z", 1000], ["2026-10-07T02:00:00Z", 2000]] as const) {
      foldCodexCost(state, { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens, output_tokens: 0 } } } });
    }
    const agent = { model: "codex-auto-review", usage: { inputTokens: 2000, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }, usageByModel: usageByModelFromWire(codexCostBuckets(state)) };
    expect(agentUnpricedTokens(agent)).toBe(1000);
  });
});
