import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — server module.
import { backgroundInGhostty, handoffContinued, handoffSent, HANDOFF_SENT_FOR, rememberHandoff, surfacesIdentifiable } from "../../server/ghostty-handoff.mjs";

const session = { sessionId: "f50cf7ee-156a-4830-92ad-02cbc8bbe449", cwd: "/work", provider: "claude" };
const agent = { ...session, pid: 1245, kind: "interactive" };
const answer = (stdout: string) => ({ ok: true, stdout, stderr: "" });
const GHOSTTY = "/Applications/Ghostty.app";
const IN_GHOSTTY = `1245 1244 1245 1245 ttys003 /local/bin/claude\n1244 400 1244 1245 ttys003 /usr/bin/login\n400 1 400 -1 ?? ${GHOSTTY}/Contents/MacOS/ghostty`;

/** A dictionary shaped as `sdef` prints Ghostty's: 1.4 lists `pid` and `tty`
 *  on its terminal class, 1.3.1 has the class and `perform action` only. */
const dictionary = (terminalProperties: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE dictionary SYSTEM "file://localhost/System/Library/DTDs/sdef.dtd">
<dictionary title="Ghostty Terminology">
  <suite name="Ghostty Suite" code="Ghst" description="Ghostty scripting support.">
    <class name="application" code="capp" description="The Ghostty application.">
      <element type="window" access="r"><cocoa key="scriptWindows"/></element>
      <element type="terminal" access="r"><cocoa key="terminals"/></element>
    </class>
    <class name="terminal" code="Gtrm" plural="terminals" description="An individual terminal surface.">
      <property name="id" code="ID  " type="text" access="r" description="Stable ID."/>
      <property name="name" code="pnam" type="text" access="r"><cocoa key="title"/></property>
      <property name="working directory" code="Gwdr" type="text" access="r"/>
${terminalProperties}
    </class>
    <command name="perform action" code="GhstPrfA" description="Perform a keybind action on a terminal."/>
  </suite>
</dictionary>`;
const GHOSTTY_1_4 = dictionary(`      <property name="pid" code="Gpid" type="integer" access="r" description="PID of the foreground process in this terminal."/>
      <property name="tty" code="Gtty" type="text" access="r" description="TTY device path for this terminal (e.g. /dev/ttys016)."/>`);
const GHOSTTY_1_3 = dictionary("");

type Reply = { ok: boolean; stdout: string; stderr?: string };

function setup({
  agents = [agent] as unknown[], processes = IN_GHOSTTY, sdef = answer(GHOSTTY_1_4) as Reply,
  reply = answer("sent") as Reply, mtimeMs = 1,
} = {}) {
  const exec = vi.fn(async (bin: string) => {
    if (bin === "/local/bin/claude") return answer(JSON.stringify(agents));
    if (bin === "/bin/ps") return answer(processes);
    if (bin === "/usr/bin/sdef") return sdef;
    if (bin === "/usr/bin/osascript") return reply;
    throw new Error(`unexpected ${bin}`);
  });
  const stat = vi.fn(async () => ({ mtimeMs, size: 4096 }));
  return {
    exec, stat, cache: new Map(), platform: "darwin",
    cli: () => "/local/bin/claude", resolvePath: async (p: string) => p,
  };
}
const ran = (deps: { exec: { mock: { calls: unknown[][] } } }) => deps.exec.mock.calls.map(([bin]) => bin);

describe("Ghostty background handoff", () => {
  it("sends only the Claude background shortcut and checks both identifiers", async () => {
    const deps = setup();
    expect(await backgroundInGhostty(session, deps)).toEqual({ ok: true });
    expect(ran(deps)).toEqual(["/local/bin/claude", "/bin/ps", "/usr/bin/sdef", "/usr/bin/osascript"]);
    expect(deps.exec.mock.calls[2][1]).toEqual([GHOSTTY]);
    const [bin, args] = deps.exec.mock.calls[3] as [string, string[]];
    expect(bin).toBe("/usr/bin/osascript");
    expect(args.slice(-2)).toEqual(["1244", "/dev/ttys003"]);
    expect(args[1]).toContain("(pid of matched) is not wantedPid or (tty of matched) is not wantedTty");
    expect(args[1]).toContain('perform action "csi:D" on matched');
    expect(args[1]).not.toMatch(/send key "enter"|input text/);
  });

  it("refuses ambiguous identities, a different project, and a reused non-Claude process", async () => {
    for (const deps of [
      setup({ agents: [agent, agent] }), setup({ agents: [{ ...agent, cwd: "/other" }] }),
      setup({ processes: "1245 1244 1245 1245 ttys003 /bin/zsh" }),
    ]) {
      expect(await backgroundInGhostty(session, deps)).toEqual({ ok: false, reason: "claude-not-ready" });
      expect(ran(deps)).not.toContain("/usr/bin/osascript");
      expect(ran(deps)).not.toContain("/usr/bin/sdef");
    }
  });

  it("calls a surface it cannot match, or matches twice, or that changed, a changed window", async () => {
    for (const said of ["unmatched", "ambiguous", "changed"]) {
      expect(await backgroundInGhostty(session, setup({ reply: answer(said) })), said).toEqual({ ok: false, reason: "surface-changed" });
    }
  });

  it("tells macOS's Automation refusal from any other failure", async () => {
    const denied = { ok: false, stdout: "", stderr: "execution error: Not authorized to send Apple events to Ghostty. (-1743)" };
    expect(await backgroundInGhostty(session, setup({ reply: denied }))).toEqual({ ok: false, reason: "automation-denied" });
    const code = { ok: false, stdout: "", stderr: "osascript: error (-1743)" };
    expect(await backgroundInGhostty(session, setup({ reply: code }))).toEqual({ ok: false, reason: "automation-denied" });
    for (const reply of [answer("failed"), { ok: false, stdout: "", stderr: "Can't get pid of terminal 1. (-1728)" }]) {
      expect(await backgroundInGhostty(session, setup({ reply }))).toEqual({ ok: false, reason: "failed" });
    }
  });

  it("a check makes the same lookups, reads the dictionary, and never asks Ghostty anything", async () => {
    const deps = setup();
    expect(await backgroundInGhostty(session, { ...deps, check: true })).toEqual({ ok: true });
    expect(ran(deps)).toEqual(["/local/bin/claude", "/bin/ps", "/usr/bin/sdef"]);
  });

  it("a check says no outside a Mac, outside Ghostty, and for an unknown session", async () => {
    const terminalApp = "1245 1244 1245 1245 ttys003 /local/bin/claude\n1244 400 1244 1245 ttys003 /usr/bin/login\n400 1 400 -1 ?? /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
    for (const [deps, reason] of [
      [{ ...setup(), platform: "linux" }, "not-mac"], [setup({ processes: terminalApp }), "not-ghostty"], [setup({ agents: [] }), "claude-not-ready"],
    ] as const) {
      expect(await backgroundInGhostty(session, { ...deps, check: true })).toEqual({ ok: false, reason });
      expect(ran(deps)).not.toContain("/usr/bin/osascript");
    }
  });

  it("a Ghostty without pid and tty on its terminals (1.3.1) is not offered, and nothing is sent to it", async () => {
    const checked = setup({ sdef: answer(GHOSTTY_1_3) });
    expect(await backgroundInGhostty(session, { ...checked, check: true })).toEqual({ ok: false, reason: "ghostty-unsupported" });
    const sent = setup({ sdef: answer(GHOSTTY_1_3) });
    expect(await backgroundInGhostty(session, sent)).toEqual({ ok: false, reason: "ghostty-unsupported" });
    expect(ran(sent)).toEqual(["/local/bin/claude", "/bin/ps", "/usr/bin/sdef"]);
  });

  it("a dictionary that cannot be read counts as unsupported", async () => {
    for (const sdef of [{ ok: false, stdout: "", stderr: "sdef: no scripting dictionary" }, answer("not xml")]) {
      const deps = setup({ sdef });
      expect(await backgroundInGhostty(session, deps)).toEqual({ ok: false, reason: "ghostty-unsupported" });
      expect(ran(deps)).not.toContain("/usr/bin/osascript");
    }
  });

  it("reads the dictionary once per Ghostty version, and again after an update", async () => {
    const deps = setup();
    for (let i = 0; i < 3; i++) expect(await backgroundInGhostty(session, { ...deps, check: true })).toEqual({ ok: true });
    expect(ran(deps).filter(bin => bin === "/usr/bin/sdef")).toHaveLength(1);
    expect(deps.stat).toHaveBeenCalledWith(`${GHOSTTY}/Contents/Info.plist`);
    // The bundle changed (a downgrade here): the answer is read again, and changes.
    deps.stat.mockResolvedValue({ mtimeMs: 2, size: 4096 });
    deps.exec.mockImplementation(async (bin: string) =>
      bin === "/local/bin/claude" ? answer(JSON.stringify([agent])) : bin === "/bin/ps" ? answer(IN_GHOSTTY) : answer(GHOSTTY_1_3));
    expect(await backgroundInGhostty(session, { ...deps, check: true })).toEqual({ ok: false, reason: "ghostty-unsupported" });
    expect(ran(deps).filter(bin => bin === "/usr/bin/sdef")).toHaveLength(2);
  });

  it("does not keep an answer it could not date, or a dictionary it could not read", async () => {
    const undated = setup();
    undated.stat.mockRejectedValue(new Error("ENOENT"));
    await backgroundInGhostty(session, { ...undated, check: true });
    await backgroundInGhostty(session, { ...undated, check: true });
    expect(ran(undated).filter(bin => bin === "/usr/bin/sdef")).toHaveLength(2);
    const unread = setup({ sdef: { ok: false, stdout: "", stderr: "timed out" } });
    await backgroundInGhostty(session, { ...unread, check: true });
    await backgroundInGhostty(session, { ...unread, check: true });
    expect(ran(unread).filter(bin => bin === "/usr/bin/sdef")).toHaveLength(2);
  });
});

describe("reading Ghostty's scripting dictionary", () => {
  it("needs both pid and tty on the class named terminal", () => {
    expect(surfacesIdentifiable(GHOSTTY_1_4)).toBe(true);
    expect(surfacesIdentifiable(GHOSTTY_1_3)).toBe(false);
    expect(surfacesIdentifiable(dictionary('<property name="pid" code="Gpid" type="integer"/>'))).toBe(false);
    expect(surfacesIdentifiable(dictionary('<property name="tty" code="Gtty" type="text"/>'))).toBe(false);
    expect(surfacesIdentifiable(undefined)).toBe(false);
    expect(surfacesIdentifiable("")).toBe(false);
  });

  it("reads attributes in any order and quoting, and a class-extension of terminal", () => {
    expect(surfacesIdentifiable(dictionary(`<property code='Gpid' type="integer" name='pid'/>
      <property access="r" name="tty" code="Gtty"></property>`))).toBe(true);
    const extended = GHOSTTY_1_3.replace("</suite>", `<class-extension extends="terminal" description="More > less.">
      <property type="integer" name="pid" code="Gpid"/><property name="tty" code="Gtty" type="text"/>
    </class-extension></suite>`);
    expect(surfacesIdentifiable(extended)).toBe(true);
  });

  it("does not count properties of another class, a comment, or a description that names them", () => {
    const window = GHOSTTY_1_3.replace('<class name="application"', `<class name="window" code="cwin">
      <property name="pid" code="Gpid" type="integer"/><property name="tty" code="Gtty" type="text"/>
    </class>
    <class name="application"`);
    expect(surfacesIdentifiable(window)).toBe(false);
    const commented = dictionary('<!-- <property name="pid" code="Gpid"/><property name="tty" code="Gtty"/> -->');
    expect(surfacesIdentifiable(commented)).toBe(false);
    const described = GHOSTTY_1_3.replace('description="An individual terminal surface."', `description='name="pid" name="tty" >'`);
    expect(surfacesIdentifiable(described)).toBe(false);
    // A quoted ">" or name= in the class's own attributes is read as its value.
    const quoted = GHOSTTY_1_4.replace('description="An individual terminal surface."', `description='a > b name="window"'`);
    expect(surfacesIdentifiable(quoted)).toBe(true);
    // A self-closing class first does not swallow the terminal class after it.
    const leading = GHOSTTY_1_4.replace('<class name="terminal"', '<class name="tab" code="Gtab"/>\n    <class name="terminal"');
    expect(surfacesIdentifiable(leading)).toBe(true);
  });
});

describe("a move remembered until it arrives", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("is remembered for HANDOFF_SENT_FOR, or until its continued session is found", () => {
    vi.useFakeTimers();
    const id = "0f50cf7e-156a-4830-92ad-02cbc8bbe449";
    expect(handoffSent(id)).toBe(false);
    rememberHandoff(id);
    vi.advanceTimersByTime(HANDOFF_SENT_FOR - 1);
    expect(handoffSent(id)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(handoffSent(id)).toBe(false);
    rememberHandoff(id);
    handoffContinued(id);
    expect(handoffSent(id)).toBe(false);
    expect(HANDOFF_SENT_FOR).toBeGreaterThanOrEqual(120_000);
  });
});
