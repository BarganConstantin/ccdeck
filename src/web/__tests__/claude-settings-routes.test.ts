// GET and POST /api/claude-settings (claude-settings-routes.mjs): this machine
// only, past the deck's read and write gates, and a body that is one row's id
// and value or nothing.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { CLAUDE_SETTINGS_ROUTE, handleClaudeSettings } from "../../server/claude-settings-routes.mjs";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { SettingsRefusal } from "../../server/claude-settings.mjs";
// @ts-expect-error — server module, untyped by design (tsconfig.build.json)
import { GUARDED_READS, OPEN_MUTATIONS } from "../../server/request-gates.mjs";

function call(method: string, body?: unknown, remoteAddress = "127.0.0.1", settings?: object) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]), {
    method, headers: {}, socket: { remoteAddress },
  });
  let status = 0, text = "";
  const res = { writeHead: (s: number) => { status = s; }, end: (s: string) => { text = s; } };
  const fake = settings ?? { read: async () => ({ ok: true, settings: [] }), update: async (id: string, value: unknown) => ({ ok: true, id, value }) };
  return handleClaudeSettings(req, res, fake).then(() => ({ status, body: JSON.parse(text) }));
}

describe("the route", () => {
  it("is a guarded read and a gated write, wired into the server", () => {
    expect(GUARDED_READS.has(CLAUDE_SETTINGS_ROUTE)).toBe(true);
    expect(OPEN_MUTATIONS.has(CLAUDE_SETTINGS_ROUTE)).toBe(false);
    const index = readFileSync(new URL("../../server/index.mjs", import.meta.url), "utf8");
    expect(index).toContain("if (url.pathname === CLAUDE_SETTINGS_ROUTE) return guard(handleClaudeSettings(req, res), res);");
  });

  it("answers this computer only, a read as well as a write", async () => {
    for (const method of ["GET", "POST"]) {
      const { status, body } = await call(method, { id: "spinnerTipsEnabled", value: false }, "192.0.2.10");
      expect(status).toBe(403);
      expect(body.error).toContain("this computer only");
    }
  });

  it("passes one row's id and value through, and refuses a body that names anything else", async () => {
    expect(await call("POST", { id: "spinnerTipsEnabled", value: false })).toEqual({ status: 200, body: { ok: true, id: "spinnerTipsEnabled", value: false } });
    for (const body of [{ id: "x" }, { id: "x", value: 1, extra: 2 }, [1], "not json", null]) {
      expect((await call("POST", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call("PUT", {})).status).toBe(405);
  });

  it("says a refusal in its own words, and an unexpected failure without detail", async () => {
    const refusing = { read: async () => ({}), update: async () => { throw new SettingsRefusal("Set by your organization."); } };
    expect(await call("POST", { id: "a", value: true }, "::1", refusing)).toEqual({ status: 400, body: { ok: false, error: "Set by your organization." } });
    const failing = { read: async () => { throw new Error("EACCES /home/x"); }, update: async () => { throw new Error("EACCES /home/x"); } };
    const read = await call("GET", undefined, "127.0.0.1", failing);
    expect(read.status).toBe(500);
    expect(JSON.stringify(read.body)).not.toContain("EACCES");
    const write = await call("POST", { id: "a", value: true }, "127.0.0.1", failing);
    expect(write.status).toBe(500);
    expect(write.body.error).toContain("not modified");
  });
});
