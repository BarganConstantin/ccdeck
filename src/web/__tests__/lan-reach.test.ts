// Why another deck cannot reach this one.
//
// THE BUG THIS FEATURE ANSWERS was reported as "he sees me and I see nobody",
// and the shape of it is the whole reason a verdict is worth computing: the
// symptom is asymmetric, so both people conclude the wrong thing. The one who
// can see says it works; the one who cannot says the feature is broken. It is
// neither — it is one machine dropping unsolicited inbound.
//
// The cases below are grouped by what would go wrong, not by function. The
// heading is the failure; each case is the failure it prevents.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs server module, no types
import {
  PROBE_PS, fixSteps, lanNet, profileFor, readProbe, reachability, ruleCovers, workaround,
} from "../../server/lan-reach.mjs";

/** What the probe printed on the machine this was written against: wifi set to
 *  Public, Tailscale beside it, every firewall profile on, and no rule. */
const REAL = JSON.stringify({
  nets: [
    { alias: "WiFi", category: "Public", v4: "Internet" },
    { alias: "Tailscale", category: "Private", v4: "LocalNetwork" },
  ],
  profiles: [
    { name: "Domain", enabled: true },
    { name: "Private", enabled: true },
    { name: "Public", enabled: true },
  ],
  rules: [],
});

describe("a probe that came back as something other than what was expected", () => {
  it("refuses text that is not json rather than throwing into the status route", () => {
    expect(readProbe("Access is denied.")).toBeNull();
    expect(readProbe("")).toBeNull();
    expect(readProbe(undefined)).toBeNull();
  });

  it("refuses a bare array, which `typeof` calls an object", () => {
    expect(readProbe("[1,2,3]")).toBeNull();
  });

  // ConvertTo-Json collapses a one-element array to a bare object. A machine
  // with exactly one network is the common case and would otherwise read as a
  // machine with no networks at all.
  it("reads a single network that PowerShell did not wrap in an array", () => {
    const one = JSON.stringify({
      nets: { alias: "Ethernet", category: "Private", v4: "Internet" },
      profiles: { name: "Private", enabled: true },
      rules: null,
    });
    const probe = readProbe(one);
    expect(probe.nets).toHaveLength(1);
    expect(probe.nets[0].alias).toBe("Ethernet");
    expect(probe.profiles).toHaveLength(1);
    expect(probe.rules).toEqual([]);
  });

  it("drops rows missing the one field that identifies them", () => {
    const probe = readProbe(JSON.stringify({
      nets: [{ category: "Private" }, { alias: "WiFi", category: "Public", v4: "Internet" }],
      profiles: [{ enabled: true }, { name: "Public", enabled: true }],
      rules: [],
    }));
    expect(probe.nets).toHaveLength(1);
    expect(probe.profiles).toHaveLength(1);
  });
});

describe("reading the wrong profile's switch", () => {
  // A connection profile says `DomainAuthenticated`; the firewall profile it
  // answers to is called `Domain`. Getting this wrong reads some other
  // profile's `Enabled` and produces a confident wrong answer.
  it("maps every category spelling onto the profile that governs it", () => {
    expect(profileFor("Public")).toBe("Public");
    expect(profileFor("Private")).toBe("Private");
    expect(profileFor("DomainAuthenticated")).toBe("Domain");
    expect(profileFor("Domain")).toBe("Domain");
  });

  it("has no opinion about a category it does not recognise", () => {
    expect(profileFor("")).toBeNull();
    expect(profileFor(undefined)).toBeNull();
    expect(profileFor("Guest")).toBeNull();
  });
});

describe("blaming the wrong network on a machine that has several", () => {
  const nets = readProbe(REAL).nets;

  // The machine this was written on has Tailscale at metric 5 and wifi at 30,
  // and Tailscale's profile is Private while the wifi carrying the LAN is
  // Public. Picking by anything other than where the deck's own addresses live
  // reads Tailscale's category and reports no problem.
  it("picks the interface the deck's own addresses are on", () => {
    expect(lanNet(nets, ["WiFi"]).category).toBe("Public");
    expect(lanNet(nets, ["Tailscale"]).category).toBe("Private");
  });

  it("matches an alias whatever case it was written in", () => {
    expect(lanNet(nets, ["wifi"]).alias).toBe("WiFi");
  });

  it("falls back to the first connected network when no alias is known", () => {
    expect(lanNet(nets, []).alias).toBe("WiFi");
  });

  it("skips a disconnected profile rather than reporting on it", () => {
    const rows = [{ alias: "Ethernet", category: "Private", v4: "Disconnected" }, ...nets];
    expect(lanNet(rows, []).alias).toBe("WiFi");
  });

  it("answers null for a machine with no profiles at all", () => {
    expect(lanNet([], [])).toBeNull();
  });
});

