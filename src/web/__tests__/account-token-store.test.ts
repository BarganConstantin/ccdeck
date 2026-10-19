// Where the device token is kept, on each platform, with the secret store's
// command mocked: macOS's `security -i`, Windows' PowerShell with DPAPI, Linux's
// secret-tool, and the 0600 file everywhere else.
//
// The property every case checks first: THE TOKEN IS NEVER IN ARGV. Every
// process on the machine can read every other's command line, so the secret
// goes to each tool on stdin, and the mock records both.
import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { statSync } from "node:fs";
import { rmTempDir } from "./rm-temp-dir";
import { tempDir } from "./account-test-kit";
// @ts-expect-error — plain .mjs server module, no types
import { createTokenStore, encodePowerShell, tokenAccountName, TOKEN_SERVICE } from "../../server/account-token-store.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { loadAccount, saveAccount } from "../../server/account-store.mjs";

const TOKEN = "ccdd_9QmN2fX0aLr7tYc3Kp8VbWzE1uHs6jDg4oRiTe5yAqM";
const HOME = "/home/u/.local/share/ccdeck";

interface Call { cmd: string; args: string[]; input: string }

/** A runner that records every call and answers with `answer(call)`. */
function runner(answer: (c: Call) => { code: number; stdout?: string; stderr?: string }) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], { input = "" }: { input?: string } = {}) => {
    const c = { cmd, args, input };
    calls.push(c);
    const a = answer(c);
    return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}

const neverInArgv = (calls: Call[]) => {
  for (const c of calls) {
    expect(c.args.join(" "), `${c.cmd} argv`).not.toContain(TOKEN);
    // Nor any piece of it long enough to matter.
    expect(c.args.join(" ")).not.toContain(TOKEN.slice(5, 25));
  }
};

