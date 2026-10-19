// A ccdeck-api for the account suites: an in-process node:http server that
// answers /v1/device/* the way the design's contracts say the real one will
// (plans/fleet/account-mvp-design-2026-10-18.md, sections 3.2-3.5).
//
// THE REAL ENDPOINTS DO NOT EXIST YET. Package B builds them in parallel; this
// is what the deck is coded against until they land. Every body it sends back
// starts from a contract fixture in fixtures/account-contract/ — byte-identical
// copies of ccdeck-api's tests/Ccdeck.Api.Tests/Contracts (package P0) — and
// its request checks mirror P0's parsers in src/Ccdeck.Api/Devices/Contracts.cs
// and SettingsSync/UiSettingsSchema.cs field for field, so a body this fake
// refuses names the same field the API would. The fixtures carry the shapes;
// this carries the behaviour (codes, polling, rotation, revisions, epochs).
//
// Behaviour kept to the design, deliberately strict where the deck's
// correctness depends on it: `slow_down` for a poll faster than the interval,
// a second success poll within 120 s minting a NEW token and killing the
// first, rotation that completes on the first use of the new token, the status
// frame's allowlist and epoch rules, `baseRevision` writes that 409 with the
// latest, and schema-1 writes that keep keys from newer schemas.
//
// The clock is the caller's (`now`), so a suite can expire a code or slow a
// poll without waiting. Every request is recorded, headers and body, so a
// suite can count them — zero, for a deck with the account off — and check
// what was never sent.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/account-contract/", import.meta.url));

/** One contract fixture, parsed fresh: callers may mutate what they get. */
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(FIXTURE_DIR + name, "utf8")) as T;
}

/** Every fixture name, for the suites that walk them. */
export function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR).filter(n => n.endsWith(".json")).sort();
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[0-9A-Za-z.+_-]+$/;
const UNKNOWN_REASONS = new Set(["warming-up", "unavailable", "no-capture", "starting"]);

/** The API's schema-1 allowlist (UiSettingsSchema.Settings in ccdeck-api),
 *  written out here — not imported from the deck, so the deck's copy is
 *  checked against it. `null` is never a value: leaving a key out unsets it. */
export const API_SCHEMA1: Record<string, (v: unknown) => boolean> = {
  theme: v => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v),
  textSize: v => ["smallest", "smaller", "default", "larger", "largest"].includes(v as string),
  density: v => ["tightest", "tighter", "compact", "default", "comfortable"].includes(v as string),
  "panels.sessionList": v => typeof v === "boolean",
  "panels.accounts": v => typeof v === "boolean",
  "panels.detail": v => typeof v === "boolean",
  "panels.usage": v => typeof v === "boolean",
  "panels.machine": v => typeof v === "boolean",
  singleKeyShortcuts: v => typeof v === "boolean",
  hideFinishedAfter: v => Number.isInteger(v) && [0, 5, 15, 30, 60].includes(v as number),
  character: v => typeof v === "boolean",
  sound: v => typeof v === "boolean",
};
const DEFAULT_OVERRIDES = ["sound"];

/** JsonFields.Timestamp's pattern: ISO 8601 with its zone. */
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,7})?)?(Z|z|[+-]\d{2}:\d{2})$/;
const present = (o: any, k: string) => o && typeof o === "object" && !Array.isArray(o) && Object.hasOwn(o, k) && o[k] !== null;
const isObj = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const isIso = (v: unknown) => typeof v === "string" && ZONED.test(v) && Number.isFinite(Date.parse(v));
const isUuid = (v: unknown) => typeof v === "string" && GUID.test(v) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(v);
const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** Collects problems by field path, the way JsonFields does: the first one
 *  per path, in the order the parser reads. */
