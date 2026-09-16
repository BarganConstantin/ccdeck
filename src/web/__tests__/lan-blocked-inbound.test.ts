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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { silenceNote } from "../components/LanSyncSection";
import { REACH_WAY_OUT } from "../components/LanReachNote";
// @ts-expect-error — plain .mjs server module, no types
import { MAC_FW, QUIET_MS, isActive, linuxFixSteps, linuxReach, macFixSteps, macReach, readMacProbe, readUfw, reachability, silentInbound } from "../../server/lan-reach.mjs";
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

  // macOS used to be among the silent ones. It is not any more — see the macos
  // block in lan-reach.mjs — but it is still silent without a probe.
  it("says nothing about a Mac it could not ask", () => {
    expect(reachability({ platform: "darwin" })).toBeNull();
    expect(reachability({ platform: "darwin", linux: { ufw: { enabled: true, input: "DROP" } } })).toBeNull();
  });
});

// ── the Mac at the other end of the same afternoon ──────────────────────────
//
// The Arch box was the machine nothing could reach, and the Mac was the one
// reading `handshake timed out` at it. Turn the pair around — a Mac with the
// firewall on and this deck not allowed through it — and the same silence comes
// back with nothing on screen to explain it.
//
// What makes this platform the best informed of the three rather than the worst
// is that the question is answerable exactly: not "what is the default policy
// and what would it do", but "is an incoming connection to THIS binary
// permitted". Asked as an ordinary user, no password.
const EXE = "/Users/someone/.nvm/versions/node/v22.14.0/bin/node";
/** What the three reads print, in the spellings measured on macOS 26.6. */
const said = {
  off: "Firewall is disabled. (State = 0)",
  on: "Firewall is enabled. (State = 1)",
  blockAllOff: "Firewall has block all state set to disabled.",
  blockAllOn: "Firewall has block all state set to enabled.",
  permitted: `Incoming connection to ${EXE} is permitted.`,
  blocked: `Incoming connection to ${EXE} is blocked.`,
};
const macProbe = (globalState: string, blockAll: string, app: string) =>
  readMacProbe({ global: globalState, blockAll, app });

describe("what the application firewall was asked", () => {
  it("reads the state off the number, not the adjective", () => {
    expect(macProbe(said.off, said.blockAllOff, said.permitted).on).toBe(false);
    expect(macProbe(said.on, said.blockAllOff, said.permitted).on).toBe(true);
    // State 2 says "enabled" in words too, and is still on.
    expect(macProbe("Firewall is enabled. (State = 2)", said.blockAllOff, said.permitted).on).toBe(true);
  });

  it("comes back null for anything it could not read", () => {
    // A locked-down build, a renamed flag, a tool that is not there: every one
    // of them reaches this as an empty string, and none of them is a verdict.
    const blank = macProbe("", "", "");
    expect(blank.on).toBeNull();
    expect(blank.appBlocked).toBeNull();
    expect(macReach({ probe: blank, exePath: EXE })).toBeNull();
    expect(macReach({ probe: null, exePath: EXE })).toBeNull();
  });

  it("hears both answers about the binary", () => {
    expect(macProbe(said.on, said.blockAllOff, said.permitted).appBlocked).toBe(false);
    expect(macProbe(said.on, said.blockAllOff, said.blocked).appBlocked).toBe(true);
  });
});

