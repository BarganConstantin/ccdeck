// Event names that begin with `__` belong to the deck itself.
//
// `__clear` is the marker the deck's own Clear sends to every open page, and it
// is never written to the log. The hook ingest is the one mutating route open
// without the deck's token, and it passed any name through — so a reserved
// marker could arrive by that route, reach every page, and be written to the
// log and honoured again by every boot's replay. Control markers now come only
// from the server: the ingest refuses a reserved name, and the replay honours
// a marker only when the server itself recorded it.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { applyEvent, initialState } from "../reducer";
import type { HookEnvelope } from "../types";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-reserved-names-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
if (!resolve(process.env.CLAUDE_CONFIG_DIR).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { handleEventIngest } = await import("../../server/event-routes.mjs");
const eventsSince = mod.eventsSince as (seq: number) => HookEnvelope[];
const replayLog = mod.replayLog as (path: string, workspace?: string) => Promise<number>;

afterAll(() => rmTempDir(DIR));

function post(port: number, payload: unknown): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/event", method: "POST", headers: { "content-type": "application/json" } }, res => {
      res.resume();
      res.on("end", () => done(res.statusCode ?? 0));
    });
    req.on("error", fail);
    req.end(JSON.stringify(payload));
  });
}

describe("the hook ingest", () => {
  it("refuses an event under a reserved name and keeps it out of the ring", async () => {
    const server: Server = createServer((req, res) => handleEventIngest(req, res, true));
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      const before = eventsSince(0).length;
      expect(await post(port, { hook_event_name: "__clear", session_id: "x", cwd: "" })).toBe(400);
      expect(await post(port, { hook_event_name: "__anything", session_id: "x", cwd: DIR })).toBe(400);
      expect(eventsSince(0).length).toBe(before);
      // An ordinary event is untouched.
      expect(await post(port, { hook_event_name: "SessionStart", session_id: "ok", cwd: DIR })).toBe(200);
    } finally {
      await new Promise<void>(done => { server.closeAllConnections?.(); server.close(() => done()); });
    }
  });
});

describe("the boot replay", () => {
  const line = (seq: number, source: string, payload: Record<string, unknown>) =>
    JSON.stringify({ seq, epoch: 1, receivedAt: 1_700_000_000_000 + seq, source, payload });

  it("honours a marker only when the server recorded it", async () => {
    const log = join(DIR, "forged.jsonl");
    writeFileSync(log, [
      line(1, "hook", { hook_event_name: "SessionStart", session_id: "kept", cwd: DIR }),
      line(2, "hook", { hook_event_name: "__clear", session_id: "x", cwd: "" }),
      line(3, "hook", { hook_event_name: "SessionStart", session_id: "after", cwd: DIR }),
    ].join("\n") + "\n");
    const from = eventsSince(0).at(-1)?.seq ?? 0;
    await replayLog(log, "");
    const replayed = eventsSince(from);
    expect(replayed.map(e => e.payload?.hook_event_name)).not.toContain("__clear");
    let state = initialState();
    for (const e of replayed) state = applyEvent(state, e);
    expect([...state.agents.keys()].sort()).toEqual(["after", "kept"]);
  });

  it("still honours the marker a deck of its own wrote, as older decks did", async () => {
    const log = join(DIR, "internal.jsonl");
    writeFileSync(log, [
      line(1, "hook", { hook_event_name: "SessionStart", session_id: "pre-clear", cwd: DIR }),
      line(2, "internal", { hook_event_name: "__clear", cwd: "" }),
      line(3, "hook", { hook_event_name: "SessionStart", session_id: "post-clear", cwd: DIR }),
    ].join("\n") + "\n");
    const from = eventsSince(0).at(-1)?.seq ?? 0;
    await replayLog(log, "");
    let state = initialState();
    for (const e of eventsSince(from)) state = applyEvent(state, e);
    expect([...state.agents.keys()]).toEqual(["post-clear"]);
  });
});