class Problems {
  readonly fields: string[] = [];
  fail(path: string) { if (!this.fields.includes(path)) this.fields.push(path); }
  /** Required unless `optional`; null reads as absent. */
  get(o: any, k: string, path: string, optional = false): unknown {
    if (present(o, k)) return o[k];
    if (!optional) this.fail(path);
    return undefined;
  }
  check(o: any, k: string, path: string, ok: (v: unknown) => boolean, optional = false) {
    const v = this.get(o, k, path, optional);
    if (v !== undefined && !ok(v)) this.fail(path);
    return v;
  }
}

/** The fields a frame may carry, by path: everything else is ignored and not
 *  stored (design 3.4, "Allowlist (server-enforced)"). */
export const FRAME_FIELDS = [
  "v", "bootId", "seq", "observedAt", "state",
  "deck.version", "deck.os", "deck.arch", "deck.channel",
  "cpu.pct", "cpu.cores", "cpu.sampledAt", "cpu.unknown",
  "memory.usedPct", "memory.totalMb", "memory.sampledAt", "memory.unknown",
  "agents.running", "agents.waiting", "agents.sampledAt", "agents.unknown",
  "settings.profileId", "settings.appliedRevision",
];

/** StatusFrame.Parse: every field that is wrong, by path; [] when valid. */
export function frameProblems(f: any): string[] {
  const p = new Problems();
  if (!isObj(f)) { p.fail("frame"); return p.fields; }
  p.check(f, "v", "v", v => v === 1);
  p.check(f, "bootId", "bootId", isUuid);
  p.check(f, "seq", "seq", v => int(v, 0, 2 ** 53));
  p.check(f, "observedAt", "observedAt", isIso);
  p.check(f, "state", "state", v => v === "running" || v === "stopping");
  const deck = p.check(f, "deck", "deck", isObj) as any;
  if (isObj(deck)) {
    for (const [k, max] of [["version", 32], ["os", 16], ["arch", 16], ["channel", 16]] as const) {
      p.check(deck, k, `deck.${k}`, v => typeof v === "string" && v.length > 0 && v.length <= max && TOKEN.test(v));
    }
  }
  const metric = (name: string, fields: [string, (v: unknown) => boolean][]) => {
    const m = p.check(f, name, name, isObj) as any;
    if (!isObj(m)) return;
    if (Object.hasOwn(m, "unknown")) { p.check(m, "unknown", `${name}.unknown`, v => UNKNOWN_REASONS.has(v as string)); return; }
    for (const [k, ok] of fields) p.check(m, k, `${name}.${k}`, ok);
    p.check(m, "sampledAt", `${name}.sampledAt`, isIso);
  };
  metric("cpu", [["pct", v => num(v, 0, 100)], ["cores", v => int(v, 1, 4096)]]);
  metric("memory", [["usedPct", v => num(v, 0, 100)], ["totalMb", v => int(v, 1, 16_777_216)]]);
  metric("agents", [["running", v => int(v, 0, 10_000)], ["waiting", v => int(v, 0, 10_000)]]);
  const settings = p.check(f, "settings", "settings", isObj, true) as any;
  if (isObj(settings)) {
    p.check(settings, "profileId", "settings.profileId", isUuid);
    p.check(settings, "appliedRevision", "settings.appliedRevision", v => int(v, 0, Number.MAX_SAFE_INTEGER), true);
  }
  return p.fields;
}

/** The first field frameProblems names, or null for a valid frame. */
export function frameProblem(f: any): string | null {
  return frameProblems(f)[0] ?? null;
}

/** UiSettingsSchema.Validate for schema 1, under `prefix`. */
function valuesProblems(p: Problems, values: unknown, prefix = "values") {
  if (!isObj(values)) { p.fail(prefix); return; }
  if (Buffer.byteLength(JSON.stringify(values)) > 4096) { p.fail(prefix); return; }
  for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
    const ok = API_SCHEMA1[k];
    if (!ok || v === null || !ok(v)) p.fail(`${prefix}.${k}`);
  }
}

