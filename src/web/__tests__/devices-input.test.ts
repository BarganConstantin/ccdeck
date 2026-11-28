// Devices over SSH, the pure half: what a device may be, the ssh argument
// vector built from it, what ssh's failures are read as, host keys, and what
// a device's ccdeck answers.
//
// The threat these pin is option injection. Every field of a device becomes
// an argument to the system ssh, and ssh reads `-oProxyCommand=…` as a
// command line to run on this machine. So no field may be able to start with
// `-`, carry whitespace or `=`, and the destination always follows `--`.
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { destinationKey, parseDeviceInput, validAlias, validHost, validName, validPort, validUser } from "../../server/device-input.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { classifySsh, destinationArgs, fingerprintOf, parseHostKeys, parseSshConfig, sshArgs, sshPathValue } from "../../server/device-ssh.mjs";
import {
  POSIX_FIND, REMOTE_MIN_VERSION, lastJsonObject, parseRemoteVersion, readSessionsAnswer, remoteCommand, remoteMissing, remoteSessions, tooOld,
// @ts-expect-error — plain .mjs server module, no types
} from "../../server/device-remote.mjs";

/** An ed25519 public key in ssh's wire format, base64. */
function hostKeyBlob(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const type = Buffer.from("ssh-ed25519");
  const len = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return Buffer.concat([len(type.length), type, len(raw.length), raw]).toString("base64");
}

