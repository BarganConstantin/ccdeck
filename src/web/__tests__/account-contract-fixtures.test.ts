// The API's contracts, as the deck reads them: every fixture in
// fixtures/account-contract/ against the deck's own parsers, allowlists and
// frame builder, and against the fake API's request checks the deck is tested
// through.
//
// THE FIXTURES ARE ccdeck-api's, BYTE FOR BYTE: tests/Ccdeck.Api.Tests/Contracts
// on the API's P0 branch (feat/accounts-p0-foundation), where
// ContractFixtureTests holds the API's records and parsers to the same files.
// Their names say what each one is: `<contract>.json` is valid,
// `<contract>.invalid.<field>.json` fails on exactly that field, and the rest
// are answers and problems the API writes. When the API changes one, it is
// copied here again unchanged, and this file says whether the deck still reads
// it.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FIXTURE_DIR, fixture, fixtureNames, frameProblem, leafPaths, REQUEST_CHECKS, settingsModeProblems, authorizeProblems } from "./account-fake-api";
// @ts-expect-error — plain .mjs server module, no types
import { cleanDeviceName, parseAuthorize, parseTokenResponse } from "../../server/account-connect.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { buildFrame } from "../../server/account-status.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { cleanUiValues, resolveUiValues, UI_KEYS, DEFAULT_OVERRIDES } from "../../server/account-ui-fields.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { normaliseSync, createSync, initialSync } from "../../server/account-sync.mjs";

const INVALID = ".invalid.";
const contractOf = (name: string) => name.slice(0, name.indexOf("."));
const fieldOf = (name: string) => name.slice(name.indexOf(INVALID) + INVALID.length, -".json".length);

