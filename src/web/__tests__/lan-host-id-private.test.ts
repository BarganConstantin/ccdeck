// The beacon's machine id (`h`) folds one computer's decks into one row on
// everybody else's panel. It goes out in the clear every thirty seconds, and
// its inputs — the hostname and the home directory — carry a person's name. On
// a deck nobody renamed the hostname is in the same packet as the deck's name,
// so a plain hash of the two left only the home directory to guess, and a
// short list of /Users/<name>, /home/<name> and C:\Users\<name> guessed it.
//
// So the id is keyed with a secret this machine already has and never sends —
// the same for every deck this user runs on it, and different on every other
// machine — and nobody who only hears the beacon can work it back.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
// @ts-expect-error — plain .mjs server module, no types
import { beaconVerdict, formerHostId, hostId, machineName, machineSecret, readBeacon } from "../../server/lan-sync.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { createBeacon } from "../../server/lan-beacon.mjs";

const HOST = "Petrus-MacBook-Pro";
const HOME = "/Users/petru.ionescu";
const NAMES = ["petru", "petru.ionescu", "pionescu", "ionescu", "admin", "user"];
const GUESSES = NAMES.flatMap(n => [`/Users/${n}`, `/home/${n}`, `C:\\Users\\${n}`]);

/** What a stranger can compute from a beacon: the hostname it carries, and a
 *  guess at the home directory. */
const guess = (home: string) => createHash("sha256").update(`${machineName(HOST)}\u0000${home}`).digest("hex").slice(0, 12);

describe("the machine id a beacon carries", () => {
  it("cannot be worked back to the home directory from the hostname beside it", () => {
    const h = hostId({ hostname: HOST, home: HOME, key: "this machine's own secret" });
    expect(GUESSES.filter(home => guess(home) === h), "the id gave the home directory away").toEqual([]);
  });

  it("is still one id per machine and user, and two for two machines", () => {
    const key = "this machine's own secret";
    expect(hostId({ hostname: HOST, home: HOME, key })).toBe(hostId({ hostname: `${HOST}.local`, home: HOME, key }));
    expect(hostId({ hostname: HOST, home: HOME, key })).not.toBe(hostId({ hostname: HOST, home: "/Users/other", key }));
    // A copied config on another machine reads as another machine, even with
    // the same hostname, because that machine's secret is its own.
    expect(hostId({ hostname: HOST, home: HOME, key })).not.toBe(hostId({ hostname: HOST, home: HOME, key: "another machine" }));
  });

  it("goes out keyed whenever this machine has a secret to key it with", async () => {
    const sent: Buffer[] = [];
    const sock = {
      on() { /* nothing arrives */ }, bind(_p: number, _h: string, cb: () => void) { cb(); }, setBroadcast() {},
      send(msg: Buffer, _p: number, _a: string, cb?: (e: Error | null) => void) { sent.push(msg); cb?.(null); },
      close() {},
    };
    const b = createBeacon({ port: 51234, name: "MacBook", fp: "abc-def-012-345", createSocket: () => sock, ifaces: () => ({}) });
    await b.start();
    const out = readBeacon(sent[0]);
    b.stop();
    expect(out.host).toBe(hostId());
    if (machineSecret()) expect(out.host, "the plain hash went out on a machine that has a secret").not.toBe(formerHostId());
  });
});

describe("the secret it is keyed with", () => {
  const fail = () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); };

  it("is the machine id on Linux, from systemd's file or D-Bus's", () => {
    const files: Record<string, string> = { "/var/lib/dbus/machine-id": "0123456789abcdef0123456789abcdef\n" };
    const readFile = (p: string) => files[p] ?? fail();
    expect(machineSecret({ platform: "linux", readFile, run: fail })).toBe("0123456789abcdef0123456789abcdef");
    files["/etc/machine-id"] = "fedcba9876543210fedcba9876543210\n";
    expect(machineSecret({ platform: "linux", readFile, run: fail })).toBe("fedcba9876543210fedcba9876543210");
  });

  it("is the platform UUID on a Mac", () => {
    const run = () => '+-o J316sAP  <class IOPlatformExpertDevice>\n    "IOPlatformUUID" = "1A2B3C4D-0000-1111-2222-333344445555"\n';
    expect(machineSecret({ platform: "darwin", readFile: fail, run })).toBe("1A2B3C4D-0000-1111-2222-333344445555");
  });

  it("is the machine GUID on Windows", () => {
    const run = () => "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\r\n";
    expect(machineSecret({ platform: "win32", readFile: fail, run })).toBe("6f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0");
  });

  it("is nothing when the machine has none to read, and the id is then the one decks always sent", () => {
    expect(machineSecret({ platform: "linux", readFile: () => "", run: fail })).toBeNull();
    expect(machineSecret({ platform: "darwin", readFile: fail, run: fail })).toBeNull();
    expect(machineSecret({ platform: "win32", readFile: fail, run: () => "garbage" })).toBeNull();
    expect(hostId({ hostname: HOST, home: HOME, key: "" })).toBe(guess(HOME));
  });
});

describe("an older deck on this same machine", () => {
  // A deck from before this sends the plain hash. A newer one on the same
  // computer knows that value too, since it is this machine's own, and reads
  // it as itself — never as a stranger to pair with, nor as a copy of its key.
  const mine = { selfHost: "aaaaaaaaaaaa", formerHost: "bbbbbbbbbbbb" };
  const beacon = (over: Record<string, unknown>) => ({ name: "x", fp: "abc-def-012-345", port: 1, instance: "11111111", host: "bbbbbbbbbbbb", ...over });

  it("is this machine, with its own key or another", () => {
    expect(beaconVerdict(beacon({}), { ...mine, selfFp: "fff-fff-fff-fff", selfInstance: "22222222" })).toBe("self");
    expect(beaconVerdict(beacon({}), { ...mine, selfFp: "abc-def-012-345", selfInstance: "22222222" })).toBe("self");
  });

  it("is not confused with another machine's id", () => {
    const elsewhere = beacon({ host: "cccccccccccc" });
    expect(beaconVerdict(elsewhere, { ...mine, selfFp: "fff-fff-fff-fff", selfInstance: "22222222" })).toBe("stranger");
    expect(beaconVerdict(elsewhere, { ...mine, selfFp: "abc-def-012-345", selfInstance: "22222222" })).toBe("id-clash");
  });
});
