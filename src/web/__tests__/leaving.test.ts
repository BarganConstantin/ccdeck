// `ccdeck --uninstall` saying the install left, and the one question it asks
// (bin/cli/leaving.js, reporter.reportUninstall in reports.mjs).
import { PassThrough } from "node:stream";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain JS module, no types
import { REASONS, askWhy, sayGoodbye } from "../../../bin/cli/leaving.js";
// @ts-expect-error — plain JS module, no types
import { UNINSTALL_REASONS } from "../../server/reports.mjs";

/** A terminal: input the test types into, output it reads back. */
function terminal(tty = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty });
  const output = Object.assign(new PassThrough(), { isTTY: tty });
  let shown = "";
  output.on("data", c => { shown += String(c); });
  return { input, output, shown: () => shown, type: (text: string) => setTimeout(() => input.write(text), 20) };
}

describe("the question", () => {
  it("offers exactly the reasons the reports accept", () => {
    expect(REASONS.map(([token]: [string]) => token)).toEqual([...UNINSTALL_REASONS]);
  });

  it("answers with the reason picked by number", async () => {
    const t = terminal();
    t.type("2\n");
    expect(await askWhy({ input: t.input, output: t.output })).toBe("too-noisy");
    expect(t.shown()).toContain("you can skip it");
    expect(t.shown()).toContain("1  It wasn't useful to me");
  });

  it("is skipped with Enter, and anything off the list is no answer", async () => {
    for (const typed of ["\n", "9\n", "privacy\n", "-1\n"]) {
      const t = terminal();
      t.type(typed);
      expect(await askWhy({ input: t.input, output: t.output }), typed).toBeNull();
    }
  });

  it("gives up rather than hang an uninstall", async () => {
    const t = terminal();
    expect(await askWhy({ input: t.input, output: t.output, timeoutMs: 50 })).toBeNull();
  });

  it("is never asked without a terminal: a script running --uninstall waits on nothing", async () => {
    const t = terminal(false);
    expect(await askWhy({ input: t.input, output: t.output })).toBeNull();
    expect(t.shown()).toBe("");
  });
});

describe("the goodbye", () => {
  it("asks and sends only when a report would go out anyway", async () => {
    let asked = 0;
    const sent: unknown[] = [];
    const off = { willReport: async () => false, reportUninstall: async (r: unknown) => { sent.push(r); return true; } };
    expect(await sayGoodbye({ reporter: off, ask: async () => { asked++; return "broken"; }, out: () => {} })).toBe(false);
    expect(asked).toBe(0);
    expect(sent).toEqual([]);
  });

  it("sends the reason picked, and thanks only for one", async () => {
    const lines: string[] = [];
    const sent: unknown[] = [];
    const on = { willReport: async () => true, reportUninstall: async (r: unknown) => { sent.push(r); return true; } };
    await sayGoodbye({ reporter: on, ask: async () => "other-tool", out: (l: string) => lines.push(l) });
    await sayGoodbye({ reporter: on, ask: async () => null, out: (l: string) => lines.push(l) });
    expect(sent).toEqual(["other-tool", null]);
    expect(lines.length).toBe(1);
  });

  it("never throws, whatever the reporter does", async () => {
    const broken = { willReport: async () => { throw new Error("no"); }, reportUninstall: async () => true };
    expect(await sayGoodbye({ reporter: broken, ask: async () => null, out: () => {} })).toBe(false);
  });
});