describe("whether a Mac can be reached", () => {
  it("clears a machine whose firewall is off rather than blaming it", () => {
    const v = macReach({ probe: macProbe(said.off, said.blockAllOff, said.permitted), exePath: EXE });
    expect(v.blocked).toBe(false);
    expect(v.why).toBe("firewall off");
  });

  // THE TRAP, MEASURED: with the firewall off, `--getappblocked` answers "is
  // permitted" for every path handed to it, including one that does not exist.
  // So the per-app answer is not evidence of a rule until the global state says
  // the firewall is on, and a verdict that read them in the other order would
  // report "app permitted" about a machine it had learned nothing about.
  it("does not treat a permitted binary as a finding while the firewall is off", () => {
    const v = macReach({ probe: macProbe(said.off, said.blockAllOff, said.permitted), exePath: EXE });
    expect(v.why).not.toBe("app permitted");
  });

  it("names block-all first, because nothing else takes effect under it", () => {
    const v = macReach({ probe: macProbe(said.on, said.blockAllOn, said.permitted), exePath: EXE });
    expect(v.blocked).toBe(true);
    expect(v.why).toBe("block all incoming");
    expect(v.steps[0]).toBe(`sudo ${MAC_FW} --setblockall off`);
    // And it still says the thing that stops somebody concluding the far deck
    // is off: their panel may already show this machine.
    expect(v.text).toMatch(/can still hear it/);
  });

  it("says so when this deck's own binary is refused, and hands over the two lines", () => {
    const v = macReach({ probe: macProbe(said.on, said.blockAllOff, said.blocked), exePath: EXE });
    expect(v.blocked).toBe(true);
    expect(v.why).toBe("app blocked");
    expect(v.shell).toBe("sh");
    // `--add` first: a binary the firewall has never heard of cannot be
    // unblocked. Both are safe to paste twice.
    expect(v.steps).toEqual([`sudo ${MAC_FW} --add "${EXE}"`, `sudo ${MAC_FW} --unblockapp "${EXE}"`]);
  });

  it("clears a binary the firewall is letting through", () => {
    const v = macReach({ probe: macProbe(said.on, said.blockAllOff, said.permitted), exePath: EXE });
    expect(v.blocked).toBe(false);
    expect(v.why).toBe("app permitted");
  });

  it("lets a connection that got in outrank every setting", () => {
    const v = macReach({ probe: macProbe(said.on, said.blockAllOn, said.blocked), exePath: EXE, inbound: NOW });
    expect(v.blocked).toBe(false);
    expect(v.why).toBe("inbound seen");
  });

  // The Linux verdict carries `unsure` because ufw shows its rules to nobody
  // but root. This one looked at the answer itself, so claiming doubt would be
  // false modesty in a sentence a reader has to act on.
  it("admits no doubt it does not have", () => {
    const v = macReach({ probe: macProbe(said.on, said.blockAllOff, said.blocked), exePath: EXE });
    expect(v.unsure).toBeUndefined();
  });

  it("is what reachability routes a Mac to", () => {
    const mac = macProbe(said.on, said.blockAllOff, said.blocked);
    const v = reachability({ platform: "darwin", mac, exePath: EXE });
    expect(v.blocked).toBe(true);
    expect(v.steps).toEqual(macFixSteps({ exePath: EXE }));
  });
});

// ── the machine nothing can be asked about ──────────────────────────────────
//
// Three platforms can be read, and every one of those reads can come back
// empty: FreeBSD has nobody to ask, a Linux box on plain nftables has no
// ufw.conf, a Windows probe fails for a dozen policy reasons, a hardened Mac
// refuses the tool. Before this, all of them got silence forever.
//
// The two facts that need no operating system: beacons ARRIVE (so this machine
// hears the network) and nothing has ever connected IN. Together they are the
// shape of a blocked inbound path, and this is what says so.
const LISTENING = NOW - QUIET_MS - 60_000;