describe("a rule that is present but does not apply", () => {
  const allow = (over = {}) =>
    [{ direction: "Inbound", action: "Allow", enabled: true, profile: "Private", ...over }];

  it("counts a rule on the profile in force", () => {
    expect(ruleCovers(allow(), "Private")).toBe(true);
  });

  // The whole defect this guards: a rule written for Private on a machine
  // sitting on a Public network changes nothing, and reporting it as cover
  // sends somebody looking at the wrong thing for the rest of the evening.
  it("does not count a rule scoped to a profile that is not in force", () => {
    expect(ruleCovers(allow(), "Public")).toBe(false);
  });

  it("counts `Any`, which is how Windows spells every profile", () => {
    expect(ruleCovers(allow({ profile: "Any" }), "Public")).toBe(true);
  });

  it("reads the comma-joined list Windows writes for two profiles", () => {
    expect(ruleCovers(allow({ profile: "Domain, Private" }), "Private")).toBe(true);
  });

  it("ignores a rule that is disabled, outbound, or a block", () => {
    expect(ruleCovers(allow({ enabled: false }), "Private")).toBe(false);
    expect(ruleCovers(allow({ direction: "Outbound" }), "Private")).toBe(false);
    expect(ruleCovers(allow({ action: "Block" }), "Private")).toBe(false);
  });
});

describe("the verdict", () => {
  const probe = readProbe(REAL);
  const exePath = "C:\\Program Files\\nodejs\\node.exe";

  it("reproduces the machine the bug was reported from", () => {
    const v = reachability({ platform: "win32", probe, aliases: ["WiFi"], exePath });
    expect(v.blocked).toBe(true);
    expect(v.category).toBe("Public");
    expect(v.alias).toBe("WiFi");
  });

  // Silence rather than a hedge. A line that says "possibly" about something
  // it did not measure is worse than no line, and every other platform is a
  // thing this module did not measure.
  it("has no opinion anywhere but Windows", () => {
    expect(reachability({ platform: "darwin", probe, aliases: ["en0"], exePath })).toBeNull();
    expect(reachability({ platform: "linux", probe, exePath })).toBeNull();
  });

  it("has no opinion when the probe did not come back", () => {
    expect(reachability({ platform: "win32", probe: null, exePath })).toBeNull();
  });

  it("has no opinion about a network whose category it cannot map", () => {
    const odd = readProbe(JSON.stringify({
      nets: [{ alias: "WiFi", category: "Guest", v4: "Internet" }],
      profiles: [{ name: "Public", enabled: true }],
      rules: [],
    }));
    expect(reachability({ platform: "win32", probe: odd, aliases: ["WiFi"], exePath })).toBeNull();
  });

  // Sending somebody to add a rule to a firewall that is switched off is an
  // instruction that changes nothing and costs their trust in the next one.
  it("clears a machine whose firewall is off rather than blaming it", () => {
    const off = readProbe(JSON.stringify({
      nets: [{ alias: "WiFi", category: "Public", v4: "Internet" }],
      profiles: [{ name: "Public", enabled: false }],
      rules: [],
    }));
    const v = reachability({ platform: "win32", probe: off, aliases: ["WiFi"], exePath });
    expect(v.blocked).toBe(false);
    expect(v.why).toBe("firewall off");
  });

  it("clears a machine that already holds a rule", () => {
    const ok = readProbe(JSON.stringify({
      nets: [{ alias: "WiFi", category: "Private", v4: "Internet" }],
      profiles: [{ name: "Private", enabled: true }],
      rules: [{ direction: "Inbound", action: "Allow", enabled: true, profile: "Private" }],
    }));
    const v = reachability({ platform: "win32", probe: ok, aliases: ["WiFi"], exePath });
    expect(v.blocked).toBe(false);
    expect(v.why).toBe("rule present");
  });

  it("says which half is broken, because the other half is the way out", () => {
    const v = reachability({ platform: "win32", probe, aliases: ["WiFi"], exePath });
    expect(v.text).toContain("hear");
  });
});

describe("the command somebody is asked to paste", () => {
  const exePath = "C:\\Program Files\\nodejs\\node.exe";

  it("offers the category line only where the network is Public", () => {
    const pub = fixSteps({ category: "Public", alias: "WiFi", exePath });
    expect(pub).toHaveLength(2);
    expect(pub[0]).toContain("Set-NetConnectionProfile");
    expect(fixSteps({ category: "Private", alias: "WiFi", exePath })).toHaveLength(1);
  });

  // The sync listener's port is ephemeral and is a different number after
  // every restart, so a rule written against a port works once. Scoping to the
  // program also covers the discovery socket, which is the other half.
  it("scopes the rule to the program rather than to a port", () => {
    const [rule] = fixSteps({ category: "Private", alias: "WiFi", exePath });
    expect(rule).toContain("-Program");
    expect(rule).not.toContain("LocalPort");
    expect(rule).toContain(exePath);
  });

  it("asks for inbound only, and never for a block", () => {
    const [rule] = fixSteps({ category: "Private", alias: "WiFi", exePath });
    expect(rule).toContain("-Direction Inbound");
    expect(rule).toContain("-Action Allow");
  });
});

