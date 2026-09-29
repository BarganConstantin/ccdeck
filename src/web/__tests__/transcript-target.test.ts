// "Which session, and which transcript?" — the question the model, usage,
// naming and context passes in session-enrichment.mjs each asked of a hook
// payload before scheduling a read, in the same four lines at the top of all
// four. It is transcriptTarget now, held here once, and the passes are held to
// asking it rather than spelling it out a fifth time.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// @ts-expect-error — plain .mjs server module, no types
const { transcriptTarget } = await import("../../server/session-enrichment.mjs");

const SOURCE = readFileSync(new URL("../../server/session-enrichment.mjs", import.meta.url), "utf8");

describe("transcriptTarget", () => {
  it("names the session and the transcript a hook payload carries", () => {
    expect(transcriptTarget({ session_id: "s1", transcript_path: "/p/s1.jsonl" }))
      .toEqual({ sid: "s1", tp: "/p/s1.jsonl" });
  });

  it("carries nothing else, whatever else the payload holds", () => {
    const target = transcriptTarget({
      session_id: "s1", transcript_path: "/p/s1.jsonl", cwd: "/repo", hook_event_name: "PostToolUse",
    });
    expect(Object.keys(target)).toEqual(["sid", "tp"]);
  });

  it("is null for a payload that is not an object", () => {
    for (const payload of [undefined, null, 0, 1, "", "s1", true]) {
      expect(transcriptTarget(payload), String(payload)).toBeNull();
    }
  });

  it("is null when either half is missing or empty", () => {
    // A Codex event carries a session id and no transcript_path, a field only
    // Claude Code sends (see maybeResolveCodexMemory for where Codex goes).
    for (const payload of [
      {},
      { session_id: "s1" },
      { transcript_path: "/p/s1.jsonl" },
      { session_id: "", transcript_path: "/p/s1.jsonl" },
      { session_id: "s1", transcript_path: "" },
      { session_id: null, transcript_path: "/p/s1.jsonl" },
      { session_id: "s1", transcript_path: null },
    ]) {
      expect(transcriptTarget(payload), JSON.stringify(payload)).toBeNull();
    }
  });

  it("takes the values as the payload spelled them", () => {
    // The passes key their gates by the session id as it arrived, so a numeric
    // id stays a number rather than being made into a string here.
    expect(transcriptTarget({ session_id: 7, transcript_path: "/p/7.jsonl" }))
      .toEqual({ sid: 7, tp: "/p/7.jsonl" });
  });
});

describe("the passes that read a session's transcript", () => {
  it("all ask transcriptTarget", () => {
    for (const pass of ["maybeResolveModel", "maybeResolveUsage", "maybeResolveSessionName", "maybeResolveContext"]) {
      const at = SOURCE.indexOf(`function ${pass}(payload) {`);
      expect(at, `${pass} is gone or renamed`).toBeGreaterThan(-1);
      const head = SOURCE.slice(at, SOURCE.indexOf("\n}\n", at));
      expect(head, pass).toMatch(/^function \w+\(payload\) \{\n {2}const target = transcriptTarget\(payload\);\n {2}if \(!target\) return;\n/);
    }
  });

  it("and none spells the rule out again", () => {
    expect(SOURCE.match(/= payload\.transcript_path;/g), "a pass reads transcript_path itself again").toHaveLength(1);
    expect(SOURCE, "a pass repeats the object check").not.toMatch(/if \(!payload \|\| typeof payload !== "object"\) return;/);
  });
});
