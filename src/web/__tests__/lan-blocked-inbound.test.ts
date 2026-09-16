// The afternoon two decks on one router could not connect.
//
// A Mac and an Arch box, four metres apart, LAN sync on at both ends. The Mac
// heard the Arch box's beacon every thirty seconds and every dial to it timed
// out; the dialog said `no answer · handshake timed out` and, under the
// fingerprint, `not known — nothing has answered there`. Both sentences were
// true. Neither said that the machine was up, that the deck was running on it,
// that its beacon was arriving on this very screen, or that the one thing in
// the way was a firewall on the far end — which is what it was: Omarchy
// installs ufw and enables it, and ufw denies inbound.
//
// TWO HALVES, and this file holds both because they are one failure seen from
// two machines. On the machine that cannot see anything, silenceNote reads the
// beacon it is already receiving and says which of the two possible faults it
// is. On the machine nothing can reach, lan-reach says so before anybody else
// has to work it out, and hands over the two lines that open the path.
import { describe, it, expect } from "vitest";
import { silenceNote } from "../components/LanSyncSection";
// @ts-expect-error — plain .mjs server module, no types
import { isActive, linuxFixSteps, linuxReach, readUfw, reachability } from "../../server/lan-reach.mjs";
// @ts-expect-error — plain .mjs server module, no types
import { anotherMachine } from "../../server/lan-engine.mjs";

const NOW = 1_700_000_000_000;
/** The far machine, heard now. Its announced port is the one it really
 *  listens on — the beacon is where that number comes from. */
const heard = (over: Record<string, unknown> = {}) => ({
  fp: "1c0-f84-049-750", name: "songurov", addr: "192.168.1.205", port: 45_825, at: NOW, ...over,
});
const timedOut = (over: Record<string, unknown> = {}) => ({
  error: "handshake timed out", host: "192.168.1.205", port: 45_825, ...over,
});

describe("the sentence the dialog could have said all along", () => {
  it("names the firewall, and which machine it is on", () => {
    const said = silenceNote(timedOut(), [heard()], NOW);
    expect(said).toMatch(/running the deck/);
    expect(said).toMatch(/firewall on 192\.168\.1\.205/);
    // The two numbers whoever owns that machine has to allow. Without them the
    // sentence is a diagnosis nobody can act on.
    expect(said).toMatch(/UDP 45317/);
    expect(said).toMatch(/TCP 45825/);
  });

  // The port in the placeholder of the address field, which is what somebody
  // types when they have no other number to hand. It is nobody's real port.
  it("says the typed port is not the one that machine announces", () => {
    const said = silenceNote(timedOut({ port: 54_340 }), [heard()], NOW);
    expect(said).toMatch(/announcing itself on port 45825, not on 54340/);
    // And that there is nothing to fix at the other end, because the beacon's
    // own row is already dialling the right port every round.
    expect(said).toMatch(/already hears it/);
  });

  it("offers every port when one machine runs several decks", () => {
    const said = silenceNote(timedOut({ port: 54_340 }), [heard(), heard({ fp: "aaa", port: 45_826 })], NOW);
    expect(said).toMatch(/ports 45825 and 45826/);
  });

  it("says nothing about an address no beacon has come from, which is a machine that may simply be off", () => {
    expect(silenceNote(timedOut(), [heard({ addr: "192.168.1.9" })], NOW)).toBeNull();
    expect(silenceNote(timedOut(), [], NOW)).toBeNull();
  });

  // The claim is in the present tense — "its beacon arrives here every half
  // minute" — so it may only be made about a beacon that is still arriving.
  it("will not speak in the present tense about a deck heard this morning", () => {
    expect(silenceNote(timedOut(), [heard({ at: NOW - 3_600_000 })], NOW)).toBeNull();
    expect(silenceNote(timedOut(), [heard({ at: 0 })], NOW)).toBeNull();
  });

  it("stays quiet under an error that already names its own cause", () => {
    for (const error of ["peer closed the connection", "bad challenge", "that deck said no", null]) {
      expect(silenceNote(timedOut({ error }), [heard()], NOW)).toBeNull();
    }
  });
});

