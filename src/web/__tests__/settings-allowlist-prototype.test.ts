// An allowlist that answers for keys nobody put in it.
//
// `setCswapConfig` gated on `const spec = SETTINGS[key]`, which is a property
// READ and therefore walks the prototype chain: `SETTINGS["constructor"]` is
// `Object`, truthy, with `spec.type === undefined`. So a prototype member
// passed the gate, skipped both type-specific checks, and reached
// `cswap config set <key> <value>`.
//
// Nothing reachable that way was dangerous — every such name is a bare word
// with no leading dash and no metacharacter, and cswap rejects it. What is
// wrong is that the list did not hold, which is the property the route is
// relying on.
import { describe, it, expect, vi } from "vitest";

const runs: Array<{ file: string; args: string[] }> = [];
vi.mock("../../server/exec.mjs", async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return {
    ...real,
    run: async (file: string, args: string[]) => { runs.push({ file, args }); return { ok: true, stdout: "", stderr: "" }; },
  };
});

// @ts-expect-error — .mjs server module, no types
const { setCswapConfig } = await import("../../server/cswap-auto.mjs");

describe("the settings allowlist", () => {
  it("refuses every name that is only on Object's prototype", async () => {
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "isPrototypeOf"]) {
      runs.length = 0;
      const r = await setCswapConfig(key, "anything");
      expect(r, key).toEqual({ ok: false, reason: "unknown_setting" });
      // And nothing was spawned on the way to that answer.
      expect(runs, key).toEqual([]);
    }
  });

  it("still refuses an ordinary unknown key", async () => {
    const r = await setCswapConfig("autoswitch.doesNotExist", "1");
    expect(r).toEqual({ ok: false, reason: "unknown_setting" });
  });
});
