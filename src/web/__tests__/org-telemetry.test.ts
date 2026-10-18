// Each organization's telemetry, remembered from the one remote-settings.json a
// machine has.
//
// The file describes whichever organization's login last fetched it, and a
// claude-swap switch does not touch it, so right after a switch it still
// describes the account the user left. What is pinned here is mostly the deck
// NOT recording: a file older than the store's last change, or one fetched by a
// login that is not claude-swap's active account, is nobody's it can name.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
import { observeOrgTelemetry, resetOrgTelemetry, telemetrySummary } from "../../server/org-telemetry.mjs";
import { telemetryLine } from "../org-telemetry";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const T_SWITCH = Date.UTC(2026, 9, 18, 9, 0, 0);

let home: string;
beforeEach(() => {
  resetOrgTelemetry();
  home = mkdtempSync(join(tmpdir(), "org-telemetry-"));
  mkdirSync(join(home, ".claude"));
});
afterEach(() => rmTempDir(home));

/** claude-swap's store, its active account in `org`, last changed at T_SWITCH. */
const seq = (org = ORG) => ({
  activeAccountNumber: 2,
  lastUpdated: new Date(T_SWITCH).toISOString().replace(/\.\d+Z$/, "Z"),
  accounts: { 2: { email: "a@x.com", organizationUuid: org, organizationName: "Store Org" } },
});

/** The live login, as Claude Code's .claude.json has it. */
function liveLogin(org = ORG, name = "Acme") {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "a@x.com", organizationUuid: org, organizationName: name } }));
}

/** The organization settings Claude Code cached, written `at`. */
function remoteSettings(env: Record<string, string>, at: number) {
  const path = join(home, ".claude", "remote-settings.json");
  writeFileSync(path, JSON.stringify({ env }));
  utimesSync(path, at / 1000, at / 1000);
}

const CONTENT = {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_TOOL_DETAILS: "1",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://192.168.88.16:4317/v1/secret-path",
  OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer secret",
};

const observe = (s = seq(), now = T_SWITCH + 3_600_000) =>
  observeOrgTelemetry({ seq: s, env: {}, home, platform: "linux", now, dataDir: join(home, "deck") });

describe("what one settings file turns on", () => {
  const vars = (env: Record<string, string>) => Object.entries(env).map(([key, value]) => ({ key, value }));
  it("is content once a content flag is on beside telemetry, metrics for telemetry alone, off without it", () => {
    expect(telemetrySummary(vars({ CLAUDE_CODE_ENABLE_TELEMETRY: "Enabled", OTEL_LOG_USER_PROMPTS: "Enabled" })))
      .toMatchObject({ level: "content", content: ["OTEL_LOG_USER_PROMPTS"] });
    expect(telemetrySummary(vars({ CLAUDE_CODE_ENABLE_TELEMETRY: "Enabled", OTEL_LOG_USER_PROMPTS: "Disabled" })))
      .toMatchObject({ level: "metrics", content: [] });
    // Content flags send nothing without telemetry itself.
    expect(telemetrySummary(vars({ OTEL_LOG_USER_PROMPTS: "Enabled" }))).toMatchObject({ level: "off", content: [] });
  });
});

describe("recording an organization's settings", () => {
  it("records a file written after the store's last change, under the live login's organization", async () => {
    liveLogin();
    remoteSettings(CONTENT, T_SWITCH + 60_000);
    const records = await observe();
    expect(records[ORG]).toMatchObject({
      orgName: "Acme", level: "content",
      content: ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_TOOL_DETAILS"],
      destinations: ["http://192.168.88.16:4317"],
      seenAt: T_SWITCH + 3_600_000,
    });
    // Radar's own reading: no path, no header, on screen or on disk.
    const saved = readFileSync(join(home, "deck", "org-telemetry.json"), "utf8");
    expect(saved).not.toContain("secret");
    expect(JSON.parse(saved)[ORG].level).toBe("content");
  });

  it("does not record a file older than the store's last change: it may be the account the user left", async () => {
    liveLogin();
    remoteSettings(CONTENT, T_SWITCH - 60_000);
    expect(await observe()).toEqual({});
    remoteSettings(CONTENT, T_SWITCH);
    resetOrgTelemetry();
    expect(await observe()).toEqual({});
  });

  it("does not record a file the live login fetched for another organization than the store's", async () => {
    liveLogin(OTHER);
    remoteSettings(CONTENT, T_SWITCH + 60_000);
    expect(await observe()).toEqual({});
  });

  it("records nothing without a file, a live login or a store to pin it on", async () => {
    liveLogin();
    expect(await observe()).toEqual({});
    remoteSettings(CONTENT, T_SWITCH + 60_000);
    expect(await observe({ ...seq(), lastUpdated: "garbage" })).toEqual({});
    resetOrgTelemetry();
    expect(await observe({ ...seq(), activeAccountNumber: 9 })).toEqual({});
  });

  it("reads the file only when it changed, and keeps what it learned across restarts", async () => {
    liveLogin();
    remoteSettings(CONTENT, T_SWITCH + 60_000);
    await observe();
    // Same file, a different live login: nothing re-read, nothing lost.
    liveLogin(OTHER);
    expect((await observe())[ORG]?.level).toBe("content");
    // A restart reads the records back from disk.
    resetOrgTelemetry();
    expect((await observe())[ORG]?.level).toBe("content");
  });

  it("finds .claude.json inside a moved config directory", async () => {
    const dir = join(home, "moved");
    mkdirSync(dir);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: ORG, organizationName: "Moved" } }));
    writeFileSync(join(dir, "remote-settings.json"), JSON.stringify({ env: CONTENT }));
    utimesSync(join(dir, "remote-settings.json"), (T_SWITCH + 60_000) / 1000, (T_SWITCH + 60_000) / 1000);
    const records = await observeOrgTelemetry({ seq: seq(), env: { CLAUDE_CONFIG_DIR: dir }, home, platform: "linux", dataDir: join(home, "deck") });
    expect(records[ORG]?.orgName).toBe("Moved");
    expect(existsSync(join(home, "deck", "org-telemetry.json"))).toBe(true);
  });
});