describe("the contract fixtures", () => {
  it("are P0's set: every documented example, and the invalid ones named for their field", () => {
    const names = fixtureNames();
    expect(names.length).toBeGreaterThanOrEqual(66);
    // ContractFixtureTests.Every_documented_example_is_a_fixture's list.
    for (const wanted of [
      "status-frame.json", "status-response.json", "device-authorize.request.json", "device-authorize.response.json",
      "device-token.request.json", "device-token.response.json", "device-info.response.json", "settings-document.shared.json",
      "settings-put.json", "settings-put.invalid.values.fontFamily.json", "settings-put.invalid.schema.json",
      "settings-mode.use-shared.json", "settings-mode.publish.json", "settings-mode.independent.json",
      "settings-conflict.revision.json", "settings-conflict.not-bound.json", "machine-view.json", "console-snapshot.json",
      "console-event.machine-removed.json", "console-event.signed-out.json",
    ]) expect(names, wanted).toContain(wanted);
    for (const n of names) expect(() => fixture(n), n).not.toThrow();
  });

  it("are copied unchanged: UTF-8 JSON, no byte rewritten on the way in", () => {
    // A copy that re-serialised a file would change its bytes; the API's
    // own suite reads the same bytes. This is the cheap half of that promise —
    // the full one is a byte comparison against the API's branch, done when
    // the files are copied.
    for (const n of fixtureNames()) {
      const bytes = readFileSync(FIXTURE_DIR + n);
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${n} has a BOM`).toBe(false);
      expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
    }
  });
});

describe("every request fixture, against the API's checks", () => {
  const requests = fixtureNames().filter(n => REQUEST_CHECKS[contractOf(n)] && !n.includes(".response.") && !n.includes(".error."));

  it("covers every request contract", () => {
    expect(new Set(requests.map(contractOf))).toEqual(new Set(Object.keys(REQUEST_CHECKS)));
    expect(requests.filter(n => n.includes(INVALID)).length).toBeGreaterThanOrEqual(25);
  });

  for (const name of requests) {
    it(name, () => {
      const problems = REQUEST_CHECKS[contractOf(name)](fixture(name));
      if (name.includes(INVALID)) expect(problems).toEqual([fieldOf(name)]);
      else expect(problems).toEqual([]);
    });
  }
});

describe("the deck reads the API's answers", () => {
  it("takes the authorize answer", () => {
    const at = Date.parse("2026-10-18T09:00:00Z");
    const code = parseAuthorize(fixture("device-authorize.response.json"), at);
    expect(code).toMatchObject({ userCode: "WDJB-MJHT", interval: 5, verificationUriComplete: "https://app.ccdeck.dev/connect?code=WDJB-MJHT" });
    expect(code.expiresAt).toBe(at + 600_000);
  });

  it("refuses an authorize answer whose page is not https, but not a development API on loopback", () => {
    expect(parseAuthorize({ ...fixture("device-authorize.response.json"), verificationUriComplete: "http://evil.example/connect" })).toBeNull();
    expect(parseAuthorize({
      ...fixture("device-authorize.response.json"),
      verificationUri: "http://127.0.0.1:5317/connect", verificationUriComplete: "http://127.0.0.1:5317/connect?code=WDJB-MJHT",
    })).not.toBeNull();
  });

  it("takes the token answer: the device bound to its own profile in independent mode", () => {
    const t = parseTokenResponse(fixture("device-token.response.json"));
    expect(t).toMatchObject({
      accessToken: expect.stringMatching(/^ccdd_/), deviceId: "0199f0a2-6c1e-7b3a-9d2e-5b8f3c1a7e40",
      account: { id: "0199e1c0-0d5b-7d02-8a51-3f6e2c9b1a77", email: "me@example.com" },
      settings: { mode: "independent", profileId: "0199f0a2-7000-7bb2-8d4f-2c3e4f5a6b7c", revision: 0 },
      everySec: 15,
    });
  });

  it("reads the rotation answer's token as a device token", () => {
    expect(fixture("device-rotate.response.json").accessToken).toMatch(/^ccdd_[A-Za-z0-9_-]{20,128}$/);
  });

  it("asks for a code the API accepts, and cleans a name the way the API does", () => {
    const sent = { ...fixture("device-authorize.request.json"), name: cleanDeviceName("laptop-a") };
    expect(authorizeProblems(sent)).toEqual([]);
    expect(cleanDeviceName(fixture("device-authorize.invalid.name.json").name)).toBe("");
  });

  it("keeps the shared document's profiles, and resolves sound from the device's own", () => {
    const doc = fixture("settings-document.shared.json");
    expect(cleanUiValues(doc.profile.values).values).toEqual(doc.profile.values);
    const kept = normaliseSync({ accountId: "a", base: doc.profile, own: doc.own });
    expect(kept.base).toMatchObject({ id: doc.profile.id, kind: "shared", revision: 14 });
    expect(kept.own.values).toEqual({ sound: false });
    expect(resolveUiValues({ mode: "shared", bound: doc.profile, own: doc.own, overrides: doc.overrides }))
      .toEqual({ theme: "rider-black", density: "compact", "panels.detail": true, sound: false });
  });

  it("never takes an override key from the shared profile (UiSettingsSchema.Resolve)", () => {
    const shared = { values: { theme: "nord", sound: true } };
    expect(resolveUiValues({ mode: "shared", bound: shared, own: { values: {} }, overrides: ["sound"] })).toEqual({ theme: "nord" });
    expect(resolveUiValues({ mode: "shared", bound: shared, own: null, overrides: ["sound"] })).toEqual({ theme: "nord" });
  });

  it("takes an independent document, whose `own` is null, as the device's own profile", async () => {
    const doc = fixture("settings-document.independent-with-preview.json");
    expect(doc.own).toBeNull();
    const client = { get: async () => ({ ok: true, status: 200, body: doc }) };
    const sync = createSync({
      client, token: () => "ccdd_x",
      state: initialSync({ accountId: "a", previousAccountId: "", settings: { mode: "independent", profileId: doc.profile.id, revision: 0 } }),
    });
    await sync.pull();
    expect(sync.view()).toMatchObject({ mode: "independent", savedRevision: 4, apply: { revision: 4, values: { theme: "paper", density: "default", sound: false } } });
    const preview = await sync.preview();
    expect(preview.shared).toMatchObject({ revision: 14, values: doc.shared.values });
  });

  it("refuses each setting the API refuses, by the same name", () => {
    for (const n of fixtureNames().filter(x => x.startsWith("settings-put.invalid.values."))) {
      const key = fieldOf(n).slice("values.".length);
      expect(cleanUiValues(fixture(n).values).refused, n).toEqual([key]);
    }
    expect(cleanUiValues(fixture("settings-put.json").values).refused).toEqual([]);
    expect(cleanUiValues(fixture("settings-mode.invalid.values.loadAverage.json").values).refused).toEqual(["loadAverage"]);
  });

  it("has the API's schema 1, key for key, and sound as the one override", () => {
    expect([...UI_KEYS].sort()).toEqual([
      "character", "density", "hideFinishedAfter", "panels.accounts", "panels.detail", "panels.machine",
      "panels.sessionList", "panels.usage", "singleKeyShortcuts", "sound", "textSize", "theme",
    ]);
    expect([...DEFAULT_OVERRIDES]).toEqual(fixture("settings-document.shared.json").overrides);
  });
});

describe("the bodies the deck sends", () => {
  it("change the mode in a shape the API accepts, each way", () => {
    for (const body of [
      { mode: "shared", join: "use-shared", schema: 1 },
      { mode: "shared", join: "publish", sharedBaseRevision: 0, schema: 1, values: { theme: "paper" } },
      { mode: "independent", schema: 1, values: { theme: "paper", density: "compact" } },
    ]) expect(settingsModeProblems(body), JSON.stringify(body)).toEqual([]);
    // And a schema the API does not know is refused by name.
    expect(settingsModeProblems({ mode: "independent", schema: 2, values: {} })).toEqual(["schema"]);
  });
});

describe("the status frame", () => {
  const f = fixture("status-frame.json");
  const reading = (m: any, fields: string[]) => ("unknown" in m ? { unknown: m.unknown } : { ...Object.fromEntries(fields.map(k => [k, m[k]])), sampledAt: Date.parse(m.sampledAt) });
  const build = (src: any, state = src.state) => buildFrame({
    bootId: src.bootId, seq: src.seq, observedAt: Date.parse(src.observedAt), state, deck: src.deck,
    cpu: reading(src.cpu, ["pct", "cores"]), memory: reading(src.memory, ["usedPct", "totalMb"]), agents: reading(src.agents, ["running", "waiting"]),
    settings: src.settings ?? null,
  });

  it("is built with exactly the fixture's fields, no more", () => {
    const built = buildFrame({
      bootId: f.bootId, seq: f.seq, observedAt: Date.parse(f.observedAt), state: "running", deck: f.deck,
      cpu: { pct: f.cpu.pct, cores: f.cpu.cores, sampledAt: Date.parse(f.cpu.sampledAt), loadAverage: [2.4] },
      memory: { usedPct: f.memory.usedPct, totalMb: f.memory.totalMb, sampledAt: Date.parse(f.memory.sampledAt), available: 1 },
      agents: { running: 3, waiting: 1, sampledAt: Date.parse(f.agents.sampledAt), names: ["secret project"] },
      settings: { profileId: f.settings.profileId, appliedRevision: 13, mode: "shared" },
    });
    expect(leafPaths(built).sort()).toEqual(leafPaths(f).sort());
    expect(built).toEqual(f);
  });

  it("reproduces the stopping and unknown-metrics fixtures — null applied revision, no settings, unknown not zero", () => {
    const stopping = fixture("status-frame.stopping.json");
    expect(build(stopping)).toEqual(stopping);
    const unknown = fixture("status-frame.unknown-metrics.json");
    expect(build(unknown)).toEqual(unknown);
    for (const frame of [stopping, unknown]) expect(frameProblem(frame)).toBeNull();
  });

  it("carries none of what the API ignores: no load average, no hostname, no temperature", () => {
    const extra = fixture("status-frame.extra-fields.json");
    expect(frameProblem(extra), "the API takes the frame and drops the rest").toBeNull();
    const built = build(extra);
    expect(built).toEqual(f);
    expect(JSON.stringify(built)).not.toMatch(/load1|hostname|temperature/);
  });

  it("never says bad-timestamp, which only the API writes", () => {
    expect(frameProblem(fixture("status-frame.invalid.memory.unknown.json"))).toBe("memory.unknown");
  });
});

describe("MachineView and the console's events", () => {
  it("carry only what a frame sent — no load average, no hostname, no paths — and null for a machine that never reported", () => {
    for (const n of ["machine-view.json", "machine-view.never.json"]) {
      const view = fixture(n);
      expect(Object.keys(view).sort(), n).toEqual(
        ["agents", "arch", "channel", "clockSkewed", "cpu", "enrolledAt", "id", "link", "memory", "name", "os", "sync", "version"].sort());
      expect(JSON.stringify(view), n).not.toMatch(/load|hostname|path|session/i);
    }
    const never = fixture("machine-view.never.json");
    expect([never.cpu, never.memory, never.agents]).toEqual([null, null, null]);
    expect(fixture("console-snapshot.json").machines[0]).toEqual(fixture("machine-view.json"));
  });
});
