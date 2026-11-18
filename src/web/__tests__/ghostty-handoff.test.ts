import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — server module.
import { backgroundInGhostty } from "../../server/ghostty-handoff.mjs";

const session = { sessionId: "f50cf7ee-156a-4830-92ad-02cbc8bbe449", cwd: "/work", provider: "claude" };
const agent = { ...session, pid: 1245, kind: "interactive" };
const answer = (stdout: string) => ({ ok: true, stdout });

function setup(agents = [agent], process = "1245 1244 1245 1245 ttys003 /local/bin/claude\n1244 400 1244 1245 ttys003 /usr/bin/login\n400 1 400 -1 ?? /Applications/Ghostty.app/Contents/MacOS/ghostty", reply = "sent") {
  const exec = vi.fn()
    .mockResolvedValueOnce(answer(JSON.stringify(agents)))
    .mockResolvedValueOnce(answer(process))
    .mockResolvedValueOnce(answer(reply));
  return { exec, platform: "darwin", cli: () => "/local/bin/claude", resolvePath: async (p: string) => p };
}

describe("Ghostty background handoff", () => {
  it("sends only the Claude background shortcut and checks both identifiers", async () => {
    const deps = setup();
    expect(await backgroundInGhostty(session, deps)).toBe(true);
    const [bin, args] = deps.exec.mock.calls[2];
    expect(bin).toBe("/usr/bin/osascript");
    expect(args.slice(-2)).toEqual(["1244", "/dev/ttys003"]);
    expect(args[1]).toContain("(pid of matched) is not wantedPid or (tty of matched) is not wantedTty");
    expect(args[1]).toContain('perform action "csi:D" on matched');
    expect(args[1]).not.toMatch(/send key "enter"|input text/);
  });

  it("refuses ambiguous identities, a different project, and a reused non-Claude process", async () => {
    for (const deps of [setup([agent, agent]), setup([{ ...agent, cwd: "/other" }]), setup([agent], "1245 1244 1245 1245 ttys003 /bin/zsh")]) {
      expect(await backgroundInGhostty(session, deps)).toBe(false);
      expect(deps.exec.mock.calls.some(([bin]) => bin === "/usr/bin/osascript")).toBe(false);
    }
  });

  it("does not report success if Ghostty cannot match the surface", async () => {
    expect(await backgroundInGhostty(session, setup([agent], undefined, "unmatched"))).toBe(false);
  });

  it("a check makes the same lookups and never asks Ghostty anything", async () => {
    const deps = setup();
    expect(await backgroundInGhostty(session, { ...deps, check: true })).toBe(true);
    expect(deps.exec.mock.calls.map(([bin]) => bin)).toEqual(["/local/bin/claude", "/bin/ps"]);
  });

  it("a check says no outside a Mac, outside Ghostty, and for an unknown session", async () => {
    const terminalApp = "1245 1244 1245 1245 ttys003 /local/bin/claude\n1244 400 1244 1245 ttys003 /usr/bin/login\n400 1 400 -1 ?? /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal";
    for (const deps of [{ ...setup(), platform: "linux" }, setup([agent], terminalApp), setup([])]) {
      expect(await backgroundInGhostty(session, { ...deps, check: true })).toBe(false);
      expect(deps.exec.mock.calls.some(([bin]) => bin === "/usr/bin/osascript")).toBe(false);
    }
  });
});