describe("the line a row says about it", () => {
  const NOW = (T_SWITCH + 2 * 3_600_000) / 1000;
  const seen = (level: "off" | "metrics" | "content", content: string[] = []) => ({
    orgName: "Acme", level, content, destinations: ["http://192.168.88.16:4317"], seenAt: T_SWITCH,
  });

  it("names what goes out, in the warning ink once content does", () => {
    expect(telemetryLine(seen("content", ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_TOOL_DETAILS"]), NOW)).toEqual({
      text: "Telemetry · prompts, tool details",
      tone: "warn",
      detail: "Acme turns on Claude Code telemetry for new sessions: usage data, and your prompts and tool details, "
        + "sent to http://192.168.88.16:4317. Seen 2h ago, while this account was active.",
    });
    expect(telemetryLine(seen("metrics"), NOW)).toMatchObject({ text: "Telemetry · usage data", tone: "quiet" });
  });

  it("says nothing for settings seen off, or never seen", () => {
    expect(telemetryLine(seen("off"), NOW)).toBeNull();
    expect(telemetryLine(null, NOW)).toBeNull();
    expect(telemetryLine(undefined, NOW)).toBeNull();
  });
});

describe("the row", () => {
  // Rendered as the panel renders it, through the real component.
  const NOW = (T_SWITCH + 2 * 3_600_000) / 1000;
  const account = (telemetry: unknown, active = false) => ({
    num: 3, email: "a@x.com", alias: null, org: "Acme", active, disabled: false,
    lanes: [], headroom: 70, fetchedAt: T_SWITCH, nextAt: null, stale: false, error: null, telemetry,
  });
  const render = async (a: unknown) => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: AccountRow } = await import("../components/AccountRow");
    return renderToStaticMarkup(createElement(AccountRow, {
      a, nowSec: NOW, opened: false, onToggleLanes: () => {}, busy: null, pressProps: () => ({}),
      onSwitch: () => {}, menuOpen: false, onOpenMenu: () => {}, onCloseMenu: () => {}, refusal: null,
      onDismissRefusal: () => {}, switchedHere: false, swapped: null, displaced: undefined,
      issueExpanded: false, onOpenIssue: () => {},
    } as never));
  };
  const content = { orgName: "Acme", level: "content", content: ["OTEL_LOG_USER_PROMPTS"], destinations: ["http://h:4317"], seenAt: T_SWITCH };

  it("says it on a shut row, before the switch, and the door points a screen reader at it", async () => {
    const html = await render(account(content));
    expect(html).toContain('<p class="ap-telemetry" id="ap-telemetry-3" data-tone="warn" title="Acme turns on Claude Code telemetry');
    expect(html).toContain('<span aria-hidden="true">Telemetry · prompts</span>');
    expect(html).toContain('<span class="vis-hidden">Acme turns on Claude Code telemetry for new sessions: usage data, and your prompts, sent to http://h:4317.');
    expect(html).toMatch(/aria-describedby="[^"]*ap-telemetry-3/);
  });

  it("says it on the live row too, and nothing for an organization never seen or seen off", async () => {
    expect(await render(account(content, true))).toContain('id="ap-telemetry-3"');
    expect(await render(account(null))).not.toContain("ap-telemetry");
    expect(await render(account({ ...content, level: "off", content: [] }))).not.toContain("ap-telemetry");
  });
});
