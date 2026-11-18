// V4's engine install card (Figma "Engine install"): which of the
// install card's states the stage draws for the deck's status, and the small
// words the card and Settings print. The deck's side (download, checks, lock,
// recovery, routes) is engine-install.test.ts.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { engineView, speedOf, type EngineInstall, type ViewInput } from "../use-engine-install";
import { engineStatusOf, mb, olderVersion, platformLabel, type EngineStatus } from "../engine-install-api";
import EngineCard, { bytesLine, engineCardCode } from "../components/terminal/EngineCard";
import { resetLanguageForTest, t, type TFunction } from "../i18n";

// The card reads the deck's status through its hook; drawn here server-side,
// the hook hands it the status a test sets, and the rest of the module is real.
const held = vi.hoisted(() => ({ install: null as unknown }));
vi.mock("../use-engine-install", async (orig) => ({
  ...(await orig<typeof import("../use-engine-install")>()),
  useEngineInstall: () => held.install,
}));

const T = t as TFunction;

function status(over: Partial<EngineStatus> = {}): EngineStatus {
  return {
    platform: "linux-x64", app: "3.82.2", fixPath: "~/.ccdeck", supported: true, blocked: null, canInstallFile: true,
    installed: null, present: false, pinned: "0.4.0", job: null, last: null, recovered: false, elsewhere: false,
    ...over,
  };
}

const view = (over: Partial<ViewInput>) => engineView({ status: status(), mine: null, watched: new Set(), ...over });

beforeEach(() => resetLanguageForTest());