describe("macOS: the login Keychain through security -i", () => {
  it("adds and reads the token with the commands on stdin", async () => {
    const keychain = new Map<string, string>();
    const { run, calls } = runner(c => {
      const add = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec(c.input);
      if (add) { keychain.set(`${add[1]}/${add[2]}`, add[3]); return { code: 0 }; }
      const find = /^find-generic-password -s (\S+) -a (\S+) -w\n$/.exec(c.input);
      if (find) {
        const v = keychain.get(`${find[1]}/${find[2]}`);
        return v ? { code: 0, stdout: `${v}\n` } : { code: 0, stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n" };
      }
      return { code: 0 };
    });
    const store = createTokenStore({ platform: "darwin", env: {}, home: HOME, run });
    expect(store.backend()).toBe("keychain");
    const kept = await store.save(TOKEN);
    expect(kept).toEqual({ tokenStorage: "keychain" });
    expect(await store.load(kept)).toEqual({ ok: true, token: TOKEN });
    expect(calls.every(c => c.cmd === "/usr/bin/security" && c.args.join(" ") === "-i")).toBe(true);
    expect(calls[0].input).toContain(`-s ${TOKEN_SERVICE} -a ${tokenAccountName(HOME)}`);
    neverInArgv(calls);
  });

  it("keeps the token where it is when the keychain is locked, and says locked", async () => {
    const { run } = runner(() => ({ code: 0, stderr: "security: SecKeychainSearchCopyNext: User interaction is not allowed.\n" }));
    const store = createTokenStore({ platform: "darwin", env: {}, home: HOME, run });
    expect(await store.load({ tokenStorage: "keychain" })).toEqual({ ok: false, reason: "locked" });
  });

  it("tells a missing item from a locked keychain", async () => {
    const { run } = runner(() => ({ code: 0, stderr: "security: The specified item could not be found in the keychain.\n" }));
    const store = createTokenStore({ platform: "darwin", env: {}, home: HOME, run });
    expect(await store.load({ tokenStorage: "keychain" })).toEqual({ ok: false, reason: "missing" });
  });

  it("falls back to the file when the keychain will not take it", async () => {
    const { run } = runner(() => ({ code: 0, stderr: "security: SecKeychainItemCreateFromContent: User interaction is not allowed.\n" }));
    const store = createTokenStore({ platform: "darwin", env: {}, home: HOME, run });
    expect(await store.save(TOKEN)).toEqual({ tokenStorage: "file", token: TOKEN });
  });
});

describe("Windows: DPAPI through PowerShell", () => {
  /** A stand-in for ProtectedData: reversible, and nothing like the token. */
  const protect = (s: string) => Buffer.from([...s].reverse().join("") + "|dpapi").toString("base64");
  const unprotect = (b: string) => {
    const raw = Buffer.from(b, "base64").toString();
    return raw.endsWith("|dpapi") ? [...raw.slice(0, -"|dpapi".length)].reverse().join("") : null;
  };

  it("round-trips the ciphertext, the token on stdin and the script encoded", async () => {
    const { run, calls } = runner(c => {
      const script = Buffer.from(c.args[c.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
      if (script.includes("::Protect(")) return { code: 0, stdout: protect(c.input.trim()) };
      if (script.includes("::Unprotect(")) {
        const t = unprotect(c.input.trim());
        return t ? { code: 0, stdout: t } : { code: 1, stderr: "bad data" };
      }
      return { code: 1 };
    });
    const store = createTokenStore({ platform: "win32", env: {}, home: "C:\\Users\\u\\AppData\\Local\\ccdeck", run });
    expect(store.backend()).toBe("dpapi");
    const kept = await store.save(TOKEN);
    expect(kept.tokenStorage).toBe("dpapi");
    expect(kept.tokenCipher).not.toContain(TOKEN);
    expect(kept).not.toHaveProperty("token");
    expect(await store.load(kept)).toEqual({ ok: true, token: TOKEN });
    expect(calls.every(c => c.cmd === "powershell.exe" && c.args.slice(0, 3).join(" ") === "-NoProfile -NonInteractive -EncodedCommand")).toBe(true);
    expect(calls[0].input).toBe(TOKEN);
    neverInArgv(calls);
    // And the cipher, not the token, is what account.json would hold.
    const dir = tempDir("ccdeck-token-dpapi-");
    try {
      await saveAccount({ deviceId: "d", ...kept }, dir);
      expect(JSON.stringify(await loadAccount(dir))).not.toContain(TOKEN);
    } finally { rmTempDir(dir); }
  });

  it("encodes the script as PowerShell expects it, UTF-16LE in base64", () => {
    expect(Buffer.from(encodePowerShell("Write-Output 1"), "base64").toString("utf16le")).toBe("Write-Output 1");
  });

  it("falls back to the file when PowerShell will not run", async () => {
    const { run } = runner(() => ({ code: -1, stderr: "spawn failed" }));
    const store = createTokenStore({ platform: "win32", env: {}, home: "C:\\x", run });
    expect(await store.save(TOKEN)).toEqual({ tokenStorage: "file", token: TOKEN });
  });
});

describe("Linux: the Secret Service through secret-tool", () => {
  it("is used only with a session bus and the tool on PATH", () => {
    const { run } = runner(() => ({ code: 0 }));
    expect(createTokenStore({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, home: HOME, run, which: () => true }).backend()).toBe("secret-service");
    expect(createTokenStore({ platform: "linux", env: {}, home: HOME, run, which: () => true }).backend()).toBe("file");
    expect(createTokenStore({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "x" }, home: HOME, run, which: () => false }).backend()).toBe("file");
  });

  it("stores and looks up with the secret on stdin", async () => {
    let held = "";
    const { run, calls } = runner(c => {
      if (c.args[0] === "store") { held = c.input; return { code: 0 }; }
      if (c.args[0] === "lookup") return held ? { code: 0, stdout: held } : { code: 1 };
      return { code: 0 };
    });
    const store = createTokenStore({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "x" }, home: HOME, run, which: () => true });
    const kept = await store.save(TOKEN);
    expect(kept).toEqual({ tokenStorage: "secret-service" });
    expect(await store.load(kept)).toEqual({ ok: true, token: TOKEN });
    expect(calls[0]).toMatchObject({ cmd: "secret-tool", input: TOKEN });
    neverInArgv(calls);
  });

  it("says locked when the collection will not open, and missing when nothing is there", async () => {
    const locked = runner(() => ({ code: 1, stderr: "secret-tool: Cannot create an item in a locked collection" }));
    expect(await createTokenStore({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "x" }, home: HOME, run: locked.run, which: () => true })
      .load({ tokenStorage: "secret-service" })).toEqual({ ok: false, reason: "locked" });
    const empty = runner(() => ({ code: 1 }));
    expect(await createTokenStore({ platform: "linux", env: { DBUS_SESSION_BUS_ADDRESS: "x" }, home: HOME, run: empty.run, which: () => true })
      .load({ tokenStorage: "secret-service" })).toEqual({ ok: false, reason: "missing" });
  });
});

describe("the file backend", () => {
  const dir = tempDir("ccdeck-token-file-");
  afterAll(() => rmTempDir(dir));

  it("is account.json at 0600, and nothing runs for it", async () => {
    const { run, calls } = runner(() => ({ code: 0 }));
    const store = createTokenStore({ platform: "freebsd", env: {}, home: dir, run });
    expect(store.backend()).toBe("file");
    const kept = await store.save(TOKEN);
    expect(kept).toEqual({ tokenStorage: "file", token: TOKEN });
    await saveAccount({ deviceId: "d", ...kept }, dir);
    if (process.platform !== "win32") expect(statSync(join(dir, "account.json")).mode & 0o777).toBe(0o600);
    expect(await store.load(await loadAccount(dir))).toEqual({ ok: true, token: TOKEN });
    expect(calls).toEqual([]);
  });

  it("refuses to keep anything that is not a device token", async () => {
    const store = createTokenStore({ platform: "linux", env: {}, home: dir, which: () => false });
    await expect(store.save("not-a-token")).rejects.toThrow();
  });
});