/** SettingsPutRequest.Parse. */
export function settingsPutProblems(b: any): string[] {
  const p = new Problems();
  if (!isObj(b)) { p.fail("body"); return p.fields; }
  p.check(b, "profileId", "profileId", isUuid);
  p.check(b, "baseRevision", "baseRevision", v => int(v, 0, Number.MAX_SAFE_INTEGER));
  const schema = p.check(b, "schema", "schema", v => v === 1);
  const values = p.get(b, "values", "values");
  if (values !== undefined && schema === 1) valuesProblems(p, values);
  return p.fields;
}

/** SettingsModeRequest.Parse: `schema` optional and 1 by default. */
export function settingsModeProblems(b: any): string[] {
  const p = new Problems();
  if (!isObj(b)) { p.fail("body"); return p.fields; }
  const mode = p.check(b, "mode", "mode", v => v === "independent" || v === "shared");
  const schemaGiven = p.check(b, "schema", "schema", v => v === 1, true);
  const schemaOk = schemaGiven === undefined || schemaGiven === 1;
  const readValues = () => { const v = p.get(b, "values", "values"); if (v !== undefined && schemaOk) valuesProblems(p, v); };
  if (mode === "shared") {
    const join = p.check(b, "join", "join", v => v === "use-shared" || v === "publish");
    if (join === "publish") {
      p.check(b, "sharedBaseRevision", "sharedBaseRevision", v => int(v, 0, Number.MAX_SAFE_INTEGER));
      readValues();
    }
  } else if (mode === "independent") {
    readValues();
  }
  return p.fields;
}

/** DeviceNames.Clean: C0/C1 controls to spaces, format characters removed,
 *  whitespace collapsed. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}

/** DeviceAuthorizeRequest.Validate. */
export function authorizeProblems(b: any): string[] {
  const p = new Problems();
  const n = [...cleanName(b?.name)].length;
  if (n < 1 || n > 48) p.fail("name");
  for (const [k, max] of [["os", 16], ["arch", 16], ["version", 32], ["channel", 16]] as const) {
    const v = b?.[k];
    if (!(typeof v === "string" && v.length > 0 && v.length <= max && TOKEN.test(v))) p.fail(k);
  }
  return p.fields;
}

/** DeviceTokenRequest.IsWellFormed. */
export function tokenRequestProblems(b: any): string[] {
  const c = b?.deviceCode;
  return typeof c === "string" && c.length === 48 && c.startsWith("ccdc_") ? [] : ["deviceCode"];
}

/** Each request contract's check, by the fixture name's first word. */
export const REQUEST_CHECKS: Record<string, (b: any) => string[]> = {
  "status-frame": frameProblems,
  "settings-put": settingsPutProblems,
  "settings-mode": settingsModeProblems,
  "device-authorize": authorizeProblems,
  "device-token": tokenRequestProblems,
};

/** The dotted paths of every leaf in `obj` — how a frame's key set is compared. */
export function leafPaths(obj: any, prefix = ""): string[] {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [prefix];
  return Object.keys(obj).flatMap(k => leafPaths(obj[k], prefix ? `${prefix}.${k}` : k));
}

export interface Recorded { method: string; path: string; headers: IncomingMessage["headers"]; body: any; raw: string }
interface Authorization {
  deviceCode: string; userCode: string; interval: number; expiresAt: number; lastPolledAt: number | null;
  state: "pending" | "approved" | "denied"; name: string; deliveredAt: number | null; deliveredToken: string | null;
  deviceId: string | null; accountId: string;
}
interface Profile { id: string; kind: "shared" | "device"; revision: number; schema: number; values: Record<string, unknown>; updatedAt: string; updatedBy: unknown }
interface Device {
  id: string; accountId: string; name: string; token: string | null; nextToken: string | null; revoked: string | null;
  mode: "independent" | "shared"; overrides: string[]; ownProfileId: string; rotateNext: boolean;
  epoch: { bootId: string; seq: number; retired: string[] } | null; frames: any[];
}
export interface Reply { status: number; body?: unknown; headers?: Record<string, string> }