describe("which state the install card draws", () => {
  it("waits while the deck has not said, and keeps the old card where it cannot say", () => {
    expect(view({ status: undefined }).state).toBe("checking");
    expect(view({ status: null }).state).toBe("plain");
  });

  it("asks before it downloads anything, and says when the download is off", () => {
    expect(view({})).toEqual({ state: "ask", download: true, file: true, downloadOff: false });
    expect(view({ status: status({ blocked: "download-disabled" }) })).toEqual({ state: "ask", download: false, file: true, downloadOff: true });
  });

  it("says unavailable, never Install, while no signed engine is published or no key is built in", () => {
    for (const blocked of ["no-keys", "not-published", "unsupported"] as const) {
      expect(view({ status: status({ blocked }) }), blocked).toEqual({ state: "unavailable", file: true });
    }
  });

  it("draws this tab's install as its progress, another tab's as elsewhere", () => {
    const job = { id: "j1", phase: "downloading" as const, received: 10, total: 100, source: "download" as const, startedAt: 1 };
    expect(view({ status: status({ job }), mine: "j1" })).toEqual({ state: "downloading", job });
    expect(view({ status: status({ job: { ...job, phase: "verifying" } }), mine: "j1" }).state).toBe("verifying");
    expect(view({ status: status({ job: { ...job, phase: "installing" } }), mine: "j1" }).state).toBe("verifying");
    expect(view({ status: status({ job }), mine: "other" })).toEqual({ state: "elsewhere", job });
    expect(view({ status: status({ elsewhere: true }) })).toEqual({ state: "elsewhere", job: null });
  });

  it("reads an install's outcome only when this tab watched it", () => {
    const last = { id: "j1", outcome: "failed" as const, code: "no-space" as const, step: "installing" as const };
    expect(view({ status: status({ last }), watched: new Set(["j1"]) }).state).toBe("no-space");
    expect(view({ status: status({ last }), watched: new Set() }).state, "someone else's outcome is not ours to show").toBe("ask");
  });

  it("maps each failure to its own card", () => {
    const failed = (code: string, extra: Record<string, unknown> = {}) =>
      view({ status: status({ last: { id: "j", outcome: "failed", code, step: "downloading", ...extra } as EngineStatus["last"] }), watched: new Set(["j"]) });
    expect(failed("offline", { received: 5, total: 50 })).toEqual({ state: "offline", received: 5, total: 50 });
    expect(failed("offline")).toEqual({ state: "offline", received: 0, total: null });
    expect(failed("no-permission")).toEqual({ state: "permission", fixPath: "~/.ccdeck" });
    expect(failed("check-failed")).toEqual({ state: "check", code: "check-failed", step: "downloading" });
    expect(failed("wrong-machine").state).toBe("check");
    expect(failed("downgrade").state).toBe("check");
    expect(failed("unsafe-folder"), "a folder above the engine, not the signature").toEqual({ state: "folder", install: true });
    expect(failed("not-published")).toEqual({ state: "unavailable", file: true });
    expect(failed("elsewhere")).toEqual({ state: "elsewhere", job: null });
    expect(failed("failed")).toEqual({ state: "failed", step: "downloading" });
  });

  it("says ready once an install this tab watched is done, and that the start failed if the panel is refused again", () => {
    const last = { id: "j", outcome: "done" as const, version: "0.4.0" };
    expect(view({ status: status({ last }), watched: new Set(["j"]) })).toEqual({ state: "ready", version: "0.4.0" });
    expect(view({ status: status({ last }), watched: new Set(["j"]), retried: true }).state).toBe("start-failed");
  });

  it("offers the update where the installed engine is older than the one this app pins", () => {
    const installed = { version: "0.3.1", bytes: 9_000_000 };
    expect(view({ status: status({ installed, present: true }) })).toEqual({ state: "update", installed: "0.3.1", pinned: "0.4.0", download: true, file: true });
    expect(view({ status: status({ installed: { ...installed, version: "0.4.0" }, present: true }) })).toEqual({ state: "ready", version: "0.4.0" });
    expect(view({ status: status({ installed, recovered: true }) })).toEqual({ state: "recovered", version: "0.3.1" });
    expect(view({ status: status({ installed }), code: "failed" }).state).toBe("start-failed");
  });

  it("says unsupported for a machine with no engine, whatever else is set", () => {
    expect(view({ status: status({ supported: false }) }).state).toBe("unsupported");
    expect(view({ code: "unsupported" }).state).toBe("unsupported");
  });

  it("says a folder above the engine is why for the panel's unsafe-folder, never Install, until an engine verifies again", () => {
    expect(view({ code: "unsafe-folder" })).toEqual({ state: "folder", install: false });
    expect(view({ code: "unsafe-folder", status: status({ present: true }) })).toEqual({ state: "folder", install: false });
    expect(view({ code: "unsafe-folder", status: status({ blocked: "download-disabled" }) })).toEqual({ state: "folder", install: false });
    // Put right in the meantime: the engine verifies, and the stage asks again.
    expect(view({ code: "unsafe-folder", status: status({ installed: { version: "0.4.0", bytes: 1 }, present: true }) })).toEqual({ state: "ready", version: "0.4.0" });
  });
});

