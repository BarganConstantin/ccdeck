// The Codex rollout record shapes more than one reader takes a fact off, read in
// one place (codex-translate.mjs): the translation, the enrichment's head-and-
// tail read (codex-enrichment.mjs), the usage windows (codex-usage.mjs) and the
// watcher's header read (codex-watch.mjs) each tested `obj.type` and
// `payload.type` for themselves. These run the accessors they all ask now, and
// then the three readers that can be driven without a watcher over one rollout,
// which must agree on what it says.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — .mjs server module, no types
const translate = await import("../../server/codex-translate.mjs");
// @ts-expect-error — .mjs server module, no types
const { readCodexRollout } = await import("../../server/codex-enrichment.mjs");
// @ts-expect-error — .mjs server module, no types
const { readTokenSeriesForTest } = await import("../../server/codex-usage.mjs");
const { sessionMeta, tokenCountInfo, taskStartedWindow, responseItemModel, codexObjToPayload } = translate;

const TOTAL = { input_tokens: 120, cached_input_tokens: 100, output_tokens: 7, reasoning_output_tokens: 0, total_tokens: 127 };
const META = { type: "session_meta", payload: { id: "s", cwd: "/srv/proj", model: "gpt-5.1-codex" } };
const TOKENS = { type: "event_msg", timestamp: "2026-09-28T10:00:00Z", payload: { type: "token_count", info: { total_token_usage: TOTAL, last_token_usage: { total_tokens: 60 }, model_context_window: 258400 } } };
const STARTED = { type: "event_msg", payload: { type: "task_started", model_context_window: 258400 } };
const ITEM = { type: "response_item", payload: { type: "message", model: "gpt-5.6" } };
/** Records that are none of the four, or a near miss of one. */
const OTHERS: unknown[] = [
  null, 0, "session_meta", [], {},
  { type: "session_meta" }, { type: "session_meta", payload: null },
  { type: "event_msg", payload: { type: "token_count" } },
  { type: "event_msg", payload: { type: "task_started", model_context_window: "258400" } },
  { type: "token_count", payload: { info: { total_token_usage: TOTAL } } },
  { type: "turn_context", payload: { model: "gpt-5.6" } },
  { type: "response_item", payload: { model: 5 } },
];

describe("the record shapes", () => {
  it("each read their own record", () => {
    expect(sessionMeta(META)).toBe(META.payload);
    expect(tokenCountInfo(TOKENS)).toBe(TOKENS.payload.info);
    expect(taskStartedWindow(STARTED)).toBe(258400);
    expect(responseItemModel(ITEM)).toBe("gpt-5.6");
  });

  it("and nothing else, each other's records included", () => {
    for (const obj of [...OTHERS, META, TOKENS, STARTED, ITEM]) {
      if (obj !== META) expect(sessionMeta(obj), JSON.stringify(obj)).toBeNull();
      if (obj !== TOKENS) expect(tokenCountInfo(obj), JSON.stringify(obj)).toBeNull();
      if (obj !== STARTED) expect(taskStartedWindow(obj), JSON.stringify(obj)).toBeNull();
      if (obj !== ITEM) expect(responseItemModel(obj), JSON.stringify(obj)).toBeNull();
    }
  });
});

describe("the readers that ask them", () => {
  const dir = mkdtempSync(join(tmpdir(), "ccdeck-codex-shapes-"));
  afterAll(() => rmTempDir(dir));
  const path = join(dir, "rollout-2026-09-28T10-00-00-0a1b2c3d-0000-4000-8000-000000000000.jsonl");
  writeFileSync(path, [META, STARTED, ITEM, TOKENS, ...OTHERS].map(o => JSON.stringify(o)).join("\n") + "\n");

  it("agree on one rollout's usage, window and model", async () => {
    expect(await readCodexRollout(path)).toEqual({ usage: TOTAL, model: "gpt-5.6", contextWindow: 258400, cwd: "/srv/proj" });
    expect(await readTokenSeriesForTest(path)).toEqual([
      { ts: Date.parse(TOKENS.timestamp), inp: 120, out: 7, cacheR: 100, cacheW: 0, total: 127 },
    ]);
    const sid = "shapes-sid";
    const events = [META, STARTED, ITEM, TOKENS].map(o => codexObjToPayload(o, sid, "/srv/proj"));
    expect(events[1]).toMatchObject({ hook_event_name: "ModelObserved", model_context_window: 258400 });
    expect(events[3]).toMatchObject({ hook_event_name: "UsageObserved", usage: TOTAL, model: "gpt-5.6", model_context_window: 258400, context_tokens: 60 });
  });
});
