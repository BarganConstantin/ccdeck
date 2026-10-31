// What the account suites share: a timer that runs only when told, an
// enrolled device on the fake API, and a temp folder.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeApi } from "./account-fake-api";

/** setTimer/clearTimer that schedule nothing: each call is recorded, and a
 *  suite runs the one it wants with `fire`. */
export function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const delays: number[] = [];
  let id = 0;
  return {
    setTimer: (fn: () => void, ms: number) => { id += 1; pending.set(id, { fn, ms }); delays.push(ms); return id; },
    clearTimer: (t: unknown) => { pending.delete(t as number); },
    /** Every delay ever asked for, oldest first. */
    delays,
    /** The newest delay asked for. */
    last: () => delays[delays.length - 1],
    pendingCount: () => pending.size,
    /** Run every timer pending now (not the ones they set), then wait for
     *  what they started — never a fixed pause, which a loaded machine
     *  outlasts: until the next timer is set (`next`), or `until` holds, or
     *  just a few turns when neither is asked for. */
    async fire({ next = false, until: done }: { next?: boolean; until?: () => boolean } = {}) {
      const before = delays.length;
      const due = [...pending.entries()];
      pending.clear();
      for (const [, t] of due) t.fn();
      if (next || done) {
        const end = Date.now() + 10_000;
        while (Date.now() < end && !((next && delays.length > before) || (done && done()))) {
          await new Promise(r => setTimeout(r, 5));
        }
        if (Date.now() >= end) throw new Error(next ? "no next timer was set" : "the condition never held");
      }
      await settle(10);
    },
  };
}

/** A few turns of the event loop: long enough for a request to the fake API
 *  on loopback and the work after it. */
export async function settle(ms = 40) {
  await new Promise(r => setTimeout(r, ms));
}

/** Wait until `test()` holds, polling, or fail after `ms`. */
export async function until(test: () => boolean | Promise<boolean>, ms = 5_000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A clock a suite moves by hand. */
export function fakeClock(start = Date.parse("2026-10-18T09:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; } };
}

export function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Enroll a device on the fake API the way a deck does, over plain HTTP, and
 *  hand back the token answer. */
export async function enroll(api: FakeApi, { accountId, email, name = "laptop-a" }: { accountId?: string; email?: string; name?: string } = {}) {
  const post = async (path: string, body: unknown) => {
    const r = await fetch(api.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const a = await post("/v1/device/authorize", { name, os: "linux", arch: "x64", version: "3.43.0", channel: "npm" });
  api.approve(a.body.userCode, accountId, email);
  const t = await post("/v1/device/token", { deviceCode: a.body.deviceCode });
  if (t.status !== 200) throw new Error(`enroll: ${t.status} ${JSON.stringify(t.body)}`);
  return t.body as { accessToken: string; deviceId: string; account: { id: string; email: string }; settings: { mode: string; profileId: string; revision: number } };
}
