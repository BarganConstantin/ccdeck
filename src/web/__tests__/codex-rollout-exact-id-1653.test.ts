// #1653: a Codex session's rollout is the file whose name carries its id — the
// whole id, not any file whose name happens to contain it.
//
// findCodexRolloutPath took the first file in a day directory whose name
// included the session id anywhere. Codex names a rollout
// `rollout-<YYYY-MM-DDTHH-MM-SS>-<uuid>.jsonl`, so an id shorter than a whole
// one — a prefix of another session's id, its last group, a piece of the
// timestamp — found that other session's rollout, and the lookup kept the
// answer: the card for the short id was filled in with another session's
// usage, model and context window from then on.
//
// FIXTURES ONLY. CODEX_HOME is a temp directory set before the module that
// resolves it is imported, and the file refuses to run if it resolved a tree
// outside it.
import { describe, it, expect, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-codex-1653-"));
const CODEX_HOME = join(DIR, "codex-home");
const prev = process.env.CODEX_HOME;
process.env.CODEX_HOME = CODEX_HOME;

// @ts-expect-error — .mjs server module, no types
const { CODEX_SESSIONS_DIR, rolloutNameId, sidFromRolloutName } = await import("../../server/codex-dir.mjs");
// @ts-expect-error — .mjs server module, no types
const { findCodexRolloutPath } = await import("../../server/codex-enrichment.mjs");

if (!String(CODEX_SESSIONS_DIR).startsWith(DIR)) {
  throw new Error(`refusing to run: resolved ${CODEX_SESSIONS_DIR}, outside ${DIR}`);
}

afterAll(() => {
  if (prev === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prev;
  rmTempDir(DIR);
});

const SID_NEW = "019ed4f2-c821-7a31-9f00-0123456789ab";
const SID_OLD = "0a1b2c3d-0000-4000-8000-000000000000";

function put(day: string, stamp: string, sid: string): string {
  const dir = join(CODEX_SESSIONS_DIR, "2026", "09", day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-${day}T${stamp}-${sid}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: sid, cwd: "/srv/proj" } }) + "\n");
  return path;
}
const NEW = put("15", "10-00-00", SID_NEW);
const OLD = put("14", "09-00-00", SID_OLD);

describe("the rollout a session id finds", () => {
  it("is the one whose name carries that whole id, in any day directory", async () => {
    // The control: if these are not found, the cases below mean nothing.
    expect(await findCodexRolloutPath(SID_NEW)).toBe(NEW);
    expect(await findCodexRolloutPath(SID_OLD)).toBe(OLD);
  });

  it("is none for an id that is only a prefix of another session's", async () => {
    expect(await findCodexRolloutPath("019ed4f2")).toBeNull();
    expect(await findCodexRolloutPath(SID_NEW.slice(0, -1))).toBeNull();
  });

  it("is none for an id that is only some other part of another rollout's name", async () => {
    expect(await findCodexRolloutPath("0123456789ab")).toBeNull();          // the id's last group
    expect(await findCodexRolloutPath("c821-7a31")).toBeNull();             // from its middle
    expect(await findCodexRolloutPath("2026-09-15T10-00-00")).toBeNull();   // the timestamp
    expect(await findCodexRolloutPath("rollout")).toBeNull();
  });
});

describe("rolloutNameId", () => {
  it("is the whole id after the timestamp, and agrees with the watcher's reading of a name Codex writes", () => {
    const name = `rollout-2026-09-15T10-00-00-${SID_NEW}.jsonl`;
    expect(rolloutNameId(name)).toBe(SID_NEW);
    expect(rolloutNameId(name)).toBe(sidFromRolloutName(name));
  });

  it("asks nothing of the id's shape, as the lookup never has", () => {
    expect(rolloutNameId("rollout-2026-09-15T10-00-00-eeeeeeee-0000-4000-8000-00000000late.jsonl"))
      .toBe("eeeeeeee-0000-4000-8000-00000000late");
  });

  it("is null for a name not built the way Codex builds one", () => {
    expect(rolloutNameId(`${SID_NEW}.jsonl`)).toBeNull();
    expect(rolloutNameId(`rollout-2026-09-15T10-00-00-${SID_NEW}.jsonl.zst`)).toBeNull();
    expect(rolloutNameId("rollout-2026-09-15T10-00-00-.jsonl")).toBeNull();
    expect(rolloutNameId(undefined)).toBeNull();
  });
});
