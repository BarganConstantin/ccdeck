// The Windows reader the engine's trust gate asks (windows-acl.mjs), against a
// stand-in for the tool calls, then the real trust gate over that reader. The
// real machine is windows-acl-real.test.ts; nothing here starts a tool.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain server module
import { createWindowsAcl, boundedRun, ACL_MAX_BYTES, ACL_TIMEOUT_MS, INSPECT_SCRIPT } from "../../server/windows-acl.mjs";
// @ts-expect-error plain server module
import { trustGate } from "../../server/pro-engine-install.mjs";
// @ts-expect-error plain server module
import * as pkg from "../../server/engine-package.mjs";
// @ts-expect-error plain server module
import { commandPanelEngine } from "../../server/command-panel-engine.mjs";

const ME = "S-1-5-21-111-222-333-1001";
const ENV = { SystemRoot: "C:\\Windows" };
const USER_CSV = `"DESKTOP\\someone","${ME}"\r\n`;
const groups = (label: string) =>
  `"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"\r\n${label}\r\n"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group"\r\n`;
const MEDIUM = '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192","Mandatory group, Enabled by default, Enabled group"';
const HIGH = '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288","Mandatory group, Enabled by default, Enabled group"';
const SYSTEM = '"Mandatory Label\\System Mandatory Level","Label","S-1-16-16384","Mandatory group"';
const LOW = '"Mandatory Label\\Low Mandatory Level","Label","S-1-16-4096","Mandatory group"';

type Call = { file: string; args: string[]; env: Record<string, string>; timeoutMs: number; maxBytes: number };
/** The script a PowerShell call carries, decoded from -EncodedCommand. */
const script = (args: string[]) => Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
type Answer = { code: number; stdout: string };
/** A `run` that answers by tool and records every call. */
function fake(answers: { user?: Answer | Error; groups?: Answer | Error; ps?: Answer | Error }) {
  const calls: Call[] = [];
  const run = async (file: string, args: string[], options: { env: Record<string, string>; timeoutMs: number; maxBytes: number }) => {
    calls.push({ file, args, ...options });
    const key = file.endsWith("whoami.exe") ? (args.includes("/user") ? "user" : "groups") : "ps";
    const answer = answers[key];
    if (answer instanceof Error) throw answer;
    if (!answer) throw new Error("not expected");
    return answer;
  };
  return { run, calls };
}
const ok = (stdout: string): Answer => ({ code: 0, stdout });
const info = (over: Record<string, unknown> = {}) => ok(JSON.stringify({ owner: ME, writers: [ME], reparsePoint: false, ...over }));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
const file = async () => {
  const dir = await mkdtemp(join(tmpdir(), "ccdeck-windows-acl-")); roots.push(dir);
  const path = join(dir, "a"); await writeFile(path, "x");
  return path;
};

describe("identity", () => {
  it.each([[MEDIUM, false], [LOW, false], [HIGH, true], [SYSTEM, true]])("reads the user SID and elevation from %s", async (label, elevated) => {
    const { run, calls } = fake({ user: ok(USER_CSV), groups: ok(groups(label)) });
    expect(await createWindowsAcl({ run, env: ENV }).identity()).toEqual({ user: ME, elevated });
    expect(calls.map((c) => c.file)).toEqual(["C:\\Windows\\System32\\whoami.exe", "C:\\Windows\\System32\\whoami.exe"]);
    expect(calls[0].args).toEqual(["/user", "/fo", "csv", "/nh"]);
    expect(calls[1].args).toEqual(["/groups", "/fo", "csv", "/nh"]);
    expect(calls[0].timeoutMs).toBe(ACL_TIMEOUT_MS);
    expect(calls[0].maxBytes).toBe(ACL_MAX_BYTES);
  });

  it("fails when no mandatory label is listed", async () => {
    const { run } = fake({ user: ok(USER_CSV), groups: ok('"Everyone","Well-known group","S-1-1-0","Mandatory group"\r\n') });
    await expect(createWindowsAcl({ run, env: ENV }).identity()).rejects.toThrow();
  });

  it.each([["no output", ""], ["a name, not a SID", '"DESKTOP\\someone","someone"'], ["one field", '"S-1-5-21-1"'], ["a SID of the wrong shape", '"x","S-2-5-1"']])("fails on a user line with %s", async (_n, csv) => {
    const { run } = fake({ user: ok(csv), groups: ok(groups(MEDIUM)) });
    await expect(createWindowsAcl({ run, env: ENV }).identity()).rejects.toThrow();
  });

  it("fails when whoami exits non-zero", async () => {
    const { run } = fake({ user: { code: 1, stdout: USER_CSV }, groups: ok(groups(MEDIUM)) });
    await expect(createWindowsAcl({ run, env: ENV }).identity()).rejects.toThrow();
  });
});

