// A connection's own secret is in nothing the deck sends (#2178). A tracker
// that echoes the credential it was sent — in an error's reason, in the
// account it answers, in a read — reaches the page as [redacted], and the
// secret is never in the list, the saved connection, an error, the log, an
// error report, or any file but the secrets file. A booted deck in a sandbox
// home, with fake providers this suite registers itself (integrations-fake.ts).
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import type { Server } from "node:http";
import { rmTempDir } from "./rm-temp-dir";
import { basicCredential, fakeProvider, fakeToken, startFakeTracker, type FakeTracker } from "./integrations-fake";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-integrations-secrets-"));
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");
process.env.XDG_CONFIG_HOME = join(DIR, "config");
process.env.XDG_DATA_HOME = join(DIR, "data");
process.env.CCDECK_HOME = join(DIR, "deck");
process.env.AGENTS_DECK_NO_LAN = "1";
if (!resolve(process.env.CCDECK_HOME).startsWith(resolve(DIR))) throw new Error("sandbox escaped");

const said: string[] = [];
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
    said.push(args.map(a => (a instanceof Error ? `${a.stack}` : String(a))).join(" "));
  });
}

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/index.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { registerProvider } = await import("../../server/integrations/registry.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { REDACTED, redactSecrets, secretNeedles } = await import("../../server/integrations/routes.mjs");
// @ts-expect-error — plain .mjs server module, no types
const { scrub } = await import("../../server/reports.mjs");

const TOKEN = fakeToken("echoed");
const BASIC_TOKEN = fakeToken("echoed-basic");
const EMAIL = "jane@example.com";
const BASIC = basicCredential(EMAIL, BASIC_TOKEN);
const SECRETS = [TOKEN, BASIC_TOKEN, BASIC];

let server: Server;
let port = 0;
let token = "";
let bearerSite: FakeTracker;
let basicSite: FakeTracker;
beforeAll(async () => {
  [bearerSite, basicSite] = await Promise.all([startFakeTracker({ token: TOKEN }), startFakeTracker({ token: BASIC_TOKEN })]);
  registerProvider(fakeProvider({ kind: "tracker", label: "Tracker" }));
  registerProvider(fakeProvider({ kind: "tracker-basic", label: "Tracker Basic", basic: true }));
  server = await mod.startServer({ port: 0, persist: false, open: false, claude: false, codex: false });
  port = (server.address() as { port: number }).port;
  token = mod.hookToken();
}, 30_000);
afterAll(async () => {
  await new Promise(r => server.close(r));
  await Promise.all([bearerSite, basicSite].map(t => t?.close()));
  rmTempDir(DIR);
});

interface Answer { status: number; body: any; raw: string }
function call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Answer> {
  return new Promise((resolve_, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: "127.0.0.1", port, path, method, agent: false,
      headers: headers ?? { host: `127.0.0.1:${port}`, "x-ccdeck-token": token, ...(payload ? { "content-type": "application/json" } : {}) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed: any = null;
        try { parsed = JSON.parse(raw); } catch { /* nothing */ }
        resolve_({ status: res.statusCode ?? 0, body: parsed, raw });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}
const page = (path: string) => call("GET", path, undefined, { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
const expectNoSecret = (text: string, where = "") => { for (const s of SECRETS) expect(text.includes(s), `${where} holds a secret`).toBe(false); };

describe("which strings of a secret are taken out", () => {
  it("each string of eight characters or more, longest first, but an email address", () => {
    expect(secretNeedles("short")).toEqual([]);
    expect(secretNeedles(TOKEN)).toEqual([TOKEN]);
    const needles = secretNeedles({ auth: "basic", email: EMAIL, token: BASIC_TOKEN });
    expect(needles).toContain(BASIC_TOKEN);
    expect(needles).not.toContain(EMAIL);
    expect(needles).not.toContain("basic");
    expect(needles.map((n: string) => n.length)).toEqual([...needles.map((n: string) => n.length)].sort((a, b) => b - a));
  });

  it("and the HTTP Basic credential the secret's strings make", () => {
    expect(secretNeedles({ auth: "basic", email: EMAIL, token: BASIC_TOKEN })).toContain(BASIC);
  });

  it("out of every string and key of an answer, and the same answer back when it holds none", () => {
    const needles = secretNeedles(TOKEN);
    const answer = { ok: true, items: [{ title: `read with Bearer ${TOKEN}`, [TOKEN]: 1, n: 2, nested: [[`${TOKEN}${TOKEN}`]] }] };
    expect(redactSecrets(answer, needles)).toEqual({
      ok: true, items: [{ title: `read with Bearer ${REDACTED}`, [REDACTED]: 1, n: 2, nested: [[`${REDACTED}${REDACTED}`]] }],
    });
    const clean = { ok: true, items: [{ title: "nothing here" }] };
    expect(redactSecrets(clean, needles)).toBe(clean);
    expect(redactSecrets(`a ${TOKEN} b`, needles)).toBe(`a ${REDACTED} b`);
  });
});

describe("a tracker that echoes a bearer token", () => {
  let id = "";

  it("is connected with the account it answered, the echo taken out, in the answer and on disk", async () => {
    bearerSite.setMode("echo");
    const r = await call("POST", "/api/integrations/connections", { kind: "tracker", name: "Echo", input: { baseUrl: bearerSite.url, token: TOKEN } });
    expect(r.status).toBe(201);
    expect(r.body.connection.account).toMatchObject({ login: "jdoe", name: `Jane Doe, sent Bearer ${REDACTED}` });
    expectNoSecret(r.raw, "the answer");
    id = r.body.connection.id;
    const list = await page("/api/integrations");
    expect(list.body.connections.find((c: { id: string }) => c.id === id).account.name).toBe(`Jane Doe, sent Bearer ${REDACTED}`);
    expectNoSecret(list.raw, "the list");
    expectNoSecret(readFileSync(join(DIR, "deck", "integrations", "integrations.json"), "utf8"), "integrations.json");
  });

  it("is read with the echo taken out of the answer, a key included", async () => {
    const r = await page(`/api/integrations/tracker/${id}/items`);
    expect(r.status).toBe(200);
    expect(r.body.items[0].title).toBe(`First, sent Bearer ${REDACTED}`);
    expect(r.body.items[1][REDACTED]).toBe("a key");
    expectNoSecret(r.raw, "the read");
  });

  it("answers a failure whose reason echoes it as the envelope, the echo taken out", async () => {
    const r = await page(`/api/integrations/tracker/${id}/broken`);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, error: { kind: "upstream", detail: `Refused, sent Bearer ${REDACTED}` } });
    expectNoSecret(r.raw, "the error");
  });

  it("is tested and renamed without the echo, or a pasted token, being kept", async () => {
    const tested = await call("POST", `/api/integrations/connections/${id}/test`, {});
    expect(tested.status).toBe(200);
    expectNoSecret(tested.raw, "Test");
    const renamed = await call("PATCH", `/api/integrations/connections/${id}`, { name: `pasted ${TOKEN} by mistake` });
    expect(renamed.status).toBe(200);
    expect(renamed.body.connection.name).toBe(`pasted ${REDACTED} by mistake`);
    expectNoSecret(renamed.raw, "the edit");
  });

  it("refuses a connect whose refusal quotes the token typed into the form, the echo taken out", async () => {
    bearerSite.setMode("echo-refuse");
    try {
      const r = await call("POST", "/api/integrations/connections", { kind: "tracker", input: { baseUrl: bearerSite.url, token: TOKEN } });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({ kind: "permission", detail: `Not allowed, sent Bearer ${REDACTED}` });
      expectNoSecret(r.raw, "the refusal");
    } finally {
      bearerSite.setMode("echo");
    }
  });

  it("logs a provider's bug, and hands it to the error report, without the token", async () => {
    const from = said.length;
    const r = await page(`/api/integrations/tracker/${id}/crash`);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "internal error" });
    const logged = said.slice(from).join("\n");
    expect(logged).toMatch(/request handler failed/);
    expect(logged).toContain(`The client failed holding "${REDACTED}"`);
    expectNoSecret(logged, "the log");
  });
});

describe("a tracker that echoes an HTTP Basic credential", () => {
  it("keeps the account's email, and takes out the token and the credential made of it", async () => {
    basicSite.setMode("echo");
    const r = await call("POST", "/api/integrations/connections", { kind: "tracker-basic", input: { baseUrl: basicSite.url, email: EMAIL, token: BASIC_TOKEN } });
    expect(r.status).toBe(201);
    expect(r.body.connection.account).toMatchObject({ login: EMAIL, name: `Jane Doe, sent Basic ${REDACTED}` });
    expectNoSecret(r.raw, "the answer");
    const id = r.body.connection.id;
    const items = await page(`/api/integrations/tracker-basic/${id}/items`);
    expect(items.body.items[0].title).toBe(`First, sent Basic ${REDACTED}`);
    expect(items.body.items[1][REDACTED]).toBe("a key");
    expectNoSecret(items.raw, "the read");
    const broken = await page(`/api/integrations/tracker-basic/${id}/broken`);
    expect(broken.body.error.detail).toBe(`Refused, sent Basic ${REDACTED}`);
    expectNoSecret(broken.raw, "the error");
  });
});

describe("a connection an earlier build saved with the echo in it", () => {
  // Builds before the host took echoes out kept the account a tracker answered
  // as it came. Such a connection is listed without its own secret, and
  // Disconnect still takes it, and the secret, away.
  const EARLIER = fakeToken("saved-earlier");

  it("is listed with its own secret taken out of its name, account and meta", async () => {
    const home = join(DIR, "deck", "integrations");
    const metaPath = join(home, "integrations.json");
    const secretsPath = join(home, "integrations-secrets.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
    meta.connections.push({
      id: "saved-earlier", kind: "tracker", name: `Echo ${EARLIER}`, baseUrl: bearerSite.url,
      account: { id: "7", login: "jdoe", name: `Jane Doe, sent Bearer ${EARLIER}`, avatarUrl: "" },
      meta: { note: `sent ${EARLIER}` }, allowedOrigins: [new URL(bearerSite.url).origin],
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    });
    secrets.secrets["saved-earlier"] = EARLIER;
    writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
    writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });

    const list = await page("/api/integrations");
    expect(list.status).toBe(200);
    expect(list.raw.includes(EARLIER), "the list holds the earlier connection's secret").toBe(false);
    const listed = list.body.connections.find((c: { id: string }) => c.id === "saved-earlier");
    expect(listed).toMatchObject({
      id: "saved-earlier", kind: "tracker", name: `Echo ${REDACTED}`, tokenSaved: true,
      account: { login: "jdoe", name: `Jane Doe, sent Bearer ${REDACTED}` }, meta: { note: `sent ${REDACTED}` },
    });

    const gone = await call("DELETE", "/api/integrations/connections/saved-earlier");
    expect(gone.status).toBe(200);
    expect(readFileSync(metaPath, "utf8").includes(EARLIER)).toBe(false);
    expect(readFileSync(secretsPath, "utf8").includes(EARLIER)).toBe(false);
  });
});

describe("what the deck said, reported and kept while it ran", () => {
  it("never named a secret in the log", () => {
    expect(said.length).toBeGreaterThan(0);
    for (const line of said) expectNoSecret(line, line.slice(0, 80));
  });

  it("scrubs an Authorization value from an error report, whatever the token", () => {
    const out = scrub(`Authorization: Bearer ${TOKEN}\nAuthorization: Basic ${BASIC}`, "/home/nobody", "/opt/ccdeck");
    expectNoSecret(out, "the report");
  });

  it("kept the secrets in the secrets file and nowhere else", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
    const files = walk(DIR);
    const secrets = files.find(f => f.endsWith("integrations-secrets.json"))!;
    expect(readFileSync(secrets, "utf8")).toContain(TOKEN);
    for (const file of files) if (file !== secrets) expectNoSecret(readFileSync(file, "latin1"), file);
  });
});
