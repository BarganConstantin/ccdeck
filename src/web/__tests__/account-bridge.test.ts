// The tab's half of the settings sync (account-bridge.ts): what a tab applies
// from the account, what it reports, and what it knows to be its own echo.
// No DOM: the bridge is handed a store, the setters and a post, as the hook
// hands it the real ones.
import { describe, expect, it } from "vitest";
import { createAccountBridge, type AccountView, type SyncView } from "../account-bridge";
import { UI_FIELDS, encodeStored, fieldFor } from "../account-ui-fields";
import { manualTimers } from "./account-test-kit";

function tab(stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  const posts: { path: string; body: any }[] = [];
  const applied: [string, unknown][] = [];
  const timers = manualTimers();
  /** What a setter does: write its key, the way each setting's own effect does. */
  const write = (key: string, value: any) => {
    const f = fieldFor(key)!;
    store.set(f.storage, encodeStored(f, value));
    bridge.onStored(f.storage, store.get(f.storage)!);
  };
  const appliers = Object.fromEntries(UI_FIELDS.map(f => [f.key, (v: any) => { applied.push([f.key, v]); write(f.key, v); }]));
  const bridge = createAccountBridge({
    post: async (path, body) => { posts.push({ path, body }); return {}; },
    read: k => store.get(k) ?? null,
    appliers: () => appliers,
    themes: () => ["rider-black", "light", "dark"],
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { bridge, posts, applied, store, timers, write };
}

function view(sync: Partial<SyncView>, state: AccountView["state"] = "connected"): AccountView {
  return {
    enabled: true, vetoed: false, state, connect: null, account: { email: "me@example.com" },
    device: { id: "d", name: "laptop", consoleUrl: null }, suggestedName: "laptop", tokenStorage: "file", status: null,
    revokedReason: null, problem: null,
    sync: {
      mode: "independent", overrides: ["sound"], profileId: "p", savedRevision: 0, appliedRevision: 0,
      adopt: { revision: 0, values: {} }, pending: null, conflict: null, apply: null, askUploadForNewAccount: false,
      initialUpload: false, saving: "idle", skipped: null, ...sync,
    },
  };
}

describe("the first view of a connected account", () => {
  it("uploads every setting the tab shows when the deck has just connected", () => {
    const { bridge, posts } = tab({ "agent-dag.theme": "light", "agent-dag.sound": "off" });
    bridge.onView(view({ initialUpload: true }));
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/api/account/ui");
    expect(posts[0].body.reason).toBe("initial");
    expect(posts[0].body.values).toMatchObject({ theme: "light", sound: false, textSize: "default", "panels.accounts": true });
    expect(Object.keys(posts[0].body.values)).toHaveLength(UI_FIELDS.length);
  });

  it("adopts the account's values instead, on any other first view — a second browser profile overwrites nothing", () => {
    const { bridge, posts, applied } = tab({ "agent-dag.theme": "dark", "agent-dag.density": "default" });
    bridge.onView(view({ savedRevision: 4, adopt: { revision: 4, values: { theme: "light", density: "compact" } } }));
    expect(applied).toEqual([["theme", "light"], ["density", "compact"]]);
    expect(posts).toEqual([{ path: "/api/account/ui/applied", body: { revision: 4 } }]);
  });

  it("applies what is waiting to be applied, ahead of the resolved values", () => {
    const { bridge, posts, applied } = tab();
    bridge.onView(view({ savedRevision: 7, apply: { revision: 7, values: { textSize: "larger" } }, adopt: { revision: 7, values: { textSize: "larger", theme: "light" } } }));
    expect(applied).toEqual([["textSize", "larger"]]);
    expect(posts.at(-1)).toEqual({ path: "/api/account/ui/applied", body: { revision: 7 } });
  });

  it("does not apply a theme this version has no palette for, and still acknowledges the revision", () => {
    const { bridge, posts, applied, store } = tab({ "agent-dag.theme": "dark" });
    bridge.onView(view({ savedRevision: 3, adopt: { revision: 3, values: { theme: "some-future-theme", density: "compact" } } }));
    expect(applied).toEqual([["density", "compact"]]);
    expect(store.get("agent-dag.theme")).toBe("dark");
    expect(posts.at(-1)).toEqual({ path: "/api/account/ui/applied", body: { revision: 3, skipped: { theme: "some-future-theme" } } });
  });
});

describe("after it", () => {
  it("reports a person's change, gathered for two seconds", async () => {
    const { bridge, posts, write, timers } = tab();
    bridge.onView(view({}));
    posts.length = 0;
    write("density", "compact");
    write("textSize", "larger");
    expect(posts, "nothing until the pause").toEqual([]);
    expect(timers.last()).toBe(2_000);
    await timers.fire();
    expect(posts).toEqual([{ path: "/api/account/ui", body: { values: { density: "compact", textSize: "larger" }, reason: "user" } }]);
  });

  it("ignores the writes its own applying causes", async () => {
    const { bridge, posts, timers } = tab({ "agent-dag.theme": "dark" });
    bridge.onView(view({ apply: { revision: 2, values: { theme: "light" } }, savedRevision: 2 }));
    await timers.fire();
    expect(posts.filter(p => p.path === "/api/account/ui")).toEqual([]);
  });

  it("applies each new revision once, however many times it is told", () => {
    const { bridge, applied } = tab();
    bridge.onView(view({}));
    const next = view({ savedRevision: 5, apply: { revision: 5, values: { "panels.detail": true } } });
    bridge.onView(next);
    bridge.onView(next);
    expect(applied).toEqual([["panels.detail", true]]);
  });

  it("reports nothing before its first sync, nor while the deck is not connected", async () => {
    const { bridge, posts, write, timers } = tab();
    write("theme", "light");
    bridge.onView(view({}, "disconnected"));
    write("theme", "dark");
    await timers.fire();
    expect(posts).toEqual([]);
  });

  it("starts again after a disconnect: the next connection is a first view again", () => {
    const { bridge, posts } = tab();
    bridge.onView(view({}));
    bridge.onView(view({}, "revoked"));
    bridge.onView(view({ initialUpload: true }));
    expect(posts.at(-1)!.body.reason).toBe("initial");
  });
});