describe("inspect", () => {
  it("reads owner, writers and reparse point from one PowerShell call, with links from lstat", async () => {
    const path = await file();
    const { run, calls } = fake({ ps: info({ writers: [ME, "S-1-5-18"] }) });
    const result = await createWindowsAcl({ run, env: ENV }).inspect(path);
    expect(result).toEqual({ owner: ME, writers: [ME, "S-1-5-18"], reparsePoint: false, links: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0].args.slice(0, 7)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-InputFormat", "None", "-EncodedCommand"]);
    expect(script(calls[0].args)).toBe(INSPECT_SCRIPT);
  });

  it("passes the path in the environment and never in the script text", async () => {
    const path = await file();
    const { run, calls } = fake({ ps: info() });
    await createWindowsAcl({ run, env: ENV }).inspect(path);
    expect(calls[0].env.CCDECK_ACL_PATH).toBe(path);
    expect(calls[0].args.join(" ")).not.toContain(path);
    expect(calls[0].env.SystemRoot).toBe("C:\\Windows");
  });

  it("asks for write-class rights, generic ones included, and skips inherit-only and deny rules", async () => {
    const { run, calls } = fake({ ps: info() });
    await createWindowsAcl({ run, env: ENV }).inspect(await file());
    const text = script(calls[0].args);
    const mask = Number(/FileSystemRights -band (\d+)\)/.exec(text)?.[1]);
    for (const bit of [0x2, 0x4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000]) expect(mask & bit).toBe(bit);
    for (const bit of [0x1, 0x8, 0x20, 0x80, 0x20000, 0x100000, 0x20000000]) expect(mask & bit).toBe(0);
    expect(text).toContain("GetAccessRules($true, $true, $sid)");
    expect(text).toContain("PropagationFlags -band 2");
    expect(text).toContain("AccessControlType]::Allow");
    expect(text).toContain("GetOwner($sid)");
    expect(text).toContain("[System.IO.File]::GetAttributes($p)");
  });

  it("uses no cmdlet, so PowerShell never searches its modules for one", async () => {
    const { run, calls } = fake({ ps: info() });
    await createWindowsAcl({ run, env: ENV }).inspect(await file());
    expect(script(calls[0].args)).not.toMatch(/\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
  });

  it("closes the tool's input, which Windows PowerShell otherwise waits on", async () => {
    // A child that echoes its input back exits only when its stdin ends.
    const answer = await boundedRun(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { env: process.env, timeoutMs: 5_000, maxBytes: 1024 });
    expect(answer).toEqual({ code: 0, stdout: "" });
  });

  it.each([
    ["a non-zero exit", { code: 1, stdout: "" }],
    ["output over the bound", ok(" ".repeat(ACL_MAX_BYTES + 1))],
    ["output that is not JSON", ok("owner: me")],
    ["JSON that is not an object", ok("[1]")],
    ["a name for an owner", info({ owner: "DESKTOP\\someone" })],
    ["a missing owner", info({ owner: undefined })],
    ["writers that are not an array", info({ writers: ME })],
    ["a writer that is a name", info({ writers: ["Everyone"] })],
    ["a writer that is not a string", info({ writers: [7] })],
    ["a reparse flag that is not a boolean", info({ reparsePoint: "false" })],
    ["a missing reparse flag", info({ reparsePoint: undefined })],
  ])("fails on %s", async (_n, answer) => {
    const { run } = fake({ ps: answer as Answer });
    await expect(createWindowsAcl({ run, env: ENV }).inspect(await file())).rejects.toThrow();
  });

  it("fails when the tool cannot run (timeout, spawn failure)", async () => {
    const { run } = fake({ ps: new Error("timed out C:\\secret\\path") });
    const error = await createWindowsAcl({ run, env: ENV }).inspect(await file()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret");
  });

  it("fails when the item cannot be stat'ed or the path is not usable", async () => {
    const { run } = fake({ ps: info() });
    const acl = createWindowsAcl({ run, env: ENV });
    await expect(acl.inspect(join(tmpdir(), "ccdeck-windows-acl-missing-item"))).rejects.toThrow();
    await expect(acl.inspect("")).rejects.toThrow();
    await expect(acl.inspect("a\0b")).rejects.toThrow();
  });

  it("names neither a path nor a SID in its errors", async () => {
    const path = await file();
    const { run } = fake({ ps: info({ owner: "S-1-5-99-bad name" }) });
    const error = (await createWindowsAcl({ run, env: ENV }).inspect(path).catch((e: Error) => e)) as Error;
    expect(error.message).not.toContain(path);
    expect(error.message).not.toMatch(/S-1-/);
  });
});

describe("the system folder", () => {
  it.each([["missing", {}], ["relative", { SystemRoot: "Windows" }], ["rooted without a drive", { SystemRoot: "\\Windows" }], ["a UNC path", { SystemRoot: "\\\\host\\share" }], ["empty", { SystemRoot: "" }]])("is refused when %s", async (_n, env) => {
    const { run, calls } = fake({ user: ok(USER_CSV), groups: ok(groups(MEDIUM)), ps: info() });
    const acl = createWindowsAcl({ run, env: env as Record<string, string> });
    await expect(acl.identity()).rejects.toThrow();
    await expect(acl.inspect(await file())).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe("wiring", () => {
  it("builds the reader itself when the gate is given none, and refuses where it cannot run", async () => {
    const saved = process.env.SystemRoot;
    delete process.env.SystemRoot;
    try {
      await expect(trustGate({ platform: "win32" })).rejects.toThrow();
    } finally {
      if (saved !== undefined) process.env.SystemRoot = saved;
    }
  });

  it("never reaches the reader while Windows is switched off", async () => {
    const importPackage = vi.fn();
    const engine = commandPanelEngine({ platform: "win32", env: { CCDECK_HOME: "/x" }, keys: ["key"], importPackage });
    expect((await engine.route("status", null)).body.code).toBe("unsupported");
    expect(importPackage).not.toHaveBeenCalled();
    expect(pkg.ENGINE_ON_WINDOWS).toBe(false);
  });
});

describe("the trust gate over the reader", () => {
  const gateFor = async (ps: Answer, label = MEDIUM) => {
    const { run } = fake({ user: ok(USER_CSV), groups: ok(groups(label)), ps });
    return trustGate({ platform: "win32", windowsAcl: createWindowsAcl({ run, env: ENV }) });
  };

  it("passes a folder only its owner may write", async () => {
    const gate = await gateFor(info());
    const path = await file();
    await expect(gate.directory(path, { nlink: 1 })).resolves.toBeUndefined();
    await expect(gate.file(path, { nlink: 1 })).resolves.toBeUndefined();
  });

  it.each([["Users", "S-1-5-32-545"], ["Everyone", "S-1-1-0"], ["Authenticated Users", "S-1-5-11"]])("refuses a folder %s may write", async (_n, sid) => {
    const gate = await gateFor(info({ writers: [ME, sid] }));
    await expect(gate.directory(await file(), { nlink: 1 })).rejects.toThrow();
  });

  it("refuses a reparse point", async () => {
    const gate = await gateFor(info({ reparsePoint: true }));
    await expect(gate.directory(await file(), { nlink: 1 })).rejects.toThrow();
  });

  it("refuses an item owned by someone else", async () => {
    const gate = await gateFor(info({ owner: "S-1-5-32-544" }));
    await expect(gate.directory(await file(), { nlink: 1 })).rejects.toThrow();
  });

  it("refuses an elevated process", async () => {
    await expect(gateFor(info(), HIGH)).rejects.toThrow();
    await expect(gateFor(info(), SYSTEM)).rejects.toThrow();
  });

  it("refuses when the reader fails", async () => {
    const gate = await gateFor({ code: 1, stdout: "" });
    await expect(gate.directory(await file(), { nlink: 1 })).rejects.toThrow();
  });
});
