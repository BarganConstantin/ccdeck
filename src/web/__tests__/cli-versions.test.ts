// The background CLI-version probe (cli-versions.mjs): what it pulls out of a
// `--version` line, that it asks first whether the CLI is even here, and that a
// version leaves as a bare token and nothing else. Every dependency is injected,
// so nothing here spawns a real child.
import { describe, it, expect, vi } from "vitest";
import {
  detectCliVersions, parseVersion,
  // @ts-expect-error — plain JS module, no types
} from "../../server/cli-versions.mjs";

type RunResult = { ok: boolean; stdout?: string; stderr?: string };

/** A fake `run` that answers `--version` from a table of command → output. */
function runner(table: Record<string, string>) {
  const seen: string[] = [];
  const runImpl = async (cmd: string, args: string[]): Promise<RunResult> => {
    seen.push(cmd);
    if (args[0] !== "--version") return { ok: false };
    const out = table[cmd];
    return out === undefined ? { ok: false } : { ok: true, stdout: out };
  };
  return { runImpl, seen };
}

describe("pulling a version out of --version output", () => {
  it("keeps only the dotted number, and drops everything around it", () => {
    expect(parseVersion("1.2.3 (Claude Code)")).toBe("1.2.3");
    expect(parseVersion("claude-code/1.2.3")).toBe("1.2.3");
    expect(parseVersion("codex-cli 0.5.0-beta.1")).toBe("0.5.0-beta.1");
    expect(parseVersion("2.0.0+build.7")).toBe("2.0.0+build.7");
    // A line that mentions a path still yields only the number — no path leaves.
    expect(parseVersion("claude 1.4.0, installed at /home/alice/.npm/bin")).toBe("1.4.0");
  });

  it("is a token, never a space, and within the API's length cap", () => {
    const v = parseVersion("Tool 1.2.3 build 2026") ?? "";
    expect(v).toMatch(/^[0-9A-Za-z.+_-]+$/);
    expect(v.length).toBeLessThanOrEqual(32);
    // No number at all → nothing, so the caller omits the field.
    expect(parseVersion("no version here")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });
});

describe("detecting the installed CLIs", () => {
  it("does not probe an async absent or failed Codex presence check", async () => {
    const runImpl = vi.fn();
    for (const codexPresent of [async () => false, async () => { throw new Error('unavailable'); }]) {
      expect(await detectCliVersions({ runImpl, claudePresent: () => false, codexPresent })).toEqual({});
    }
    expect(runImpl).not.toHaveBeenCalled();
  });

  it("reports each version when its CLI is present and answers", async () => {
    const { runImpl } = runner({ claude: "1.9.0 (Claude Code)", codex: "codex-cli 0.7.2" });
    const out = await detectCliVersions({
      runImpl, claudeCandidates: () => ["claude"], claudePresent: () => true, codexPresent: () => true,
    });
    expect(out).toEqual({ claudeVersion: "1.9.0", codexVersion: "0.7.2" });
  });

  it("does not spawn anything for a CLI that is not on the machine", async () => {
    const { runImpl, seen } = runner({ claude: "1.9.0", codex: "0.7.2" });
    const out = await detectCliVersions({
      runImpl, claudeCandidates: () => ["claude"], claudePresent: () => false, codexPresent: () => true,
    });
    expect(out).toEqual({ codexVersion: "0.7.2" });
    expect(seen).not.toContain("claude");
  });

  it("tries the claude candidates in order and stops at the first that answers", async () => {
    const { runImpl, seen } = runner({ "/opt/claude": "3.1.4 (Claude Code)" });
    const out = await detectCliVersions({
      runImpl,
      claudeCandidates: () => ["claude", "claude.cmd", "/opt/claude"],
      claudePresent: () => true,
      codexPresent: () => false,
    });
    expect(out).toEqual({ claudeVersion: "3.1.4" });
    expect(seen).toEqual(["claude", "claude.cmd", "/opt/claude"]);
  });

  it("never throws, even when the runner does", async () => {
    const runImpl = async () => { throw new Error("spawn EACCES"); };
    const out = await detectCliVersions({
      runImpl, claudeCandidates: () => ["claude"], claudePresent: () => true, codexPresent: () => true,
    });
    expect(out).toEqual({});
  });
});