describe("the machine nothing can reach, on Linux", () => {
  const ufwOn = { enabled: true, input: "DROP" };

  it("reproduces the box the bug was reported from", () => {
    const said = linuxReach({ ufw: ufwOn, syncPort: 45_825 });
    expect(said.blocked).toBe(true);
    expect(said.steps).toEqual([
      "sudo ufw allow 45317/udp comment 'ccdeck discovery'",
      "sudo ufw allow 45825/tcp comment 'ccdeck sync'",
    ]);
    // Both halves of the asymmetry, because hearing the far deck while being
    // invisible to it is what makes people conclude the feature is broken.
    expect(said.text).toMatch(/cannot reach this one/);
    expect(said.text).toMatch(/still hear it/);
  });

  // The measurement outranks every rule file: a connection from another machine
  // arrived, so the path is open whatever ufw is configured to do.
  it("has no complaint about a machine something has already reached", () => {
    const said = linuxReach({ ufw: ufwOn, syncPort: 45_825, inbound: NOW });
    expect(said.blocked).toBe(false);
    expect(said.steps).toBeUndefined();
  });

  it("says what it could not check rather than implying it did", () => {
    expect(linuxReach({ ufw: ufwOn, syncPort: 1 }).unsure).toMatch(/root/);
  });

  it("blames nothing on a machine whose firewall is not running", () => {
    expect(linuxReach({ ufw: { enabled: false, input: "DROP" }, syncPort: 45_825 })).toBeNull();
    // On for outbound shaping and letting inbound through is not this bug.
    expect(linuxReach({ ufw: { enabled: true, input: "ACCEPT" }, syncPort: 45_825 })).toBeNull();
    expect(linuxReach({})).toBeNull();
  });

  it("writes firewalld's own commands on a machine running firewalld", () => {
    const said = linuxReach({ firewalld: true, syncPort: 45_825 });
    expect(said.tool).toBe("firewalld");
    expect(said.steps).toEqual([
      "sudo firewall-cmd --permanent --add-port=45317/udp",
      "sudo firewall-cmd --permanent --add-port=45825/tcp",
      "sudo firewall-cmd --reload",
    ]);
  });

  // A deck whose listener has not come up has no port to name. Half the answer
  // is the half that never changes, and it is better than a line with a zero
  // in it that somebody would paste.
  it("offers the discovery port alone when there is no sync port yet", () => {
    expect(linuxFixSteps({ tool: "ufw", syncPort: null, discoveryPort: 45_317 })).toHaveLength(1);
    expect(linuxFixSteps({ tool: "ufw", syncPort: 0, discoveryPort: 45_317 }).join()).not.toMatch(/tcp/);
  });
});

describe("what the two readable ufw files say", () => {
  it("reads the switch and the default, quoted or bare", () => {
    expect(readUfw("ENABLED=yes\nLOGLEVEL=low\n", 'DEFAULT_INPUT_POLICY="DROP"\n'))
      .toEqual({ enabled: true, input: "DROP" });
    expect(readUfw('ENABLED="yes"', "DEFAULT_INPUT_POLICY=REJECT"))
      .toEqual({ enabled: true, input: "REJECT" });
  });

  it("is not fooled by the word inside a comment", () => {
    expect(readUfw("# ENABLED=yes is the default\nENABLED=no\n", "").enabled).toBe(false);
  });

  it("reads a machine with no ufw at all as a machine with no ufw", () => {
    expect(readUfw(null, null)).toEqual({ enabled: false, input: "" });
  });

  // `systemctl is-active` exits non-zero for everything that is not active, so
  // what it printed is the answer and its status is not.
  it("counts only `active`, whatever else systemd prints", () => {
    expect(isActive("active\n")).toBe(true);
    for (const said of ["inactive", "failed", "unknown", "activating", "", null]) {
      expect(isActive(said)).toBe(false);
    }
  });
});

describe("the module's refusal to act, on Linux too", () => {
  it("hands back text and never runs it", () => {
    const said = linuxReach({ ufw: { enabled: true, input: "DROP" }, syncPort: 45_825 });
    for (const step of said.steps) expect(typeof step).toBe("string");
    expect(said).not.toHaveProperty("run");
  });

  // Every command is one somebody could have typed themselves, and none of
  // them takes anything away — see relay-guard.mjs for why this deck may not
  // raise a password prompt of its own.
  it("never spells a verb that removes or resets anything", () => {
    const text = [
      ...linuxFixSteps({ tool: "ufw", syncPort: 45_825, discoveryPort: 45_317 }),
      ...linuxFixSteps({ tool: "firewalld", syncPort: 45_825, discoveryPort: 45_317 }),
    ].join("\n");
    for (const verb of ["delete", "reset", "disable", "--remove-port", "rm "]) {
      expect(text).not.toContain(verb);
    }
  });
});

describe("which platform is spoken about at all", () => {
  it("routes Linux to the Linux read and carries the measurement into it", () => {
    const linux = { ufw: { enabled: true, input: "DROP" }, syncPort: 45_825 };
    expect(reachability({ platform: "linux", linux }).blocked).toBe(true);
    expect(reachability({ platform: "linux", linux, inbound: NOW }).blocked).toBe(false);
    expect(reachability({ platform: "linux", linux: null })).toBeNull();
  });

  // macOS ships its firewall off and, when it is on, asks the person at the
  // keyboard the first time a program listens. There is nothing to instruct.
  it("still has no opinion about macOS", () => {
    expect(reachability({ platform: "darwin", linux: { ufw: { enabled: true, input: "DROP" } } })).toBeNull();
  });
});

describe("which connection counts as proof", () => {
  // The second deck on this computer is the ordinary case on a developer machine and
  // says nothing about the network.
  it("does not count this machine talking to itself", () => {
    const mine = ["192.168.1.82", "100.67.32.58"];
    expect(anotherMachine("127.0.0.1", mine)).toBe(false);
    expect(anotherMachine("::1", mine)).toBe(false);
    expect(anotherMachine("192.168.1.82", mine)).toBe(false);
    expect(anotherMachine("", mine)).toBe(false);
    expect(anotherMachine(null, mine)).toBe(false);
  });

  it("counts another machine, however node spelled its address", () => {
    const mine = ["192.168.1.82"];
    expect(anotherMachine("192.168.1.205", mine)).toBe(true);
    // A v4 peer on a dual-stack listener arrives in v6 clothing.
    expect(anotherMachine("::ffff:192.168.1.205", mine)).toBe(true);
    expect(anotherMachine("::ffff:192.168.1.82", mine)).toBe(false);
  });
});
