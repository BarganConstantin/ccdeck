// On a Linux machine that does not run systemd, there is no login item to set.
//
// Alpine and Gentoo on OpenRC, Void on runit, Devuan, most containers, WSL with
// systemd off. installService wrote ~/.config/systemd/user/ccdeck.service,
// spawned `systemctl`, which was not there (ENOENT, status null), and read
// every non-zero status as "the file is on disk, systemd reads it at the next
// login" — ok: true, how: "file-only". There is no systemd to read it. The
// first start then printed "ccdeck will now start when you log in" and saved
// the item as installed, so it was never offered again, and
// `--install-service` said "It will come up at your next login". Neither
// happened.
//
// NOTHING HERE REGISTERS A LOGIN ITEM: installService is handed an `fs` that
// records what it would write and a `run` that records the command instead of
// executing it, and the systemd check is injected.
import { describe, it, expect } from "vitest";

// @ts-expect-error — plain .mjs module, no types
const { installService } = await import("../../server/login-service.mjs");

function attempt({ systemd, status = null, code = "ENOENT" }: { systemd: boolean; status?: number | null; code?: string }) {
  const written: string[] = [];
  const ran: string[] = [];
  const out = installService({
    platform: "linux", home: "/home/u",
    env: { HOME: "/home/u", PATH: "/usr/bin:/bin" },
    execPath: "/usr/bin/node", script: "/s/agent-dag.js", logPath: "/home/u/.local/state/ccdeck/deck.log",
    systemd: () => systemd,
    fs: { mkdirSync() {}, writeFileSync: (p: string) => { written.push(p); } },
    run: (file: string) => {
      ran.push(file);
      return status === null ? { status: null, error: Object.assign(new Error(`spawnSync ${file} ENOENT`), { code }) } : { status, stderr: "Failed to connect to bus" };
    },
  });
  return { out, written, ran };
}

describe("a login item on Linux without systemd", () => {
  it("is refused, not promised for the next login", () => {
    const { out } = attempt({ systemd: false });
    expect(out.ok, "the first start would say ccdeck will now start at login").toBe(false);
    expect(out.how).toBeUndefined();
    expect(out.reason).toMatch(/systemd/);
  });

  it("leaves nothing in the user unit directory, and asks no systemctl", () => {
    const { written, ran } = attempt({ systemd: false });
    expect(written.filter(p => p.includes("systemd"))).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("is still written where systemd runs and only the registration was refused", () => {
    // A user bus that is not reachable from an ssh session: systemd is there,
    // the unit is on disk, and the refusal is said rather than hidden.
    const { out, written } = attempt({ systemd: true, status: 1 });
    expect(out).toMatchObject({ ok: true, how: "file-only", reason: "Failed to connect to bus" });
    expect(written.some(p => p.endsWith("/systemd/user/ccdeck.service"))).toBe(true);
  });
});
