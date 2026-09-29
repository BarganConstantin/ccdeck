// #1311, the page's half: which of the route's lines is an incident worth a
// mark, what the topbar chip, the usage panel's line and the tray's row say,
// and what they link to.
//
// The rules pinned here are the acceptance criteria stated as behaviour: an
// operational provider draws nothing; an unreachable page draws nothing; a
// stale incident says so in words and dates itself; an answer too old to be
// about now is not drawn at all; and every mark opens the provider's status
// page and nothing else.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { incidentOf, incidentsOf, INCIDENT_EXPIRE_MS, safeStatusPage, type ProviderStatus } from "../provider-status";
import { IncidentChips, QuotaIncident } from "../components/ProviderIncidents";
import { ClaudeQuotaSection, CodexQuotaSection } from "../components/QuotaSections";
import { sourceOf } from "./client-source";
// @ts-expect-error — plain JS module, no types
import { statusWorthAsking, trayMenuItems } from "../../../desktop/tray-menu.mjs";

const NOW = 1_790_662_000_000;

function line(over: Partial<ProviderStatus> = {}): ProviderStatus {
  return {
    provider: "claude", state: "partial_outage", summary: null, components: ["Claude Code"],
    checkedAt: NOW - 60_000, stale: false, statusPageUrl: "https://status.claude.com", ...over,
  };
}

describe("which lines are an incident", () => {
  it("draws nothing for an operational provider, or one whose page never answered", () => {
    expect(incidentOf(line({ state: "operational", components: [] }), NOW)).toBeNull();
    expect(incidentOf(line({ state: "unknown", checkedAt: null }), NOW)).toBeNull();
  });

  it("says each incident state in words", () => {
    const words: [ProviderStatus["state"], string][] = [
      ["degraded", "degraded performance"],
      ["partial_outage", "partial outage"],
      ["major_outage", "major outage"],
      ["maintenance", "maintenance"],
    ];
    for (const [state, w] of words) {
      expect(incidentOf(line({ state }), NOW)?.label, state).toBe(`Claude · ${w}`);
    }
    expect(incidentOf(line({ provider: "codex", statusPageUrl: "https://status.openai.com" }), NOW)?.label)
      .toBe("Codex · partial outage");
  });

  it("draws nothing for a state or a provider this build has no words for", () => {
    expect(incidentOf(line({ state: "on_fire" as ProviderStatus["state"] }), NOW)).toBeNull();
    expect(incidentOf(line({ state: "constructor" as ProviderStatus["state"] }), NOW)).toBeNull();
    expect(incidentOf(line({ provider: "toString" as ProviderStatus["provider"] }), NOW)).toBeNull();
  });

  it("dates a stale incident in the label and says why in the detail", () => {
    const i = incidentOf(line({ stale: true, checkedAt: NOW - 12 * 60_000 }), NOW)!;
    expect(i.stale).toBe(true);
    expect(i.asOf).toMatch(/\d/);
    expect(i.label).toBe(`Claude · partial outage · as of ${i.asOf}`);
    expect(i.detail).toContain(`status.claude.com has not answered since ${i.asOf}`);
    expect(i.detail).not.toContain("checked");
  });

  it("says how fresh a live incident is, and never dates it", () => {
    const i = incidentOf(line({ checkedAt: NOW - 4 * 60_000 }), NOW)!;
    expect(i.asOf).toBeNull();
    expect(i.detail).toContain("Reported by status.claude.com, checked 4 min ago");
  });

  it("stops drawing an answer the page is still holding once it is too old to be about now", () => {
    expect(incidentOf(line({ checkedAt: NOW - INCIDENT_EXPIRE_MS }), NOW)).not.toBeNull();
    expect(incidentOf(line({ checkedAt: NOW - INCIDENT_EXPIRE_MS - 1 }), NOW)).toBeNull();
    expect(incidentOf(line({ stale: true, checkedAt: NOW - INCIDENT_EXPIRE_MS - 1 }), NOW)).toBeNull();
  });

  it("names the incident when the page did, and the components when it did not", () => {
    expect(incidentOf(line({ summary: "Elevated errors for multiple models" }), NOW)?.what).toBe("Elevated errors for multiple models");
    expect(incidentOf(line({ components: ["Codex API", "CLI"] }), NOW)?.what).toBe("Codex API, CLI");
    expect(incidentOf(line({ components: [] }), NOW)?.what).toBeNull();
  });

  it("links to a status page and nowhere else", () => {
    expect(incidentOf(line(), NOW)?.href).toBe("https://status.claude.com/");
    for (const url of ["http://status.claude.com", "https://evil.example", "javascript:alert(1)", "file:///etc/passwd", "https://status.claude.com.evil.example", "", null]) {
      expect(safeStatusPage(url), String(url)).toBeNull();
      expect(incidentOf(line({ statusPageUrl: url as string }), NOW), String(url)).toBeNull();
    }
  });

  it("reads nothing out of a report that is off, failed or malformed", () => {
    const providers = [line()];
    expect(incidentsOf({ ok: true, disabled: false, providers }, NOW)).toHaveLength(1);
    expect(incidentsOf({ ok: true, disabled: true, providers }, NOW)).toEqual([]);
    expect(incidentsOf({ ok: false, disabled: false, providers }, NOW)).toEqual([]);
    expect(incidentsOf(null, NOW)).toEqual([]);
    expect(incidentsOf({ ok: true, disabled: false, providers: "nope" } as never, NOW)).toEqual([]);
  });
});

