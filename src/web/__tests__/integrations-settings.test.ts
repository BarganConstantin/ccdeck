import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import IntegrationsSection from "../components/IntegrationsSection";
import IntegrationConnectionForm from "../components/IntegrationConnectionForm";
import { refreshIntegrations } from "../integrations/client";
import { integrationDef } from "../integrations/registry";
import type { IntegrationConnection, IntegrationKind } from "../integrations/types";
import { indexFor, searchSettings } from "../settings-search";

const providers = ["jira", "github", "gitlab"].map(kind => ({ kind, available: true }));
const connection = (id: string, kind: IntegrationKind): IntegrationConnection => ({
  id, kind, name: `Review ${id}`, baseUrl: `https://${kind}.example.com`,
  account: { id: "review", name: "Reviewer", login: "review", avatarUrl: "" },
  meta: {}, tokenSaved: true, allowedOrigins: [], createdAt: "", updatedAt: "",
});
async function draw(connections: IntegrationConnection[], offered = providers) {
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ connections, providers: offered }))));
  await refreshIntegrations();
  return renderToStaticMarkup(createElement(IntegrationsSection));
}
afterEach(() => vi.unstubAllGlobals());

function providerEntry(html: string, kind: IntegrationKind) {
  const entry = new RegExp(`<section[^>]*id="ig-provider-${kind}"[\\s\\S]*?</section>`).exec(html)?.[0];
  expect(entry, `Missing provider entry: ${kind}`).toBeDefined();
  return entry!;
}

function expectProviderAction(html: string, kind: IntegrationKind, label: string, primary?: boolean) {
  const entry = providerEntry(html, kind);
  const buttons = entry.match(/<button\b[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(1);
  expect(buttons[0]).toContain(`aria-label="${label}"`);
  const classes = /class="([^"]*)"/.exec(buttons[0])?.[1].split(/\s+/) ?? [];
  expect(classes).toContain("btn");
  if (primary !== undefined) expect(classes.includes("primary")).toBe(primary);
  return entry;
}

