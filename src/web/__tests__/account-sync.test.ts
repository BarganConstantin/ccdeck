// Settings sync, the deck server's half (account-sync.mjs), against the fake
// API's profiles: revisions, conflicts, joining and leaving shared settings,
// the override keys, a different account, and a restart (design 4.6).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { enroll, fakeClock, manualTimers, settle, tempDir, until } from "./account-test-kit";
import { startFakeApi, type FakeApi } from "./account-fake-api";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain .mjs server module, no types
import { createSync, initialSync } from "../../server/account-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountClient } from "../../server/account-client.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createAccountService } from "../../server/account-service.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createTokenStore } from "../../server/account-token-store.mjs";

let api: FakeApi;
beforeAll(async () => { api = await startFakeApi(); });
afterAll(async () => { await api.close(); });

const puts = () => api.requests.filter(r => r.method === "PUT" && r.path === "/v1/device/settings");

/** A device enrolled in an account of its own, and its sync, pulled once. */
async function device({ accountId = randomUUID(), previousAccountId = "" } = {}) {
  const t = await enroll(api, { accountId });
  const client = createAccountClient({ apiBase: api.url });
  const persisted: unknown[] = [];
  const sync = createSync({
    client,
    token: () => t.accessToken,
    state: initialSync({ accountId: t.account.id, previousAccountId, settings: t.settings }),
    persist: async (s: unknown) => { persisted.push(JSON.parse(JSON.stringify(s))); },
  });
  await sync.pull();
  const own = () => api.profiles.get(api.devices.get(t.deviceId)!.ownProfileId)!;
  return { t, sync, persisted, own, accountId };
}

/** The console, or another deck, changing a profile under this one. */
function changeElsewhere(profileId: string, values: Record<string, unknown>) {
  const p = api.profiles.get(profileId)!;
  p.values = { ...p.values, ...values };
  p.revision += 1;
  p.updatedBy = { kind: "device", name: "desktop-a" };
  return p.revision;
}

describe("saving", () => {
  it("saves an edit and bumps the revision, which this device already shows", async () => {
    const { sync, own } = await device();
    await sync.reportUi({ theme: "paper" }, "user");
    const v = sync.view();
    expect(v).toMatchObject({ savedRevision: 1, appliedRevision: 1, pending: null, conflict: null, apply: null });
    expect(own().values).toEqual({ theme: "paper" });
    expect(sync.binding()).toEqual({ profileId: own().id, appliedRevision: 1 });
  });

  it("keeps an edit pending while the API is unreachable, and saves it on the next good frame", async () => {
    const { sync, own } = await device();
    api.override("PUT /v1/device/settings", () => ({ status: 503 }));
    await sync.reportUi({ density: "compact" }, "user");
    expect(sync.view()).toMatchObject({ pending: { keys: ["density"] }, saving: "offline", savedRevision: 0 });
    api.override("PUT /v1/device/settings", null);
    await sync.onControl({ profileId: own().id, revision: 0 });
    expect(sync.view()).toMatchObject({ pending: null, saving: "idle", savedRevision: 1 });
    expect(own().values).toEqual({ density: "compact" });
  });

  it("drops a toggle that comes back to the saved value before it is sent", async () => {
    const { sync } = await device();
    await sync.reportUi({ theme: "paper" }, "user");
    api.override("PUT /v1/device/settings", () => ({ status: 503 }));
    await sync.reportUi({ density: "compact" }, "user");
    await sync.reportUi({ density: "default", theme: "paper" }, "user");
    // density was never saved, so "default" is a change too; theme is back to
    // what is saved, so it is not pending.
    expect(sync.view().pending.keys).toEqual(["density"]);
    api.override("PUT /v1/device/settings", null);
  });

  it("refuses to send what is not on the allowlist", async () => {
    const { sync } = await device();
    const before = puts().length;
    await sync.reportUi({ fontFamily: "Comic Sans", theme: "Not A Theme!", notifications: true }, "user");
    expect(puts().length).toBe(before);
    expect(sync.view().pending).toBeNull();
  });
});