describe("the module's refusal to act", () => {
  // relay-guard.test.ts pins the same property by reading its own module's
  // source, on the reasoning that "we would notice" is not a control. The
  // reasoning is identical here: one route in this server that can elevate
  // hands every local process a way to raise a password prompt wearing
  // ccdeck's name.
  it("hands back a command as text and never a promise to run it", () => {
    const steps = fixSteps({ category: "Public", alias: "WiFi", exePath: "node.exe" });
    for (const s of steps) expect(typeof s).toBe("string");
  });

  it("asks Windows only for things an ordinary user may read", () => {
    // Measured on Windows 11 26200 as a non-elevated user: these three answer,
    // and Get-NetFirewallPortFilter returns "Access is denied".
    expect(PROBE_PS).toContain("Get-NetConnectionProfile");
    expect(PROBE_PS).toContain("Get-NetFirewallProfile");
    expect(PROBE_PS).toContain("Get-NetFirewallApplicationFilter");
    expect(PROBE_PS).not.toContain("Get-NetFirewallPortFilter");
  });

  it("never spells a verb that would change the machine", () => {
    for (const verb of ["New-NetFirewallRule", "Set-NetConnectionProfile", "Set-NetFirewallProfile"]) {
      expect(PROBE_PS).not.toContain(verb);
    }
  });

  // The program is passed through the environment rather than pasted into the
  // script, so a path with a quote in it cannot close the string it sits in.
  it("passes the program path through the environment, not into the script", () => {
    expect(PROBE_PS).toContain("$env:CCDECK_EXE");
  });
});

describe("the way out that needs no rule at all", () => {
  it("says nothing when nothing is blocked", () => {
    expect(workaround(false)).toBeNull();
  });

  // A round is one outbound connection: roundWith dials, both sides prove
  // themselves over that socket, and the manifest rides it home. So the
  // blocked machine is not stuck — it just has to be the one that calls.
  it("names both controls that make this deck dial first", () => {
    const w = workaround(true);
    expect(w.invite).toMatch(/paste/i);
    expect(w.address).toMatch(/address/i);
  });

  // An invite carries the addresses of the deck that MINTED it, and is dialled
  // by the deck that PASTES it. So the blocked machine minting one is asking to
  // be called, which is the one thing it cannot receive. Same two controls,
  // opposite order, and only one order works.
  it("says which end must mint the invite, because only one order works", () => {
    expect(workaround(true).invite).toMatch(/them .*make|make the invite/i);
    expect(workaround(true).invite).toMatch(/pasted on this machine|paste it here/i);
  });
});

describe("picking the interface the beacon actually leaves by", () => {
  // The machine this was written on: Tailscale is Private and at a lower
  // metric, wifi is Public and is where 255.255.255.255 goes. Matching aliases
  // as an unordered set reported Tailscale's Private and cleared a machine
  // that was blocked — a confident wrong answer, which is the worst kind.
  it("walks the aliases in the order the caller gave them", () => {
    const nets = readProbe(REAL).nets;
    expect(lanNet(nets, ["Tailscale", "WiFi"]).category).toBe("Private");
    expect(lanNet(nets, ["WiFi", "Tailscale"]).category).toBe("Public");
  });

  it("skips an alias the probe never reported and takes the next", () => {
    const nets = readProbe(REAL).nets;
    expect(lanNet(nets, ["", "Ethernet", "WiFi"]).alias).toBe("WiFi");
  });

  it("puts the broadcast route ahead of the deck's own interfaces", () => {
    const probe = readProbe(JSON.stringify({
      ...JSON.parse(REAL),
      bcast: "WiFi",
    }));
    const v = reachability({
      platform: "win32", probe,
      // Deliberately the wrong order: Tailscale is Private and would clear it.
      aliases: ["Tailscale", "WiFi"],
      exePath: "node.exe",
    });
    expect(v.blocked).toBe(true);
    expect(v.alias).toBe("WiFi");
  });

  it("still answers when the routing read came back empty", () => {
    const probe = readProbe(JSON.stringify({ ...JSON.parse(REAL), bcast: "" }));
    const v = reachability({ platform: "win32", probe, aliases: ["WiFi"], exePath: "node.exe" });
    expect(v.blocked).toBe(true);
    expect(v.alias).toBe("WiFi");
  });
});