function expectOverviewActionsOnly(html: string) {
  expect(html).not.toMatch(/aria-label="(?:Add|Test|Edit|Disconnect)\b/);
  expect(html).not.toMatch(/>Add(?: connection| [^<]* connection)?<|>Test(?: connection)?<|>Edit(?: connection)?<|>Disconnect</);
  expect(html).not.toContain("<form");
  expect(html).not.toMatch(/role="tab(?:list)?"/);
}

describe("Settings provider entries", () => {
  it("shows providers in order with one Connect action each and primary GitHub Connect", async () => {
    const html = await draw([]);
    expect(html.indexOf('id="ig-provider-github"')).toBeLessThan(html.indexOf('id="ig-provider-gitlab"'));
    expect(html.indexOf('id="ig-provider-gitlab"')).toBeLessThan(html.indexOf('id="ig-provider-jira"'));
    for (const [kind, label] of [["github", "GitHub"], ["gitlab", "GitLab"], ["jira", "Jira"]] as const) {
      expectProviderAction(html, kind, `Connect ${label}`, kind === "github" ? true : undefined);
    }
    expect(html.match(/Not connected/g)).toHaveLength(3);
    expectOverviewActionsOnly(html);
    expect(html).not.toContain("More trackers");
  });

  it("offers primary Connect for GitHub and one neutral Manage action for each connected provider", async () => {
    const html = await draw([connection("work", "gitlab"), connection("tracker", "jira")]);
    expectProviderAction(html, "github", "Connect GitHub", true);
    for (const [kind, label] of [["gitlab", "GitLab"], ["jira", "Jira"]] as const) {
      const entry = expectProviderAction(html, kind, `Manage ${label}`, false);
      expect(entry).toContain(`${kind}.example.com`);
      expect(entry).not.toContain(`aria-label="Connect ${label}"`);
    }
    expectOverviewActionsOnly(html);
    expect(html.match(/<button\b/g)).toHaveLength(3);
    expect(html).not.toMatch(/Healthy|Online|Working:/);
  });

  it("summarizes multiple accounts with their count and distinct hosts behind one provider Manage action", async () => {
    const work = connection("work", "gitlab");
    const personal = { ...connection("personal", "gitlab"), baseUrl: "https://personal.gitlab.example.com" };
    const html = await draw([work, connection("tracker", "jira"), personal]);
    const entry = expectProviderAction(html, "gitlab", "Manage GitLab", false);
    expect(entry).toMatch(/2 (?:saved )?connections/);
    expect(entry).toContain("gitlab.example.com");
    expect(entry).toContain("personal.gitlab.example.com");
    expect(entry.match(/gitlab\.example\.com/g)).toHaveLength(2);
    expect(entry.match(/aria-label="Manage GitLab"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Manage GitLab:');
    expectProviderAction(html, "github", "Connect GitHub", true);
    expectProviderAction(html, "jira", "Manage Jira", false);
    expectOverviewActionsOnly(html);
  });

  it("keeps an unavailable registered provider in its provider entry with one neutral Manage action", async () => {
    const html = await draw([connection("work", "gitlab"), connection("personal", "gitlab"), connection("tracker", "jira")],
      providers.map(provider => ({ ...provider, available: provider.kind !== "gitlab" })));
    const entry = expectProviderAction(html, "gitlab", "Manage GitLab", false);
    expect(entry).toContain('id="ig-provider-name-gitlab">GitLab</h3>');
    expect(entry).toMatch(/2 (?:saved )?connections/);
    expect(html).not.toContain('aria-label="Connect GitLab"');
    expectProviderAction(html, "jira", "Manage Jira", false);
    expectProviderAction(html, "github", "Connect GitHub", true);
    expectOverviewActionsOnly(html);
  });

  it("keeps only saved registered providers when the API offers no providers, without creation controls", async () => {
    const html = await draw([connection("work", "gitlab")], []);
    expectProviderAction(html, "gitlab", "Manage GitLab", false);
    expect(html).not.toContain('id="ig-provider-github"');
    expect(html).not.toContain('id="ig-provider-jira"');
    expect(html).not.toMatch(/aria-label="Connect /);
    expectOverviewActionsOnly(html);
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });

  it("retains a name-accessible legacy Manage row for an unknown saved provider", async () => {
    // A saved server payload can outlive the client's registered provider kinds.
    const legacy = { ...connection("legacy", "gitlab"), kind: "legacy-tracker" as IntegrationKind, name: "Archived tracker" };
    const html = await draw([legacy], []);
    expect(html).toContain('aria-label="Manage legacy-tracker: Archived tracker (review)"');
    expect(html).toContain("Archived tracker");
    expect(html).not.toContain('id="ig-provider-legacy-tracker"');
    expect(html).not.toMatch(/aria-label="Connect /);
    expectOverviewActionsOnly(html);
    expect(html.match(/<button\b/g)).toHaveLength(1);
  });

  it("searches providers directly and excludes provider anchors the deck cannot offer", () => {
    for (const kind of ["github", "gitlab", "jira"]) {
      expect(searchSettings(kind)[0].id).toBe(`integration-${kind}`);
    }
    const index = indexFor(true, "all", new Set(["gitlab"]));
    expect(index.filter(entry => entry.id.startsWith("integration-")).map(entry => entry.id)).toEqual(["integration-gitlab"]);
    expect(indexFor(true, "connections").filter(entry => entry.section === "integrations").map(entry => entry.id))
      .toEqual(["section:integrations", "integrations-connections"]);
  });
});

describe("connection form request state", () => {
  it("locks the fields and Cancel while a submission is pending, keeping the submit control focusable", () => {
    const html = renderToStaticMarkup(createElement(IntegrationConnectionForm, {
      def: integrationDef("gitlab")!, busy: true, error: null, onSubmit: () => {}, onCancel: () => {},
    }));
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map(match => match[0]);
    expect(inputs.length).toBeGreaterThan(2);
    for (const input of inputs) expect(input).toContain('disabled=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel/);
    expect(html).toMatch(/<button type="submit"[^>]*aria-disabled="true"[^>]*aria-busy="true"/);
  });

  it("never prepopulates a saved secret, and describes leaving it blank on edit", () => {
    const html = renderToStaticMarkup(createElement(IntegrationConnectionForm, {
      def: integrationDef("github")!, existing: connection("saved", "github"), busy: false, error: null, onSubmit: () => {}, onCancel: () => {},
    }));
    const secret = /<input[^>]*type="password"[^>]*>/.exec(html)?.[0];
    expect(secret).toContain('value=""');
    expect(secret).toContain("Saved. Leave blank to keep it");
    expect(secret).not.toContain('aria-required="true"');
  });
});
