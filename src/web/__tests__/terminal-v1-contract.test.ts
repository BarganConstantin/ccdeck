import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { rmTempDir } from "./rm-temp-dir";
import { TERMINAL_ROUTES } from "../terminal-api";
import { MAX_MESSAGE_BYTES, TERMINAL_ATTACH_PATH } from "../terminal-protocol";
const root = mkdtempSync(join(tmpdir(), "ccpro-contract-"));
for (const key of ["HOME", "USERPROFILE", "CCDECK_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) process.env[key] = join(root, key);
process.env.AGENTS_DECK_NO_INSTALL = "1";
const cwd = join(root, "project"); mkdirSync(cwd);
const spec = JSON.parse(readFileSync(new URL("../../../docs/contracts/terminal-v1.schema.json", import.meta.url), "utf8"));
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/terminal-http-v1.json", import.meta.url), "utf8"));
let server: Server; let base = "";
beforeAll(async () => {
  // @ts-expect-error plain server module
  const { startServer } = await import("../../server/index.mjs");
  server = await startServer({ port: 0, portRange: [], claude: false, codex: false, terminal: {
    enabled: () => true, findTmux: async () => ({ ok: false, reason: "missing", install: "Install tmux 3.2 or newer." }), downloadBlocked: () => true,
  } });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(done => server?.close(() => done())); rmTempDir(root); });
describe("version 1 browser contract", () => {
  it("freezes paths and bounded ticket/stream constants", async () => {
    // @ts-expect-error plain server module
    const wire = await import("../../server/terminal-socket.mjs");
    expect(Object.fromEntries(Object.entries(spec.routes).map(([k, v]: any) => [k, v.path]))).toEqual(TERMINAL_ROUTES);
    expect(spec.websocket.path).toBe(TERMINAL_ATTACH_PATH);
    expect(spec.websocket.maxMessageBytes).toBe(MAX_MESSAGE_BYTES);
    expect(spec.websocket.ticketTtlMs).toBe(wire.TICKET_TTL_MS);
    expect(spec.websocket.maxTickets).toBe(wire.MAX_TICKETS);
    expect(spec.websocket.maxConnections).toBe(wire.MAX_TERMINALS);
    expect(spec.websocket.ackWindowBytes).toBe(wire.ACK_WINDOW_BYTES);
  });
  for (const sample of fixtures.filter((s: any) => !s.baseline)) it(`${sample.method} ${sample.path}`, async () => {
    const request = sample.request ? JSON.parse(JSON.stringify(sample.request).replaceAll("$PROJECT", cwd)) : null;
    const path = sample.path.replaceAll("$PROJECT", encodeURIComponent(cwd));
    const response = await fetch(base + path, { method: sample.method, headers: { Origin: base, "Sec-Fetch-Site": "same-origin", ...(request ? { "Content-Type": "application/json" } : {}) }, ...(request ? { body: JSON.stringify(request) } : {}) });
    expect(response.status).toBe(sample.status);
    const body = await response.json();
    // Recorded on macOS; `platform` is the deck's own OS wherever it runs.
    expect(body).toEqual(JSON.parse(JSON.stringify(sample.response).replaceAll("$PLATFORM", process.platform)));
    if (body.target) for (const key of Object.keys(body.target)) expect(Object.keys(spec.$defs.target.properties)).toContain(key);
    expect(JSON.stringify(body)).not.toMatch(/socketPath|panePid|"pid"|"pane"|"socket"/);
  });
});
