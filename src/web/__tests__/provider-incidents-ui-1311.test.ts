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
import {
  incidentOf, incidentsOf, incidentSentence, INCIDENT_EXPIRE_MS, INCIDENT_STALE_MS, INCIDENTS_CLEAR, safeStatusPage,
  type ProviderStatus, type ProviderStatusReport,
} from "../provider-status";
import { nextAnnouncement } from "../block-announce";
import { PROVIDER_STATUS_POLL_MS, statusPoll } from "../use-provider-status";
import { IncidentChips, QuotaIncident } from "../components/ProviderIncidents";
import { ClaudeQuotaSection, CodexQuotaSection } from "../components/QuotaSections";
import { sourceOf } from "./client-source";
import { sheetText } from "./sheet-source";
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
    const i = incidentOf(line({ stale: true, checkedAt: NOW - 4 * 60_000 }), NOW)!;
    expect(i.stale).toBe(true);
    // A 24-hour clock, whatever the locale's default.
    expect(i.asOf).toMatch(/^\d{2}:\d{2}$/);
    expect(i.label).toBe(`Claude · partial outage · as of ${i.asOf}`);
    expect(i.detail).toContain(`Last read from status.claude.com at ${i.asOf}; this is the last thing it said`);
    expect(i.detail).not.toContain("checked");
  });

  it("dates an answer nobody has renewed, even when its last read succeeded", () => {
    // The tray stopped asking, or the deck is down: the server never got to
    // say "stale", and the answer is still not current.
    const fresh = incidentOf(line({ checkedAt: NOW - INCIDENT_STALE_MS }), NOW)!;
    expect(fresh.stale).toBe(false);
    const held = incidentOf(line({ checkedAt: NOW - INCIDENT_STALE_MS - 1 }), NOW)!;
    expect(held.stale).toBe(true);
    expect(held.label).toMatch(/ · as of \d{2}:\d{2}$/);
  });

  it("says how fresh a live incident is, and never dates it", () => {
    const i = incidentOf(line({ checkedAt: NOW - 4 * 60_000 }), NOW)!;
    expect(i.asOf).toBeNull();
    expect(i.detail).toContain("Reported by status.claude.com, checked 4 min ago");
  });

  it("says when a state is the page's overall status rather than a component's", () => {
    expect(incidentOf(line({ scope: "page", components: [] }), NOW)!.detail)
      .toContain("The page's overall status: it names none of Claude's components");
    expect(incidentOf(line(), NOW)!.detail).not.toContain("overall status");
  });

  it("has a one-word form of every state, for a bar with no room", () => {
    const short = (state: ProviderStatus["state"]) => incidentOf(line({ state }), NOW)!.shortWords;
    expect(short("partial_outage")).toBe("outage");
    expect(short("major_outage")).toBe("outage");
    expect(short("degraded")).toBe("degraded");
    expect(short("maintenance")).toBe("maint.");
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
    // A hole in the list is skipped, not a TypeError in the tray's menu build.
    expect(incidentsOf({ ok: true, disabled: false, providers: [null, 7, line()] } as never, NOW)).toHaveLength(1);
  });
});

describe("what the deck says aloud", () => {
  const said = (providers: ProviderStatus[]) => incidentSentence(incidentsOf({ ok: true, disabled: false, providers }, NOW));

  it("names each provider in an incident and its state, in a sentence", () => {
    expect(said([line()])).toBe("Claude's status page reports a partial outage.");
    expect(said([line({ state: "degraded" }), line({ provider: "codex", state: "maintenance", statusPageUrl: "https://status.openai.com" })]))
      .toBe("Claude's status page reports degraded performance. Codex's status page reports maintenance.");
    expect(said([line({ state: "operational" })])).toBe("");
  });

  it("is not news when an incident only goes stale", () => {
    expect(said([line({ stale: true })])).toBe(said([line()]));
  });

  it("speaks the start and the end of an incident, and says nothing on a quiet deck", () => {
    let region = "";
    region = nextAnnouncement(region, said([]), INCIDENTS_CLEAR);
    expect(region).toBe("");
    region = nextAnnouncement(region, said([line()]), INCIDENTS_CLEAR);
    expect(region).toBe("Claude's status page reports a partial outage.");
    region = nextAnnouncement(region, said([]), INCIDENTS_CLEAR);
    expect(region).toBe(INCIDENTS_CLEAR);
  });

  it("is mounted always, beside the other two regions", () => {
    const src = sourceOf("components/TopbarReadouts.tsx");
    expect(src).toContain('<div className="vis-hidden" role="status" aria-atomic="true">{incidentSaid}</div>');
    expect(sourceOf("App.tsx")).toContain("useLiveAnnouncements({ waitingSessions, watchUnseen, incidents })");
  });
});