describe("the card's words", () => {
  it("draws the card only for the codes the engine names", () => {
    for (const code of ["not-installed", "not-verified", "unsafe-folder", "unsupported", "failed"]) expect(engineCardCode(code), code).toBe(true);
    for (const code of [undefined, null, "", "exists", "full", "agent-missing"]) expect(engineCardCode(code), String(code)).toBe(false);
  });

  it("names the platform as a person would", () => {
    expect(platformLabel("darwin-arm64")).toBe("macOS · Apple silicon");
    expect(platformLabel("darwin-x64")).toBe("macOS · Intel");
    expect(platformLabel("linux-x64")).toBe("Linux · x64");
    expect(platformLabel("linux-arm64")).toBe("Linux · ARM64");
    expect(platformLabel("win32-x64")).toBe("Windows · x64");
    expect(platformLabel("freebsd")).toBe("freebsd");
  });

  it("compares versions by number, a pre-release before its release, anything unreadable as not older", () => {
    expect(olderVersion("0.3.9", "0.4.0")).toBe(true);
    expect(olderVersion("0.10.0", "0.9.0")).toBe(false);
    expect(olderVersion("1.0.0-rc.1", "1.0.0")).toBe(true);
    expect(olderVersion("1.0.0", "1.0.0")).toBe(false);
    expect(olderVersion("1.0", "1.0.1")).toBe(false);
    expect(olderVersion(null, "1.0.0")).toBe(false);
  });

  it("prints megabytes, the speed once it is known, and the time left", () => {
    expect(mb(1_250_000)).toBe("1.3");
    expect(bytesLine(T, 2_000_000, 10_000_000, null)).not.toMatch(/MB\/s/);
    expect(bytesLine(T, 2_000_000, 10_000_000, null)).toContain("2.0");
    expect(bytesLine(T, 2_000_000, 10_000_000, null)).toContain("10.0");
    const fast = bytesLine(T, 2_000_000, 10_000_000, 1_000_000);
    expect(fast.split(" · ").length, "bytes · speed · time left").toBe(3);
    expect(fast).toContain("1.0");
    expect(bytesLine(T, 2_000_000, null, 1_000_000).split(" · ").length, "no total, no time left").toBe(2);
  });

  it("measures speed over at least half a second", () => {
    expect(speedOf([])).toBeNull();
    expect(speedOf([{ at: 0, received: 0 }, { at: 200, received: 1000 }])).toBeNull();
    expect(speedOf([{ at: 0, received: 0 }, { at: 1000, received: 500_000 }, { at: 2000, received: 2_000_000 }])).toBe(1_000_000);
  });

  it("reads only the status fields it knows, and nothing from a malformed answer", () => {
    expect(engineStatusOf(null)).toBeNull();
    expect(engineStatusOf({ platform: "linux-x64" })).toBeNull();
    const s = engineStatusOf({ platform: "linux-x64", supported: true, blocked: "no-keys", installed: { version: "0.4.0", bytes: 7 }, job: { id: "j", phase: "downloading" } })!;
    expect(s.blocked).toBe("no-keys");
    expect(s.installed).toEqual({ version: "0.4.0", bytes: 7 });
    expect(s.job).toEqual({ id: "j", phase: "downloading", received: 0, total: null, source: "download", startedAt: 0 });
    expect(s.canInstallFile).toBe(false);
  });
});

describe("the card for a folder above the engine", () => {
  /** The card as the stage draws it for `code`, over the install `over` says. */
  function card(over: Partial<EngineInstall>, code = "not-installed"): string {
    held.install = {
      status: status(), mine: null, watched: new Set<string>(), speed: null, pending: false, refused: null,
      refresh: async () => null, install: async () => {}, installFile: async () => {}, cancel: async () => {}, remove: async () => true,
      ...over,
    } satisfies EngineInstall;
    return renderToStaticMarkup(createElement(EngineCard, { code, message: "", onRetry: () => {}, onNotNow: () => {}, plain: null }));
  }

  // The page used to say the file did not match ccdeck's signature, with the
  // Signature step marked failed, when the check that failed was a folder's.
  it("says the folder, not the signature, after an install this tab watched and for the panel's own refusal", () => {
    const last = { id: "j", outcome: "failed" as const, code: "unsafe-folder" as const, step: "verify", at: 1 };
    for (const html of [card({ status: status({ last }), watched: new Set(["j"]) }), card({}, "unsafe-folder")]) {
      expect(html).toContain('data-engine="folder"');
      expect(html).toContain(T("board.engine.folderTitle"));
      expect(html).toContain(T("board.engine.folderBody"));
      expect(html).not.toContain(T("board.engine.checkBody"));
      expect(html).not.toContain(T("board.engine.stepSignature"));
      expect(html).not.toContain(T("board.engine.install"));
      expect(html).toContain(T("board.stage.tryAgain"));
      expect(html).toContain(T("board.engine.back"));
    }
  });

  it("still blames the signature for a check that was the signature's", () => {
    const last = { id: "j", outcome: "failed" as const, code: "check-failed" as const, step: "verify", at: 1 };
    const html = card({ status: status({ last }), watched: new Set(["j"]) });
    expect(html).toContain(T("board.engine.checkBody"));
    expect(html).not.toContain(T("board.engine.folderBody"));
  });
});