describe("conflicts", () => {
  it("keeps the draft on a 409, and Use latest drops it and applies the latest", async () => {
    const { sync, own } = await device();
    await sync.reportUi({ theme: "paper" }, "user");
    const rev = changeElsewhere(own().id, { theme: "nord" });
    await sync.reportUi({ density: "compact" }, "user");
    const v = sync.view();
    expect(v.conflict).toMatchObject({ latest: { revision: rev, values: { theme: "nord" } }, mine: { density: "compact" } });
    expect(v.pending.keys).toEqual(["density"]);
    await sync.resolve("use-latest");
    expect(sync.view()).toMatchObject({ conflict: null, pending: null, savedRevision: rev, apply: { revision: rev, values: { theme: "nord" } } });
  });

  it("Save mine over rN writes the draft on top of the latest", async () => {
    const { sync, own } = await device();
    await sync.reportUi({ theme: "paper" }, "user");
    const rev = changeElsewhere(own().id, { theme: "nord" });
    await sync.reportUi({ density: "compact" }, "user");
    expect(sync.view().conflict).not.toBeNull();
    await sync.resolve("reapply");
    expect(sync.view()).toMatchObject({ conflict: null, pending: null, savedRevision: rev + 1 });
    expect(own().values).toEqual({ theme: "nord", density: "compact" });
  });

  it("a pull that finds a newer revision under a pending edit raises the conflict instead of applying", async () => {
    const { sync, own } = await device();
    api.override("PUT /v1/device/settings", () => ({ status: 503 }));
    await sync.reportUi({ theme: "paper" }, "user");
    api.override("PUT /v1/device/settings", null);
    changeElsewhere(own().id, { theme: "nord" });
    await sync.pull();
    expect(sync.view()).toMatchObject({ apply: null, conflict: { latest: { values: { theme: "nord" } } }, pending: { keys: ["theme"] } });
  });
});

describe("pulling and applying", () => {
  it("applies a newer revision only without a pending edit, and reports it applied only after a tab says so", async () => {
    const { sync, own } = await device();
    const rev = changeElsewhere(own().id, { theme: "nord", sound: false });
    await sync.onControl({ profileId: own().id, revision: rev });
    expect(sync.view().apply).toEqual({ revision: rev, values: { theme: "nord", sound: false } });
    expect(sync.binding().appliedRevision, "nothing on screen yet").toBe(0);
    await sync.applied(rev);
    expect(sync.view().apply).toBeNull();
    expect(sync.binding().appliedRevision).toBe(rev);
  });

  it("counts a revision whose theme this deck could not apply as processed, and says which", async () => {
    const { sync, own } = await device();
    const rev = changeElsewhere(own().id, { theme: "some-future-theme" });
    await sync.pull();
    await sync.applied(rev, { theme: "some-future-theme" });
    expect(sync.view()).toMatchObject({ apply: null, appliedRevision: rev, skipped: { theme: "some-future-theme" } });
  });

  it("ignores an applied revision the account never had", async () => {
    const { sync } = await device();
    await sync.applied(99);
    expect(sync.view().appliedRevision).toBe(0);
  });

  it("lets a second browser profile adopt the account's values rather than overwrite them", async () => {
    const { sync, own } = await device();
    // The first tab uploaded at connect.
    await sync.reportUi({ theme: "paper", density: "compact" }, "initial");
    const saved = sync.view().savedRevision;
    const before = puts().length;
    // A second profile opens the same deck with its own localStorage.
    await sync.reportUi({ theme: "rider-black", density: "default" }, "initial");
    expect(puts().length, "nothing uploaded").toBe(before);
    expect(sync.view()).toMatchObject({ savedRevision: saved, adopt: { values: { theme: "paper", density: "compact" } } });
    expect(own().values).toEqual({ theme: "paper", density: "compact" });
  });
});

describe("first connect and a different account", () => {
  it("uploads the tab's values as the device profile on a first connect", async () => {
    const { sync, own } = await device();
    expect(sync.view().initialUpload).toBe(true);
    await sync.reportUi({ theme: "paper", sound: true }, "initial");
    expect(own().values).toEqual({ theme: "paper", sound: true });
    expect(sync.view()).toMatchObject({ initialUpload: false, savedRevision: 1, appliedRevision: 1 });
  });

  it("uploads on a reconnect to the same account", async () => {
    const accountId = randomUUID();
    const { sync } = await device({ accountId, previousAccountId: accountId });
    expect(sync.view()).toMatchObject({ initialUpload: true, askUploadForNewAccount: false });
  });

  it("never uploads into a different account until asked, or until an edit", async () => {
    const { sync, own } = await device({ previousAccountId: "some-other-account" });
    expect(sync.view()).toMatchObject({ initialUpload: false, askUploadForNewAccount: true });
    const before = puts().length;
    await sync.reportUi({ theme: "paper", density: "compact" }, "initial");
    expect(puts().length).toBe(before);
    expect(own().values).toEqual({});
    await sync.upload({ theme: "paper", density: "compact" });
    expect(own().values).toEqual({ theme: "paper", density: "compact" });
    expect(sync.view().askUploadForNewAccount).toBe(false);
  });

  it("takes an edit in a different account as the person engaging: that edit is saved", async () => {
    const { sync, own } = await device({ previousAccountId: "some-other-account" });
    await sync.reportUi({ textSize: "larger" }, "user");
    expect(own().values).toEqual({ textSize: "larger" });
    expect(sync.view().askUploadForNewAccount).toBe(false);
  });
});

