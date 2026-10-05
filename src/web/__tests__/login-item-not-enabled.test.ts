// A Linux login item whose `systemctl --user enable` failed is not a login item.
//
// installService writes the unit and then registers it; when the registration
// is refused it still reports `ok` with `how: "file-only"`, because the file is
// on disk. That is true of launchd, which loads every plist in
// ~/Library/LaunchAgents at the next login whether `launchctl load` worked or
// not. It is not true of systemd, which starts at login only a user unit that
// is ENABLED — the link in default.target.wants/ that the failed enable never
// made. `--install-service` nevertheless said "starts when you log in" and "It
// will come up at your next login", and nothing ever started it.
//
// Driven through the real `--install-service` with the service manager stood
// in for: installService runs as written, with a `run` that refuses, so no
// unit is written and nothing is registered on the machine running the suite.
import { describe, it, expect, vi, beforeEach } from "vitest";

const world = vi.hoisted(() => ({ platform: "linux" }));

vi.mock("../../server/login-service.mjs", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const real = await importOriginal<any>();
  return {
    ...real,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    installService: (job: any) => real.installService({
      ...job,
      platform: world.platform,
      home: "/home/x",
      env: { HOME: "/home/x", PATH: "/usr/bin" },
      fs: { mkdirSync() {}, writeFileSync() {} },
      run: () => ({ status: 1, stderr: "Failed to connect to bus: No medium found" }),
      systemd: () => true,
    }),
    writeServiceRecord: () => true,
    lingerState: () => "on",
  };
});

// @ts-expect-error — plain JS module, no types
const { loginItemCommand } = await import("../../../bin/cli/login-item.js");
// The module as written, for the verdict itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { installService, SERVICE_LABEL } = await vi.importActual<any>("../../server/login-service.mjs");
// @ts-expect-error — plain .mjs module, no types
const { palette, glyphs } = await import("../../server/term.mjs");

/** What `--install-service` prints, with the service manager refusing. */
async function installServiceSays(): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const g = glyphs(true);
  const code = await loginItemCommand({ installService: true }, {
    say: (l: string) => lines.push(l), tone: palette("none"),
    dash: g.dash, gOk: g.ok, gWarn: g.warn, bullet: g.bullet,
    deckDataDir: () => "/home/x/.local/state/ccdeck", deckLogDir: () => "/home/x/.local/state/ccdeck/logs",
  });
  return { code, text: lines.join("\n") };
}

describe("a login item systemd did not enable", () => {
  beforeEach(() => { world.platform = "linux"; });

  it("says it was written but not enabled, and how to enable it", async () => {
    const { text } = await installServiceSays();
    expect(text).toContain("not enabled");
    expect(text).toContain(`systemctl --user enable ${SERVICE_LABEL}.service`);
    expect(text).toContain("Failed to connect to bus");
    expect(text).not.toContain("starts when you log in");
    expect(text).not.toContain("next login");
  });

  it("is told apart from a launchd item, which does come up at the next login", async () => {
    world.platform = "darwin";
    const { text } = await installServiceSays();
    expect(text).toContain("starts when you log in");
    expect(text).toContain("It will come up at your next login.");
    expect(text).not.toContain("systemctl");
  });

  it("carries the command that enables it in the verdict, on Linux only", () => {
    const refused = { status: 1, stderr: "Failed to connect to bus" };
    const job = {
      home: "/home/x", env: { HOME: "/home/x" }, script: "/s/agent-dag.js", logPath: "/home/x/deck.log",
      fs: { mkdirSync() {}, writeFileSync() {} }, run: () => refused, systemd: () => true,
    };
    expect(installService({ ...job, platform: "linux" }))
      .toMatchObject({ ok: true, how: "file-only", enable: `systemctl --user enable ${SERVICE_LABEL}.service` });
    expect(installService({ ...job, platform: "darwin" })).not.toHaveProperty("enable");
  });
});