describe("the topbar chip", () => {
  const html = (lines: ProviderStatus[]) =>
    renderToStaticMarkup(createElement(IncidentChips, { incidents: incidentsOf({ ok: true, disabled: false, providers: lines }, NOW) }));

  it("adds nothing at all while the providers are fine", () => {
    expect(html([line({ state: "operational" }), line({ provider: "codex", state: "unknown", checkedAt: null })])).toBe("");
  });

  it("is a link to the status page, in a new tab that learns nothing of the deck", () => {
    const out = html([line()]);
    expect(out).toContain('href="https://status.claude.com/"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('aria-label="Claude · partial outage. Opens status.claude.com in a new tab"');
    expect(out).toContain('data-state="partial_outage"');
    expect(out).toContain('class="provider-incident"');
    expect(out).toContain(">Claude<");
    expect(out).toContain(">· partial outage<");
  });

  it("draws a stale incident dashed and dated", () => {
    const out = html([line({ stale: true, checkedAt: NOW - 10 * 60_000 })]);
    expect(out).toContain('class="provider-incident provider-incident-stale"');
    expect(out).toMatch(/>· as of [^<]*\d[^<]*</);
  });

  it("draws one chip per provider in an incident", () => {
    const out = html([line(), line({ provider: "codex", state: "degraded", statusPageUrl: "https://status.openai.com" })]);
    expect(out.match(/class="provider-incident"/g)).toHaveLength(2);
    expect(out).toContain('href="https://status.openai.com/"');
  });

  it("comes after the blocked-session chip in the readout, never before it", () => {
    const src = sourceOf("components/TopbarReadouts.tsx");
    const waiting = src.indexOf("<WaitingStat waitingSessions");
    const chips = src.indexOf("<IncidentChips incidents={incidents} />");
    expect(waiting).toBeGreaterThan(0);
    expect(chips).toBeGreaterThan(waiting);
  });
});

describe("the usage panel's line", () => {
  const claude = incidentOf(line({ summary: "Elevated errors for multiple models" }), NOW)!;

  it("is nothing without an incident", () => {
    expect(renderToStaticMarkup(createElement(QuotaIncident, { incident: null }))).toBe("");
  });

  it("says the state, what the page calls it and where it came from", () => {
    const out = renderToStaticMarkup(createElement(QuotaIncident, { incident: claude }));
    expect(out).toContain(">Partial outage<");
    expect(out).toContain(">Elevated errors for multiple models<");
    expect(out).toContain("status.claude.com");
    expect(out).toContain('href="https://status.claude.com/"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("opens in a new tab");
  });

  it("sits under the provider's own quota heading, whatever the quota says", () => {
    for (const quota of [null, { ok: false, reason: "rate_limited" }, { ok: true, session5hPct: 12, week7dPct: 30 }]) {
      const out = renderToStaticMarkup(createElement(ClaudeQuotaSection, { quota, quotaLoading: false, nowSec: NOW / 1000, incident: claude }));
      expect(out.indexOf("up-incident"), JSON.stringify(quota)).toBeGreaterThan(out.indexOf("</h3>"));
    }
    const plain = renderToStaticMarkup(createElement(ClaudeQuotaSection, { quota: null, quotaLoading: false, nowSec: NOW / 1000 }));
    expect(plain).not.toContain("up-incident");
    const codex = incidentOf(line({ provider: "codex", statusPageUrl: "https://status.openai.com", components: ["Codex API"] }), NOW)!;
    const out = renderToStaticMarkup(createElement(CodexQuotaSection, { codexQuota: null, codexLoading: false, codexUsage: null, nowSec: NOW / 1000, incident: codex }));
    expect(out).toContain(">Codex API<");
  });

  it("is each provider's own: Claude's section never draws Codex's incident", () => {
    const src = sourceOf("components/UsagePanel.tsx");
    expect(src).toContain('incident={incidents.find(i => i.provider === "claude")}');
    expect(src).toContain('incident={incidents.find(i => i.provider === "codex")}');
  });
});

describe("the tray", () => {
  const quiet = { icon: "idle", waiting: 0, running: 0, title: "ccdeck", blocked: [] };
  const on = () => ({
    openWindow: vi.fn(), startDeck: vi.fn(), openInBrowser: vi.fn(), toggleNotifications: vi.fn(),
    setOpenAtLogin: vi.fn(), restartToUpdate: vi.fn(), checkForUpdates: vi.fn(), restartDeck: vi.fn(),
    openStatusPage: vi.fn(), quit: vi.fn(),
  });
  const menu = (incidents: unknown[], actions = on()) => trayMenuItems({
    now: NOW, snapshot: quiet, deck: { port: 4317 }, starting: null, restarting: null, notifyOn: true,
    openAtLogin: false, appVersion: "3.30.0", update: { status: "idle" }, incidents,
  }, actions);

  it("lists each incident under the status line, and the row opens the status page", () => {
    const actions = on();
    const items = menu(incidentsOf({ ok: true, disabled: false, providers: [line()] }, NOW), actions);
    expect(items[1].label).toBe("Claude · partial outage — status page");
    items[1].click();
    expect(actions.openStatusPage).toHaveBeenCalledWith("https://status.claude.com/");
  });

  it("adds no row while the providers are fine", () => {
    const labels = (xs: { label?: string }[]) => xs.map(x => x.label);
    expect(labels(menu([]))).toEqual(labels(menu(incidentsOf({ ok: true, disabled: false, providers: [line({ state: "operational" })] }, NOW))));
  });

  it("asks only while a session is running or waiting", () => {
    expect(statusWorthAsking(quiet)).toBe(false);
    expect(statusWorthAsking({ ...quiet, running: 1 })).toBe(true);
    expect(statusWorthAsking({ ...quiet, waiting: 1 })).toBe(true);
  });

  it("bundles the page's own reading rather than a copy of it", () => {
    const desktop = (f: string) => readFileSync(fileURLToPath(new URL(`../../../desktop/${f}`, import.meta.url)), "utf8");
    expect(desktop("vite.tray.config.mjs")).toContain('"provider-status": fileURLToPath(new URL("../src/web/provider-status.ts", import.meta.url)),');
    expect(desktop("main.mjs")).toContain('({ incidentsOf } = await import(pathToFileURL(join(here, "dist", "lib", "provider-status.mjs")).href));');
  });
});