export interface FakeApi {
  url: string;
  server: Server;
  requests: Recorded[];
  /** Requests to /v1/device/* only — what "no request goes to the API" counts. */
  deviceRequests(): Recorded[];
  close(): Promise<void>;
  /** Approve the newest pending code (or the one named) as `accountId`. */
  approve(userCode?: string, accountId?: string, email?: string): void;
  deny(userCode?: string): void;
  revoke(deviceId?: string, reason?: string): void;
  /** Ask the device to rotate on its next frame. */
  askRotate(deviceId?: string): void;
  /** The console editing the shared profile. */
  editShared(accountId: string, values: Record<string, unknown>, by?: string): Profile;
  devices: Map<string, Device>;
  profiles: Map<string, Profile>;
  authorizations: Map<string, Authorization>;
  sharedOf(accountId: string): Profile | null;
  /** Replace the answer to the next requests matching `path` (method optional). */
  override(path: string, reply: ((req: Recorded) => Reply | null) | null): void;
  /** Destroy the connection instead of answering the next token success, once
   *  — a response lost on the wire. */
  loseNextTokenResponse(): void;
  /** Change the authorize interval handed out. */
  interval: number;
  /** Where the approval page is said to be. */
  appBase: string;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (n: number) => randomBytes(n).toString("base64url");
const CONSONANTS = "BCDFGHJKLMNPQRSTVWXZ";
function userCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map(b => CONSONANTS[b % CONSONANTS.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export async function startFakeApi({ now = Date.now, appBase = "https://app.ccdeck.dev" } = {}): Promise<FakeApi> {
  const requests: Recorded[] = [];
  const authorizations = new Map<string, Authorization>();
  const devices = new Map<string, Device>();
  const profiles = new Map<string, Profile>();
  const sharedByAccount = new Map<string, string>();
  const tokenToDevice = new Map<string, string>();
  const overrides = new Map<string, (req: Recorded) => Reply | null>();
  const emails = new Map<string, string>();
  let loseNextToken = false;

  const api: Partial<FakeApi> = { interval: 5, appBase };

  /** A problem body: P0's own fixture for it where there is one, with the
   *  extensions this answer carries; otherwise the same shape. */
  const PROBLEM_FIXTURES: Record<string, string> = {
    authorization_pending: "device-token.error.authorization-pending.json",
    slow_down: "device-token.error.slow-down.json",
    access_denied: "device-token.error.access-denied.json",
    expired_token: "device-token.error.expired-token.json",
    invalid_grant: "device-token.error.invalid-grant.json",
    invalid_token: "device-error.invalid-token.json",
    device_revoked: "device-error.device-revoked.json",
    account_gone: "device-error.account-gone.json",
    stale_sequence: "device-error.stale-sequence.json",
    stale_boot: "device-error.stale-boot.json",
    revision_conflict: "settings-conflict.revision.json",
    profile_not_bound: "settings-conflict.not-bound.json",
    no_shared_profile: "settings-conflict.no-shared.json",
  };
  const problem = (status: number, error: string, extra: Record<string, unknown> = {}): Reply => ({
    status,
    body: PROBLEM_FIXTURES[error]
      ? { ...fixture(PROBLEM_FIXTURES[error]), ...extra }
      : { type: `https://api.ccdeck.dev/problems/${error.replace(/_/g, "-")}`, title: error, status, error, ...extra },
    headers: { "content-type": "application/problem+json" },
  });

  function profileJson(p: Profile, full = true) {
    return full ? { id: p.id, kind: p.kind, revision: p.revision, schema: p.schema, values: { ...p.values }, updatedAt: p.updatedAt, updatedBy: p.updatedBy }
      : { id: p.id, kind: p.kind, revision: p.revision, schema: p.schema, values: { ...p.values } };
  }

  function newProfile(kind: "shared" | "device"): Profile {
    const p: Profile = { id: randomUUID(), kind, revision: 0, schema: 1, values: {}, updatedAt: new Date(now()).toISOString(), updatedBy: null };
    profiles.set(p.id, p);
    return p;
  }

  function bound(d: Device): Profile {
    if (d.mode === "shared") return profiles.get(sharedByAccount.get(d.accountId)!)!;
    return profiles.get(d.ownProfileId)!;
  }

  function settingsDoc(d: Device, includeShared: boolean) {
    const sharedId = sharedByAccount.get(d.accountId);
    const own = profiles.get(d.ownProfileId)!;
    // As SettingsDocument has it: `own` only in shared mode, where the bound
    // profile is not the device's own; null in independent mode.
    return {
      mode: d.mode,
      overrides: [...d.overrides],
      profile: profileJson(bound(d)),
      own: d.mode === "shared" ? profileJson(own, false) : null,
      shared: includeShared ? (sharedId ? profileJson(profiles.get(sharedId)!) : null) : null,
    };
  }

  /** The bearer on a request, resolved — or the 401 it earns. Rotation
   *  completes here, on the first request made with the new token. */
  function authenticate(req: Recorded): { device: Device } | { reply: Reply } {
    const auth = String(req.headers.authorization ?? "");
    const m = /^Bearer (\S+)$/.exec(auth);
    const unauthorized = (error: string) => {
      const r = problem(401, error);
      r.headers = { ...r.headers, "www-authenticate": `Bearer error="invalid_token"` };
      return { reply: r };
    };
    if (!m) return unauthorized("invalid_token");
    const id = tokenToDevice.get(hash(m[1]));
    const d = id ? devices.get(id) : undefined;
    if (!d) return unauthorized("invalid_token");
    if (d.revoked) return unauthorized(d.revoked === "account_gone" ? "account_gone" : "device_revoked");
    if (d.nextToken && hash(m[1]) === d.nextToken) {
      if (d.token) tokenToDevice.delete(d.token);
      d.token = d.nextToken;
      d.nextToken = null;
    } else if (hash(m[1]) !== d.token) {
      return unauthorized("invalid_token");
    }
    return { device: d };
  }

  function mintToken(d: Device): string {
    const t = `ccdd_${b64url(32)}`;
    if (d.token) tokenToDevice.delete(d.token);
    d.token = hash(t);
    tokenToDevice.set(d.token, d.id);
    return t;
  }


  /** Write schema-1 values to a profile, keeping keys of any newer schema. */
  const pickKeys = (values: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(Object.entries(values).filter(([k]) => keys.includes(k)));
  const omitKeys = (values: Record<string, unknown>, keys: string[]) =>
    Object.fromEntries(Object.entries(values).filter(([k]) => !keys.includes(k)));

  function write(p: Profile, values: Record<string, unknown>, by: unknown) {
    const kept = Object.fromEntries(Object.entries(p.values).filter(([k]) => !(k in API_SCHEMA1)));
    p.values = { ...kept, ...values };
    p.revision += 1;
    p.updatedAt = new Date(now()).toISOString();
    p.updatedBy = by;
  }

  /** TypedResults.ValidationProblem, naming the fields. */
  const validation = (fields: string[]): Reply => ({
    status: 400,
    body: {
      type: "https://tools.ietf.org/html/rfc9110#section-15.5.1", title: "One or more validation errors occurred.", status: 400,
      errors: Object.fromEntries(fields.map(f => [f, [`${f} is not valid.`]])),
    },
    headers: { "content-type": "application/problem+json" },
  });

  function route(req: Recorded): Reply {
    const url = new URL(req.path, "http://fake");
    const path = url.pathname;
    const over = overrides.get(path) ?? overrides.get(`${req.method} ${path}`);
    if (over) {
      const r = over(req);
      if (r) return r;
    }

    if (req.method === "POST" && path === "/v1/device/authorize") {
      const b = req.body ?? {};
      const bad = authorizeProblems(b);
      if (bad.length) return validation(bad);
      const name = cleanName(b.name);
      const tpl = fixture("device-authorize.response.json");
      const a: Authorization = {
        deviceCode: `ccdc_${b64url(32)}`, userCode: userCode(), interval: api.interval!, expiresAt: now() + tpl.expiresIn * 1000,
        lastPolledAt: null, state: "pending", name, deliveredAt: null, deliveredToken: null, deviceId: null, accountId: "",
      };
      authorizations.set(a.deviceCode, a);
      return {
        status: 200,
        body: {
          ...tpl,
          deviceCode: a.deviceCode,
          userCode: a.userCode,
          verificationUri: `${api.appBase}/connect`,
          verificationUriComplete: `${api.appBase}/connect?code=${a.userCode}`,
          interval: a.interval,
        },
        headers: { "content-type": "application/json" },
      };
    }

    if (req.method === "POST" && path === "/v1/device/token") {
      if (tokenRequestProblems(req.body).length) return problem(400, "invalid_grant");
      const a = authorizations.get(String(req.body?.deviceCode ?? ""));
      if (!a) return problem(400, "invalid_grant");
      const t = now();
      if (t >= a.expiresAt) return problem(400, "expired_token");
      if (a.state === "denied") return problem(400, "access_denied");
      if (a.lastPolledAt != null && t - a.lastPolledAt < a.interval * 1000) {
        a.lastPolledAt = t;
        a.interval += 5;
        return problem(400, "slow_down", { interval: a.interval });
      }
      a.lastPolledAt = t;
      if (a.state === "pending") return problem(400, "authorization_pending", { interval: a.interval });
      if (a.deliveredAt != null && t - a.deliveredAt > 120_000) return problem(400, "expired_token");
      // Approved: delivered here and only here. A second success poll inside
      // 120 s mints a new token and kills the one before.
      let d = a.deviceId ? devices.get(a.deviceId) : undefined;
      if (!d) {
        const own = newProfile("device");
        d = {
          id: randomUUID(), accountId: a.accountId, name: a.name, token: null, nextToken: null, revoked: null,
          mode: "independent", overrides: [...DEFAULT_OVERRIDES], ownProfileId: own.id, rotateNext: false, epoch: null, frames: [],
        };
        devices.set(d.id, d);
        a.deviceId = d.id;
      }
      const token = mintToken(d);
      a.deliveredAt ??= t;
      const tpl = fixture("device-token.response.json");
      return {
        status: 200,
        body: {
          ...tpl,
          accessToken: token,
          deviceId: d.id,
          name: d.name,
          account: { id: d.accountId, email: emails.get(d.accountId) ?? tpl.account.email },
          settings: { mode: d.mode, profileId: bound(d).id, revision: bound(d).revision },
        },
        headers: { "content-type": "application/json" },
      };
    }

    if (!path.startsWith("/v1/device")) return { status: 404, body: { error: "not_found" }, headers: { "content-type": "application/problem+json" } };

    const who = authenticate(req);
    if ("reply" in who) return who.reply;
    const d = who.device;

    if (req.method === "POST" && path === "/v1/device/token/rotate") {
      const t = `ccdd_${b64url(32)}`;
      if (d.nextToken) tokenToDevice.delete(d.nextToken);
      d.nextToken = hash(t);
      tokenToDevice.set(d.nextToken, d.id);
      d.rotateNext = false;
      return { status: 200, body: { ...fixture("device-rotate.response.json"), accessToken: t }, headers: { "content-type": "application/json" } };
    }

    if (req.method === "POST" && path === "/v1/device/status") {
      if (Buffer.byteLength(req.raw) > 4096) return problem(413, "too_large");
      const bad = frameProblems(req.body);
      if (bad.length) return validation(bad);
      const f = req.body;
      const e = d.epoch;
      if (e && f.bootId === e.bootId && f.seq <= e.seq) return problem(409, "stale_sequence");
      if (e && e.retired.includes(f.bootId)) return problem(409, "stale_boot");
      if (!e || f.bootId !== e.bootId) {
        const retired = e ? [e.bootId, ...e.retired].slice(0, 4) : [];
        d.epoch = { bootId: f.bootId, seq: f.seq, retired };
      } else {
        e.seq = f.seq;
      }
      // Only the allowlisted fields are kept.
      const kept: Record<string, unknown> = {};
      for (const p of FRAME_FIELDS) {
        const v = p.split(".").reduce((o: any, k) => (o == null ? undefined : o[k]), f);
        if (v !== undefined) kept[p] = v;
      }
      d.frames.push(kept);
      const tpl = fixture("status-response.json");
      const b = bound(d);
      return {
        status: 200,
        body: { ...tpl, settings: { profileId: b.id, revision: b.revision }, rotateToken: d.rotateNext },
        headers: { "content-type": "application/json" },
      };
    }

    if (req.method === "GET" && path === "/v1/device") {
      const b = bound(d);
      return {
        status: 200,
        body: { ...fixture("device-info.response.json"), deviceId: d.id, name: d.name, account: { id: d.accountId, email: emails.get(d.accountId) ?? "me@example.com" },
          settings: { mode: d.mode, profileId: b.id, revision: b.revision, overrides: d.overrides } },
        headers: { "content-type": "application/json" },
      };
    }

    if (req.method === "DELETE" && path === "/v1/device") {
      d.revoked = "disconnected_on_device";
      return { status: 204 };
    }

    if (req.method === "GET" && path === "/v1/device/settings") {
      return { status: 200, body: settingsDoc(d, url.searchParams.get("include") === "shared"), headers: { "content-type": "application/json", etag: `"p:${bound(d).id}:r${bound(d).revision}"` } };
    }

    if (req.method === "PUT" && path === "/v1/device/settings") {
      const b = req.body ?? {};
      const bad = settingsPutProblems(b);
      if (bad.length) return validation(bad);
      const target = profiles.get(String(b.profileId));
      const own = target?.id === d.ownProfileId;
      if (!target || (target.id !== bound(d).id && !own)) {
        const bd = bound(d);
        return problem(409, "profile_not_bound", { binding: { mode: d.mode, profileId: bd.id, revision: bd.revision } });
      }
      // SettingsProfiles.PutAsync's rules in shared mode: the device's own
      // profile takes only the override keys, the shared one never does.
      if (own && d.mode === "shared") {
        const strays = Object.keys(b.values).filter(k => !d.overrides.includes(k));
        if (strays.length) return validation(strays.map(k => `values.${k}`));
      }
      if (!own && d.mode === "shared") {
        const kept = Object.keys(b.values).filter(k => d.overrides.includes(k));
        if (kept.length) return validation(kept.map(k => `values.${k}`));
      }
      if (b.baseRevision !== target.revision) return problem(409, "revision_conflict", { latest: profileJson(target, false) });
      // And what each keeps as stored: the shared profile its override keys
      // (MergeKeeping), the own profile everything else (OverridesOnly).
      const values = d.mode !== "shared" ? b.values
        : own ? { ...omitKeys(target.values, d.overrides), ...b.values }
        : { ...b.values, ...pickKeys(target.values, d.overrides) };
      write(target, values, { kind: "device", deviceId: d.id, name: d.name });
      return { status: 200, body: { profile: profileJson(target) }, headers: { "content-type": "application/json" } };
    }

    if (req.method === "POST" && path === "/v1/device/settings/mode") {
      const b = req.body ?? {};
      const bad = settingsModeProblems(b);
      if (bad.length) return validation(bad);
      const by = { kind: "device", deviceId: d.id, name: d.name };
      if (b.mode === "shared" && b.join === "use-shared") {
        if (!sharedByAccount.has(d.accountId)) return problem(409, "no_shared_profile");
        d.mode = "shared";
      } else if (b.mode === "shared" && b.join === "publish") {
        let shared = sharedByAccount.has(d.accountId) ? profiles.get(sharedByAccount.get(d.accountId)!)! : null;
        const base = shared?.revision ?? 0;
        if (b.sharedBaseRevision !== base) return problem(409, "revision_conflict", { latest: shared ? profileJson(shared, false) : null });
        if (!shared) {
          shared = newProfile("shared");
          sharedByAccount.set(d.accountId, shared.id);
        }
        // As SettingsProfiles.PublishAsync: the override keys go to the
        // device's own profile, everything else to the shared one, which keeps
        // its own override keys as stored.
        write(shared, { ...omitKeys(b.values, d.overrides), ...pickKeys(shared.values, d.overrides) }, by);
        const ownProfile = profiles.get(d.ownProfileId)!;
        const ownValues = { ...omitKeys(ownProfile.values, d.overrides), ...pickKeys(b.values, d.overrides) };
        if (JSON.stringify(ownValues) !== JSON.stringify(ownProfile.values)) write(ownProfile, ownValues, by);
        d.mode = "shared";
      } else {
        write(profiles.get(d.ownProfileId)!, b.values, by);
        d.mode = "independent";
      }
      return { status: 200, body: settingsDoc(d, false), headers: { "content-type": "application/json" } };
    }

    return { status: 404, body: { error: "not_found" }, headers: { "content-type": "application/problem+json" } };
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      let body: any = undefined;
      if (raw) { try { body = JSON.parse(raw); } catch { body = undefined; } }
      const rec: Recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body, raw };
      requests.push(rec);
      const reply = route(rec);
      if (rec.path === "/v1/device/token" && reply.status === 200 && loseNextToken) {
        loseNextToken = false;
        req.socket.destroy();
        return;
      }
      const text = reply.body === undefined ? "" : JSON.stringify(reply.body);
      res.writeHead(reply.status, { ...(text ? { "content-type": "application/json" } : {}), ...reply.headers });
      res.end(text);
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const newest = (userCodeWanted?: string) => [...authorizations.values()].filter(a => !userCodeWanted || a.userCode === userCodeWanted).at(-1);

  return Object.assign(api, {
    url: `http://127.0.0.1:${port}`,
    server,
    requests,
    deviceRequests: () => requests.filter(r => r.path.startsWith("/v1/device")),
    close: () => new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); }),
    approve(code?: string, accountId = "0199e1c0-0d5b-7d02-8a51-3f6e2c9b1a77", email = "me@example.com") {
      const a = newest(code);
      if (!a) throw new Error("no authorization to approve");
      a.state = "approved";
      a.accountId = accountId;
      emails.set(accountId, email);
    },
    deny(code?: string) {
      const a = newest(code);
      if (a) a.state = "denied";
    },
    revoke(deviceId?: string, reason = "device_revoked") {
      const d = deviceId ? devices.get(deviceId) : [...devices.values()].at(-1);
      if (d) d.revoked = reason;
    },
    askRotate(deviceId?: string) {
      const d = deviceId ? devices.get(deviceId) : [...devices.values()].at(-1);
      if (d) d.rotateNext = true;
    },
    editShared(accountId: string, values: Record<string, unknown>, by = "desktop-a") {
      let shared = sharedByAccount.has(accountId) ? profiles.get(sharedByAccount.get(accountId)!)! : null;
      if (!shared) {
        shared = newProfile("shared");
        sharedByAccount.set(accountId, shared.id);
      }
      write(shared, { ...Object.fromEntries(Object.entries(shared.values).filter(([k]) => k in API_SCHEMA1)), ...values }, { kind: "console", name: by });
      return shared;
    },
    devices,
    profiles,
    authorizations,
    sharedOf: (accountId: string) => (sharedByAccount.has(accountId) ? profiles.get(sharedByAccount.get(accountId)!)! : null),
    override(path: string, reply: ((req: Recorded) => Reply | null) | null) {
      if (reply) overrides.set(path, reply);
      else overrides.delete(path);
    },
    loseNextTokenResponse() { loseNextToken = true; },
  }) as FakeApi;
}