describe("when the page asks", () => {
  function harness(start: { visible?: boolean; answer?: ProviderStatusReport | null } = {}) {
    let t = 1_000_000;
    let visible = start.visible ?? true;
    const answer = "answer" in start ? start.answer : { ok: true, disabled: false, providers: [] };
    const asked: number[] = [];
    const got: ProviderStatusReport[] = [];
    const poll = statusPoll({
      fetchReport: async () => { asked.push(t); return answer ?? null; },
      visible: () => visible,
      now: () => t,
      onReport: r => got.push(r),
    });
    return { poll, asked, got, advance: (ms: number) => { t += ms; }, show: (v: boolean) => { visible = v; } };
  }

  it("asks on each tick while the tab is visible, and not while it is hidden", async () => {
    const h = harness();
    await h.poll.tick();
    expect(h.asked).toHaveLength(1);
    expect(h.got).toHaveLength(1);
    h.show(false);
    await h.poll.tick();
    expect(h.asked).toHaveLength(1);
  });

  it("asks on the way back only when the answer on screen is a poll old", async () => {
    const h = harness();
    await h.poll.tick();
    h.advance(PROVIDER_STATUS_POLL_MS - 1);
    await h.poll.wake();
    expect(h.asked).toHaveLength(1);
    h.advance(1);
    await h.poll.wake();
    expect(h.asked).toHaveLength(2);
  });

  it("does not wake a hidden tab", async () => {
    const h = harness({ visible: false });
    h.advance(PROVIDER_STATUS_POLL_MS * 10);
    await h.poll.wake();
    expect(h.asked).toEqual([]);
  });

  it("keeps the answer it has when an ask gets none", async () => {
    const h = harness({ answer: null });
    await h.poll.tick();
    expect(h.asked).toHaveLength(1);
    expect(h.got).toEqual([]);
  });

  it("drops an answer that lands after it was stopped", async () => {
    const h = harness();
    const pending = h.poll.tick();
    h.poll.stop();
    await pending;
    expect(h.got).toEqual([]);
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
    expect(out).toContain('data-state="partial_outage"');
    expect(out).toContain('class="provider-incident"');
    expect(out).toContain(">Claude<");
    expect(out).toContain(">· partial outage<");
    // Where it goes, said to a screen reader and drawn as ↗ for everyone else.
    expect(out).toContain('<span class="vis-hidden">, on status.claude.com, opens in a new tab</span>');
    expect(out).toContain('<span class="pi-go" aria-hidden="true">↗</span>');
  });

  it("is named by the words it shows, whichever of them the sheet shows (2.5.3)", () => {
    // No fixed label: the name is the visible content, so the one-word form at
    // the narrow breakpoint and the full one above it are each their own name.
    const out = renderToStaticMarkup(createElement(IncidentChips, { incidents: [incidentOf(line({ state: "degraded" }), NOW)!] }));
    expect(out).not.toContain("aria-label");
    expect(out).toContain('<span class="pi-words">· degraded</span>');
    expect(out).toContain('<span class="pi-short">· degraded</span>');
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

  it("comes before the blocked-session chip, so the alarm is the last thing the readout clips", () => {
    // The readout packs to its end when it runs out of room: its last child
    // survives longest, and that has to be the count.
    const src = sourceOf("components/TopbarReadouts.tsx");
    const waiting = src.indexOf("<WaitingStat waitingSessions");
    const chips = src.indexOf("<IncidentChips incidents={incidents} />");
    expect(chips).toBeGreaterThan(0);
    expect(waiting).toBeGreaterThan(chips);
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
    expect(out).toContain(", on status.claude.com, opens in a new tab");
    expect(out).toContain('href="https://status.claude.com/"');
    expect(out).toContain('rel="noopener noreferrer"');
    // The title has a row of its own, after the state and the arrow.
    expect(out.indexOf("up-incident-what")).toBeGreaterThan(out.indexOf("up-incident-go"));
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
    expect(desktop("main.mjs")).toContain('({ incidentsOf, safeStatusPage } = await import(pathToFileURL(join(here, "dist", "lib", "provider-status.mjs")).href));');
    // And the tray asks it again at the call that hands a URL to the system.
    expect(desktop("main.mjs")).toContain("openStatusPage: href => { if (safeStatusPage?.(href)) shell.openExternal(href); },");
    // An answer that lands after a restart is not written over the new deck's.
    expect(desktop("main.mjs")).toContain("if (json?.ok && asked === deck) providerStatus = json;");
  });
});

describe("the sheet", () => {
  const css = sheetText();

  it("never draws the chip in the alarm's shape or colour", () => {
    const chip = css.match(/\.topbar \.provider-incident \{\s*display: inline-flex;[^}]*\}/)![0];
    expect(chip).toContain("border-radius: var(--r-tag);");
    expect(chip).not.toContain("999px");
    expect(chip).not.toContain("--warn");
  });

  it("keeps the focus ring inside a readout that clips", () => {
    expect(css).toContain(".topbar .provider-incident:focus-visible { outline-offset: -3px; }");
  });

  it("shows one length of the words at a time", () => {
    expect(css).toContain(".topbar .provider-incident .pi-short { display: none; }");
    // Two chips below 1680px, and any chip at the narrow breakpoint, swap to the one word.
    expect(css).toMatch(/@media \(max-width: 1679px\) \{\s*\.topbar \.readout:has\(\.provider-incident \+ \.provider-incident\) :is\(\.pi-words, \.pi-asof\) \{ display: none; \}\s*\.topbar \.readout:has\(\.provider-incident \+ \.provider-incident\) \.pi-short \{ display: inline; \}/);
    expect(css).toMatch(/\.topbar \.readout \.provider-incident :is\(\.pi-words, \.pi-asof\) \{ display: none; \}\s*\.topbar \.readout \.provider-incident \.pi-short \{ display: inline; \}\s*\}/);
    expect(css).toMatch(/@media \(max-width: 480px\) \{\s*\.topbar \.readout \.provider-incident \{ display: none; \}\s*\}/);
  });

  it("outweighs the chip's own rules, which come later in the cascade", () => {
    // Equal weight and later wins: a breakpoint rule written as
    // `.topbar .provider-incident …` in topbar.css lost to the chip's own
    // `display` in topbar-controls.css, and the phone-width hide did nothing.
    const at = (sel: string) => css.indexOf(sel);
    expect(at(".topbar .provider-incident {\n  display: inline-flex;")).toBeGreaterThan(at("@media (max-width: 480px)"));
    expect(css).not.toMatch(/@media \(max-width: (?:480|640)px\) \{[^@]*?\n\s*\.topbar \.provider-incident[ ,{]/);
  });

  it("gives each state its own shape, in a contrast theme too", () => {
    expect(css).toContain('[data-state="degraded"] > .pi-dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--err); }');
    expect(css).toContain('[data-state="maintenance"] > .pi-dot { background: var(--muted); border-radius: 1px; }');
    expect(css).toContain('[data-state="degraded"] > .pi-dot { background: Canvas; box-shadow: inset 0 0 0 1.5px CanvasText; }');
    expect(css).toContain('[data-state="maintenance"] > .pi-dot { background: GrayText; }');
  });
});
