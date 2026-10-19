import { afterAll, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
const io = vi.hoisted(() => ({ block: null as null | { entered: () => void; wait: Promise<void> } }));
vi.mock("../../server/jsonl-chunks.mjs", async importOriginal => {
  const original = await importOriginal<Record<string, any>>();
  return { ...original, readByteRange: async (...args: unknown[]) => {
    const text = await original.readByteRange(...args);
    const block = io.block;
    if (block) { io.block = null; block.entered(); await block.wait; }
    return text;
  } };
});
const DIR = mkdtempSync(join(tmpdir(), "ccdeck-tier-pipeline-"));
const keys = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"] as const;
const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
// @ts-expect-error server module
const { pushEvent } = await import("../../server/event-pipeline.mjs");
// @ts-expect-error server module
const { connectEventSink } = await import("../../server/event-sink.mjs");
// @ts-expect-error server module
const { stopCodexEnrichment } = await import("../../server/codex-enrichment.mjs");
const captured: { raw: Record<string, any>; source: string; opts: Record<string, unknown> }[] = [];
connectEventSink((raw: Record<string, any>, source: string, opts: Record<string, unknown>) => {
  captured.push({ raw, source, opts });
  return pushEvent(raw, source, opts);
});
afterAll(() => {
  stopCodexEnrichment();
  for (const k of keys) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  rmTempDir(DIR);
});
const SID = "019a1234-1234-4000-8000-000000000001";
const line = (value: unknown) => JSON.stringify(value) + "\n";
const tick = (input_tokens: number) => ({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens, output_tokens: 0 } } } });
const waitFor = async (predicate: () => boolean) => {
  const end = Date.now() + 5000;
  while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  expect(predicate()).toBe(true);
};
it("enriches hookless watcher traffic, forwards log election, and catches the final throttled tick", async () => {
  const day = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "19");
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-10-19T10-00-00-${SID}.jsonl`);
  writeFileSync(path, line({ type: "session_meta", payload: { id: SID, cwd: DIR, model: "gpt-6.1-sol" } })
    + line({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } } }) + line(tick(1000)));
  pushEvent({ provider: "codex", session_id: SID, hook_event_name: "UsageObserved", usage: { input_tokens: 1000, output_tokens: 0 } }, "codex", { persist: false });
  await waitFor(() => captured.some(e => e.raw.usageByModel?.["gpt-6.1-sol"]?.speeds?.fast?.input_tokens === 1000));
  expect(captured.every(e => e.opts.persist === false)).toBe(true);
  appendFileSync(path, line(tick(2000)));
  pushEvent({ provider: "codex", session_id: SID, hook_event_name: "UsageObserved", usage: { input_tokens: 2000, output_tokens: 0 } }, "codex", { persist: false });
  await waitFor(() => captured.some(e => e.raw.usageByModel?.["gpt-6.1-sol"]?.speeds?.fast?.input_tokens === 2000));
  expect(captured.every(e => e.opts.persist === false)).toBe(true);
}, 10000);

it("keeps final demand during an overlapping slow read and rejects stale results", async () => {
  stopCodexEnrichment();
  captured.length = 0;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  io.block = { entered, wait: new Promise<void>(r => { release = r; }) };
  const path = join(process.env.CODEX_HOME!, "sessions", "2026", "10", "19", `rollout-2026-10-19T10-00-00-${SID}.jsonl`);
  pushEvent({ provider: "codex", session_id: SID, hook_event_name: "UsageObserved", usage: { input_tokens: 2000, output_tokens: 0 } }, "codex", { persist: false });
  await ready;
  appendFileSync(path, line(tick(3000)));
  pushEvent({ provider: "codex", session_id: SID, hook_event_name: "UsageObserved", usage: { input_tokens: 3000, output_tokens: 0 } }, "codex", { persist: false });
  // Let the trailing timer encounter an in-flight read, then release it.
  await new Promise(r => setTimeout(r, 2700));
  release();
  await waitFor(() => captured.some(e => e.raw.usage?.input_tokens === 3000));
  expect(captured.some(e => e.raw.usage?.input_tokens === 2000)).toBe(false);
}, 12000);

it("invalidates a pending read when the server closes", async () => {
  stopCodexEnrichment();
  captured.length = 0;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  io.block = { entered, wait: new Promise<void>(r => { release = r; }) };
  pushEvent({ provider: "codex", session_id: SID, hook_event_name: "UsageObserved", usage: { input_tokens: 3000, output_tokens: 0 } }, "codex", { persist: false });
  await ready;
  stopCodexEnrichment();
  release();
  await new Promise(r => setTimeout(r, 50));
  expect(captured).toEqual([]);
});