describe("what a device may be", () => {
  it("takes an alias, or a host with a user and an optional port", () => {
    expect(parseDeviceInput({ alias: "studio" })).toEqual({ ok: true, value: { name: "studio", alias: "studio" } });
    expect(parseDeviceInput({ name: "Mac mini", host: "mac.home", user: "ana", port: "2222" }))
      .toEqual({ ok: true, value: { name: "Mac mini", host: "mac.home", user: "ana", port: 2222 } });
    expect(parseDeviceInput({ host: "10.0.0.7", user: "ana" })).toEqual({ ok: true, value: { name: "10.0.0.7", host: "10.0.0.7", user: "ana", port: null } });
    expect(parseDeviceInput({ host: "[::1]", user: "ana" })).toMatchObject({ ok: true, value: { host: "::1" } });
  });

  it("names the field that is wrong", () => {
    expect(parseDeviceInput({})).toEqual({ ok: false, field: "host", code: "missing" });
    expect(parseDeviceInput({ alias: "a", host: "b", user: "c" })).toEqual({ ok: false, field: "alias", code: "both" });
    expect(parseDeviceInput({ host: "mac.home" })).toEqual({ ok: false, field: "user", code: "missing" });
    expect(parseDeviceInput({ host: "mac.home", user: "ana", port: "0" })).toEqual({ ok: false, field: "port", code: "invalid" });
    expect(parseDeviceInput(null)).toEqual({ ok: false, field: "device", code: "invalid" });
    expect(parseDeviceInput(["alias"])).toEqual({ ok: false, field: "device", code: "invalid" });
  });

  it("refuses every shape ssh could read as an option or a second argument", () => {
    const hostile = [
      "-oProxyCommand=touch /tmp/pwned", "-oProxyCommand=x", "-F/dev/null", "--", "-", "-l", "-p22",
      "a b", "a\tb", "a\nb", "host;id", "$(id)", "`id`", "a=b", "%h", "a%b", "user@host", "host:22",
      "'quoted'", "\"quoted\"", "a/b", "a\\b", "*", "web?", "!x", "", " ", "\u0000",
    ];
    for (const v of hostile) {
      expect(validAlias(v), `alias ${JSON.stringify(v)}`).toBeNull();
      expect(validUser(v), `user ${JSON.stringify(v)}`).toBeNull();
      expect(validHost(v), `host ${JSON.stringify(v)}`).toBeNull();
      expect(parseDeviceInput({ alias: v }).ok, `device alias ${JSON.stringify(v)}`).toBe(false);
      expect(parseDeviceInput({ host: v, user: "ana" }).ok, `device host ${JSON.stringify(v)}`).toBe(false);
      expect(parseDeviceInput({ host: "mac.home", user: v }).ok, `device user ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("holds a host to a name or an address, and a zone id is not one", () => {
    expect(validHost("Mac-Mini.local")).toBe("mac-mini.local");
    expect(validHost("build_box")).toBe("build_box");
    expect(validHost("example.com.")).toBe("example.com.");
    expect(validHost("fe80::1%eth0")).toBeNull();
    expect(validHost("-mac.home")).toBeNull();
    expect(validHost("mac-.home")).toBeNull();
    expect(validHost("a..b")).toBeNull();
    expect(validHost(`${"a".repeat(64)}.home`)).toBeNull();
    expect(validHost(42)).toBeNull();
  });

  it("holds a port to 1-65535, digits only", () => {
    for (const ok of [1, 22, "22", " 2222 ", 65535]) expect(validPort(ok), String(ok)).not.toBeNull();
    for (const bad of [0, 65536, -1, 22.5, "22.0", "0x16", "22 -oX", "-22", "", "1e3", NaN, null, {}]) {
      expect(validPort(bad), String(bad)).toBeNull();
    }
  });

  it("shows no name with control or direction-overriding characters, or longer than 64", () => {
    expect(validName("Laptop B")).toBe("Laptop B");
    expect(validName("x\u202Eyz")).toBeNull();
    expect(validName("a\nb")).toBeNull();
    expect(validName("m".repeat(65))).toBeNull();
    expect(parseDeviceInput({ alias: "studio", name: "  " })).toMatchObject({ ok: true, value: { name: "studio" } });
  });

  it("drops every field a device does not have, secrets first", () => {
    const parsed = parseDeviceInput({
      alias: "studio", password: "hunter2", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----", identityFile: "~/.ssh/id_ed25519",
      proxyCommand: "nc %h %p", command: "rm -rf ~",
    });
    expect(parsed).toEqual({ ok: true, value: { name: "studio", alias: "studio" } });
  });

  it("keys a destination so the same machine cannot be saved twice", () => {
    expect(destinationKey({ alias: "studio" })).toBe("alias:studio");
    expect(destinationKey({ host: "mac.home", user: "ana", port: null })).toBe("host:ana@mac.home:");
    expect(destinationKey({ host: "mac.home", user: "ana", port: 22 })).not.toBe(destinationKey({ host: "mac.home", user: "bob", port: 22 }));
  });
});

describe("the ssh argument vector", () => {
  const host = { host: "mac.home", user: "ana", port: 2222 };

  it("puts the destination after `--`, and its parts in their own entries", () => {
    expect(destinationArgs({ alias: "studio" })).toEqual(["--", "studio"]);
    expect(destinationArgs(host)).toEqual(["-l", "ana", "-p", "2222", "--", "mac.home"]);
    expect(destinationArgs({ host: "mac.home", user: "ana", port: null })).toEqual(["-l", "ana", "--", "mac.home"]);
    const args = sshArgs(host, { command: "ccdeck --version" });
    expect(args.slice(-3)).toEqual(["--", "mac.home", "ccdeck --version"]);
  });

  it("pins batch mode, strict host keys and no forwarding whatever the user's config says", () => {
    const args = sshArgs({ alias: "studio" }, { command: "ccdeck --version" }).join(" ");
    for (const o of ["BatchMode=yes", "StrictHostKeyChecking=yes", "UpdateHostKeys=no", "ClearAllForwardings=yes", "ForwardAgent=no",
      "ForwardX11=no", "PermitLocalCommand=no", "RequestTTY=no", "ControlMaster=no", "ControlPath=none"]) {
      expect(args).toContain(`-o ${o}`);
    }
    expect(args).toContain("-T -x -a");
  });

  it("opens a master only on a control socket it was given, never a ControlPersist one", () => {
    const master = sshArgs({ alias: "studio" }, { mode: "master", control: "/run/user/1/ccdeck-ssh/abc" });
    expect(master).toEqual(expect.arrayContaining(["-M", "-N", "-S", "/run/user/1/ccdeck-ssh/abc", "ControlMaster=yes", "ControlPersist=no"]));
    expect(master.at(-1)).toBe("studio");
    const through = sshArgs({ alias: "studio" }, { control: "/run/user/1/ccdeck-ssh/abc", command: "ccdeck --version" });
    expect(through).toEqual(expect.arrayContaining(["-S", "/run/user/1/ccdeck-ssh/abc", "ControlMaster=no"]));
    expect(through).not.toContain("-M");
    expect(() => sshArgs({ alias: "studio" }, { mode: "master" })).toThrow();
  });

  it("learns a host key into a throwaway file with every way of signing in off", () => {
    const args = sshArgs({ alias: "studio" }, { mode: "learn", knownHosts: "/tmp/x/known_hosts" }).join(" ");
    expect(args).toContain("-o StrictHostKeyChecking=accept-new");
    expect(args).toContain("-o UserKnownHostsFile=/tmp/x/known_hosts");
    for (const o of ["PubkeyAuthentication=no", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "HostbasedAuthentication=no"]) {
      expect(args).toContain(`-o ${o}`);
    }
    expect(args.endsWith("-- studio exit")).toBe(true);
  });

  it("quotes a file path with a space and refuses one it cannot say", () => {
    expect(sshPathValue("/tmp/a/known_hosts")).toBe("/tmp/a/known_hosts");
    expect(sshPathValue("C:\\Users\\Ana Maria\\Temp\\kh")).toBe("\"C:\\Users\\Ana Maria\\Temp\\kh\"");
    expect(sshPathValue("/tmp/a\"b")).toBeNull();
    expect(sshPathValue("/tmp/a\nb")).toBeNull();
  });
});

describe("what ssh's failures are read as", () => {
  // The lines below are what OpenSSH 10.2 printed against a scratch sshd, in
  // the C locale, with LogLevel=ERROR.
  it("tells an unknown key from a changed one, and keeps the changed key's fingerprint", () => {
    expect(classifySsh({ code: 255, stderr: "No ED25519 host key is known for [127.0.0.1]:42222 and you have requested strict checking.\nHost key verification failed.\n" }))
      .toEqual({ type: "host_key_unknown" });
    const changed = [
      "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @",
      "The fingerprint for the ED25519 key sent by the remote host is",
      "SHA256:Np2fPC7/KsRa7Ua2SKI7RcUzgBAa6aB/8EufST7mfUw.",
      "Host key for [127.0.0.1]:42222 has changed and you have requested strict checking.",
      "Host key verification failed.",
    ].join("\n");
    expect(classifySsh({ code: 255, stderr: changed })).toEqual({ type: "host_key_changed", fingerprint: "SHA256:Np2fPC7/KsRa7Ua2SKI7RcUzgBAa6aB/8EufST7mfUw" });
  });

  it("reads auth, offline and timeouts", () => {
    expect(classifySsh({ code: 255, stderr: "constantin@127.0.0.1: Permission denied (publickey).\n" })).toEqual({ type: "auth_failed" });
    expect(classifySsh({ code: 255, stderr: "ssh: connect to host 127.0.0.1 port 42223: Connection refused\n" })).toEqual({ type: "unreachable", detail: "refused" });
    expect(classifySsh({ code: 255, stderr: "ssh: Could not resolve hostname nohost.invalid: Name or service not known\n" })).toEqual({ type: "unreachable", detail: "dns" });
    expect(classifySsh({ code: 255, stderr: "ssh: connect to host 10.255.255.1 port 22: Connection timed out\n" })).toEqual({ type: "unreachable", detail: "timeout" });
    expect(classifySsh({ code: 255, stderr: "ssh: connect to host x port 22: No route to host\n" })).toEqual({ type: "unreachable", detail: "network" });
    expect(classifySsh({ code: null, stderr: "", timedOut: true })).toEqual({ type: "unreachable", detail: "timeout" });
    expect(classifySsh({ missing: true })).toEqual({ type: "ssh_missing" });
  });

  it("names nothing ssh did not say, and keeps one printable line of the rest", () => {
    expect(classifySsh({ code: 255, stderr: "kex protocol\x1b[31m error\nsecond line" })).toEqual({ type: "failed", detail: "kex protocol[31m error" });
  });

  it("leaves a remote command's own failure to the caller, whatever it printed", () => {
    expect(classifySsh({ code: 0, stderr: "" })).toBeNull();
    expect(classifySsh({ code: 127, stderr: "bash: ccdeck: command not found" })).toBeNull();
    expect(classifySsh({ code: 1, stderr: "Permission denied (publickey)." })).toBeNull();
    expect(classifySsh({ code: 3, stderr: "Host key verification failed." })).toBeNull();
  });
});

describe("host keys", () => {
  it("prints the fingerprint ssh-keygen prints", () => {
    // ssh-keygen -lf on the scratch sshd's host key: 256 SHA256:Np2fPC7/… (ED25519).
    expect(fingerprintOf("AAAAC3NzaC1lZDI1NTE5AAAAIAL0H1kF8z5+hb7JztBeVZtIVmU05xhN0Q8w4O42B6Wh"))
      .toBe("SHA256:Np2fPC7/KsRa7Ua2SKI7RcUzgBAa6aB/8EufST7mfUw");
  });

  it("rebuilds each line from its three fields and drops what is not a key line", () => {
    const blob = hostKeyBlob();
    const keys = parseHostKeys([
      `[mac.home]:2222 ssh-ed25519 ${blob} a comment`,
      `|1|c2FsdA==|aGFzaA== ssh-ed25519 ${blob}`,
      `@cert-authority * ssh-ed25519 ${blob}`,
      `mac.home ssh-rsa ${blob}`, // the blob says ed25519
      `mac.home ssh-ed25519 not*base64`,
      `mac home ssh-ed25519 ${blob}`,
      `mac.home ssh-ed25519 ${blob}\nevil.example ssh-ed25519 ${blob}`.split("\n")[0],
      "# a comment",
    ].join("\n"));
    expect(keys.map((k: { line: string }) => k.line)).toEqual([
      `[mac.home]:2222 ssh-ed25519 ${blob}`,
      `|1|c2FsdA==|aGFzaA== ssh-ed25519 ${blob}`,
      `mac.home ssh-ed25519 ${blob}`,
    ]);
    expect(keys[0]).toMatchObject({ keyType: "ssh-ed25519", fingerprint: fingerprintOf(blob) });
  });

  it("reads where ssh adds a key from `ssh -G`", () => {
    const out = "user ana\nhostname 127.0.0.1\nport 42222\nuserknownhostsfile /home/ana/.ssh/known_hosts /home/ana/.ssh/known_hosts2\n";
    expect(parseSshConfig(out)).toEqual({ hostname: "127.0.0.1", port: 42222, user: "ana", knownHosts: "/home/ana/.ssh/known_hosts" });
    expect(parseSshConfig("userknownhostsfile \"C:\\Users\\Ana Maria\\.ssh\\known_hosts\" x").knownHosts).toBe("C:\\Users\\Ana Maria\\.ssh\\known_hosts");
  });
});

describe("what the device's ccdeck is asked, and how it is read", () => {
  it("asks with fixed words only", () => {
    expect(remoteCommand("plain", "version")).toBe("ccdeck --version");
    expect(remoteCommand("plain", "sessions")).toBe("ccdeck sessions --json");
    expect(remoteCommand("posix", "sessions")).toBe(`sh -c '${POSIX_FIND}' ccdeck sessions --json`);
    // The script travels inside single quotes, so it may not hold one.
    expect(POSIX_FIND).not.toContain("'");
    expect(() => remoteCommand("plain", "launch")).toThrow();
    expect(() => remoteCommand("bash", "version")).toThrow();
  });

  it("knows ccdeck is missing from each shell's own words", () => {
    expect(remoteMissing({ code: 127, stdout: "", stderr: "" })).toBe(true);
    expect(remoteMissing({ code: 1, stdout: "", stderr: "'ccdeck' is not recognized as an internal or external command," })).toBe(true);
    expect(remoteMissing({ code: 1, stdout: "", stderr: "ccdeck : The term 'ccdeck' is not recognized as the name of a cmdlet" })).toBe(true);
    expect(remoteMissing({ code: 0, stdout: "4.5.0\n", stderr: "" })).toBe(false);
  });

  it("reads the version and holds it to the minimum", () => {
    expect(parseRemoteVersion("4.5.0\n")).toBe("4.5.0");
    expect(parseRemoteVersion("Welcome!\n\nv4.6.0-rc.1\n")).toBe("4.6.0-rc.1");
    expect(parseRemoteVersion("ccdeck is great")).toBeNull();
    expect(tooOld("3.43.9")).toBe(true);
    expect(tooOld(REMOTE_MIN_VERSION)).toBe(false);
    expect(tooOld("4.5.0")).toBe(false);
  });

  it("reads the sessions answer, a missing deck, and nonsense", () => {
    expect(lastJsonObject("noise\n{\"a\":1}\n")).toEqual({ a: 1 });
    expect(readSessionsAnswer({ code: 3, stdout: "{\"schemaVersion\":1,\"ok\":false,\"error\":{\"code\":\"no_deck\"}}\n" })).toEqual({ ok: false, reason: "no_deck" });
    expect(readSessionsAnswer({ code: 0, stdout: "{\"ok\":true,\"sessions\":\"no\"}" })).toEqual({ ok: false, reason: "unreadable" });
    expect(readSessionsAnswer({ code: 0, stdout: "{\"schemaVersion\":1,\"ok\":true,\"deck\":{\"version\":\"4.5.0\"},\"sessions\":[]}\n" }))
      .toEqual({ ok: true, deckVersion: "4.5.0", remoteNow: null, rows: [] });
  });

  it("ties every session to its device, so one title on two machines stays two rows", () => {
    const row = { id: "s1", provider: "codex", cwd: "/home/ana/app", project: "app", name: "Fix login", model: "gpt-5", state: "waiting", since: 1, startedAt: 1, lastEventAt: 2, waiting: { kind: "permission", message: "Run tests?", since: 1, tool: "Bash" } };
    const a = remoteSessions([row], { id: "dev-a", name: "Laptop" });
    const b = remoteSessions([row], { id: "dev-b", name: "Desktop" });
    expect(a[0]).toMatchObject({ key: "dev-a:s1", id: "s1", device: { id: "dev-a", name: "Laptop" }, provider: "codex", state: "waiting", waiting: { tool: "Bash" } });
    expect(b[0].key).toBe("dev-b:s1");
    expect(a[0].key).not.toBe(b[0].key);
  });

  it("reads another machine's rows as data: types checked, text cut, unknown states dropped", () => {
    const rows = remoteSessions([
      { id: "ok", state: "idle", provider: "other", name: `x${"y".repeat(400)}\u202E`, cwd: 5, lastEventAt: "soon" },
      { id: "bad", state: "exploded" },
      { id: 7, state: "idle" },
      { id: "a\u0000b", state: "idle" },
      null,
    ], { id: "d", name: "D" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "ok", provider: "claude", cwd: null, lastEventAt: null, waiting: null });
    expect(rows[0].name).toHaveLength(256);
    expect(remoteSessions(Array.from({ length: 900 }, (_, i) => ({ id: `s${i}`, state: "idle" })), { id: "d", name: "D" })).toHaveLength(500);
  });
});