describe("the silence that is evidence on any platform", () => {
  it("waits until the quiet has gone on longer than anything would have dialled in", () => {
    // A paired deck rounds every 60s and a stranger asks within 8s, so the
    // window is dozens of missed chances rather than one. Said as a number
    // because the cost of shortening it is telling somebody their network is
    // broken when it is merely quiet.
    expect(QUIET_MS).toBe(5 * 60_000);
    expect(silentInbound({ heard: 2, listeningSince: NOW - QUIET_MS + 1_000, now: NOW })).toBeNull();
    expect(silentInbound({ heard: 2, listeningSince: LISTENING, now: NOW })).not.toBeNull();
  });

  it("says nothing about a network with nobody on it", () => {
    // "Nothing has arrived" and "nothing can arrive" are the two facts this
    // whole module exists to tell apart. With no beacon in hand it is the first.
    expect(silentInbound({ heard: 0, listeningSince: LISTENING, now: NOW })).toBeNull();
  });

  it("says nothing once a connection has got in", () => {
    expect(silentInbound({ heard: 3, listeningSince: LISTENING, inbound: NOW - 1_000, now: NOW })).toBeNull();
  });

  it("says nothing about a deck that is not listening", () => {
    expect(silentInbound({ heard: 3, listeningSince: null, now: NOW })).toBeNull();
  });

  it("reports the two facts it has, and offers no command it did not read", () => {
    const v = silentInbound({ heard: 3, listeningSince: LISTENING, now: NOW });
    expect(v.blocked).toBe(true);
    expect(v.why).toBe("heard them, nothing got in");
    expect(v.text).toMatch(/hears 3 other decks/);
    expect(v.text).toMatch(/nothing has ever connected to it/);
    // It read no configuration, so it names no firewall and hands over no
    // lines: the panel draws the ways out that need no rule at all.
    expect(v.steps).toBeUndefined();
    expect(v.text).toMatch(/cannot be asked which firewall/);
  });

  it("counts one machine as one machine", () => {
    const v = silentInbound({ heard: 1, listeningSince: LISTENING, now: NOW });
    expect(v.text).toMatch(/hears another deck on the network/);
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

// ── AND THE THIRD HALF: SAYING IT WHERE SOMEBODY IS LOOKING ─────────────────
//
// Both halves above shipped, and the same afternoon kept being reported. The
// reason was not the verdict, which was right: it was drawn in exactly one
// place, inside `+ add a deck` — a dialog somebody opens only once they have
// decided the feature is broken and gone hunting for a way round it. A finding
// behind a door arrives after the conclusion it exists to prevent.
//
// So it moved to the switch, and these are the rules that keep it there: drawn
// in the panel, drawn out of ONE file rather than copied into two, pointing
// each surface at the control that surface actually has — and measured again
// when somebody presses the switch, rather than answered out of a cache filled
// while the sockets were down.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
/** Source with its comments taken out, so no rule here can be satisfied by a
 *  paragraph that describes it. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
const PANEL = strip(read("../components/LanSyncSection.tsx"));
const ADD = strip(read("../components/LanAddDeckModal.tsx"));
const SERVER = strip(read("../../server/index.mjs"));

describe("the finding is drawn where the switch is", () => {
  it("hangs under the switch, and only while the section is on", () => {
    expect(PANEL).toMatch(/<LanReachNote reach=\{status\?\.reach\} where="panel" \/>/);
    // A deck with its sockets down is not a deck anything is failing to reach,
    // so the verdict is not an answer it owes anybody yet.
    expect(PANEL).toMatch(/\{on && <LanReachNote/);
  });

  it("is one block in one file, drawn by both surfaces", () => {
    expect(ADD).toMatch(/<LanReachNote reach=\{status\.reach\} where="dialog" \/>/);
    // The failure this guards is the ordinary one: a block that is four
    // elements, a fold, a shell frame and a copy verb, maintained in two
    // voices until the two disagree about what a blocked machine should do.
    for (const [surface, src] of [["the panel", PANEL], ["the dialog", ADD]] as const) {
      expect(src, `${surface} builds the block itself`).not.toMatch(/className="ap-lan-reach"/);
      expect(src, `${surface} holds its own copy of the command frame`).not.toMatch(/ap-lan-cmd/);
    }
  });

  it("points each surface at the control that surface has", () => {
    // `below` is the dialog's word and only its: the paste field is directly
    // under the block there. In the panel the same two ways in live behind the
    // `+` in the header, so a sentence saying `below` would be the panel
    // sending a reader to look at a field that is not on the screen.
    expect(REACH_WAY_OUT.dialog).toMatch(/paste it below/);
    expect(REACH_WAY_OUT.panel).not.toMatch(/below/);
    expect(REACH_WAY_OUT.panel).toMatch(/\+/);
    // And both keep the half that stops somebody concluding the feature is
    // broken: a round is one OUTBOUND connection, so a deck nothing can reach
    // still does every part of this by dialling.
    for (const say of Object.values(REACH_WAY_OUT)) expect(say).toMatch(/dialling out/);
  });
});

describe("the press is answered by a measurement, not by a cache", () => {
  it("forgets the held verdict when somebody switches the section on", () => {
    expect(SERVER).toMatch(/function forgetReach\(\) \{ reachAt = 0; \}/);
    expect(SERVER).toMatch(/if \(body\.lan\?\.enabled === true\) forgetReach\(\);/);
  });

  it("forgets it again when the sync port lands, because the fix lines name it", () => {
    // linuxFixSteps offers the TCP line only when there is a port to name, so a
    // verdict taken before the listener had one is half an answer — and without
    // this it would be the pinned one for the next five minutes.
    const onPort = /onPort: async port => \{([\s\S]*?)\n  \},/.exec(SERVER)?.[1] ?? "";
    expect(onPort, "onPort was not found in the server source").not.toBe("");
    expect(onPort).toMatch(/forgetReach\(\)/);
  });
});