describe("shared settings", () => {
  it("cannot be joined before anybody has published them", async () => {
    const { sync } = await device();
    expect(await sync.setMode({ mode: "shared", join: "use-shared" })).toMatchObject({ error: "no_shared_profile" });
  });

  it("publish, join with use-shared, keep sound per device, and leave with a copy", async () => {
    const accountId = randomUUID();
    const a = await device({ accountId });
    await a.sync.reportUi({ theme: "paper", density: "compact", sound: true }, "initial");
    expect(await a.sync.setMode({ mode: "shared", join: "publish", previewRevision: 0 })).toEqual({ ok: true });
    const shared = api.sharedOf(accountId)!;
    expect(shared.values).toMatchObject({ theme: "paper", density: "compact" });
    expect(a.sync.view()).toMatchObject({ mode: "shared", savedRevision: shared.revision, appliedRevision: shared.revision });

    // A second deck previews, then joins.
    const b = await device({ accountId });
    const preview = await b.sync.preview();
    expect(preview.shared.revision).toBe(shared.revision);
    expect(await b.sync.setMode({ mode: "shared", join: "use-shared" })).toEqual({ ok: true });
    expect(b.sync.view().apply).toMatchObject({ revision: shared.revision, values: { theme: "paper", density: "compact" } });

    // Sound goes to the device's own profile, the rest to the shared one.
    await b.sync.applied(shared.revision);
    await b.sync.reportUi({ sound: false, textSize: "larger" }, "user");
    expect(api.sharedOf(accountId)!.values).toMatchObject({ textSize: "larger" });
    expect(api.sharedOf(accountId)!.values.sound).not.toBe(false);
    expect(b.own().values).toEqual({ sound: false });
    expect(b.sync.view().adopt.values).toMatchObject({ sound: false, textSize: "larger", theme: "paper" });

    // A publish against a preview gone stale is refused with the latest.
    expect(await a.sync.setMode({ mode: "shared", join: "publish", previewRevision: 0 })).toMatchObject({ error: "revision_conflict" });

    // Leaving copies what the deck shows into its own profile.
    expect(await b.sync.setMode({ mode: "independent" })).toEqual({ ok: true });
    expect(b.sync.view().mode).toBe("independent");
    expect(b.own().values).toMatchObject({ theme: "paper", density: "compact", textSize: "larger", sound: false });
  });

  it("pulls the console's change to the shared profile on the frame that says so", async () => {
    const accountId = randomUUID();
    const a = await device({ accountId });
    await a.sync.setMode({ mode: "shared", join: "publish", previewRevision: 0 });
    const edited = api.editShared(accountId, { theme: "nord" });
    await a.sync.onControl({ profileId: edited.id, revision: edited.revision });
    expect(a.sync.view().apply).toMatchObject({ revision: edited.revision, values: { theme: "nord" } });
  });
});

describe("a restart", () => {
  let dir = "";
  afterEach(() => { if (dir) rmTempDir(dir); dir = ""; });

  it("keeps a pending edit and a conflict in account.json", async () => {
    dir = tempDir("ccdeck-account-sync-restart-");
    const home = join(dir, "deck");
    const clock = fakeClock();
    const make = () => {
      const timers = manualTimers();
      return {
        timers,
        s: createAccountService({
          env: { CCDECK_ACCOUNT_API: api.url }, home, prefs: () => ({}),
          tokenStore: createTokenStore({ platform: "linux", env: {}, home, which: () => false }),
          facts: { version: "3.43.0", os: "linux", arch: "x64", channel: "npm" },
          now: clock.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: () => {},
        }),
      };
    };
    const first = make();
    await first.s.start();
    const v = await first.s.connect("laptop-a");
    api.approve(v.connect.userCode);
    await first.timers.fire({ until: () => first.s.sync() != null });
    await first.s.reportUi({ values: { theme: "paper" }, reason: "initial" });
    const profileId = first.s.view().sync.profileId;

    // Offline: an edit stays pending.
    api.override("PUT /v1/device/settings", () => ({ status: 503 }));
    await first.s.reportUi({ values: { density: "compact" }, reason: "user" });
    first.s.stop();
    await settle(50);
    const second = make();
    await second.s.start();
    expect(second.s.view().sync).toMatchObject({ pending: { keys: ["density"] }, savedRevision: 1 });

    // Back online with the account moved on: the save conflicts, and that too
    // survives a restart.
    api.override("PUT /v1/device/settings", null);
    changeElsewhere(profileId, { theme: "nord" });
    await second.s.sync().save();
    expect(second.s.view().sync.conflict).toMatchObject({ latest: { values: { theme: "nord" } }, mine: { density: "compact" } });
    second.s.stop();
    await settle(50);
    const third = make();
    await third.s.start();
    expect(third.s.view().sync).toMatchObject({ conflict: { mine: { density: "compact" } }, pending: { keys: ["density"] } });
    third.s.stop();
  });
});
