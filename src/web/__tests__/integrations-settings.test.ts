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

describe("Settings provider entries", () => {
  it("shows each provider and a direct Connect action before opening a form", async () => {
    const html = await draw([]);
    expect(html.indexOf('id="ig-provider-github"')).toBeLessThan(html.indexOf('id="ig-provider-gitlab"'));
    expect(html.indexOf('id="ig-provider-gitlab"')).toBeLessThan(html.indexOf('id="ig-provider-jira"'));
    for (const label of ["GitHub", "GitLab", "Jira"]) expect(html).toContain(`aria-label="Connect ${label}"`);
    expect(html.match(/Not connected/g)).toHaveLength(3);
    expect(html).not.toContain("<form");
    expect(html).not.toContain('aria-label="Add connection to');
    expect(html).not.toContain("More trackers");
  });

  it("groups multiple connections with their provider, preserving their management actions", async () => {
    const html = await draw([connection("a", "github"), connection("b", "jira"), connection("c", "github")]);
    expect(html).toContain("2 connections");
    for (const [id, label] of [["a", "GitHub"], ["b", "Jira"], ["c", "GitHub"]]) {
      expect(html).toContain(`aria-label="Manage ${label}: Review ${id} (review)"`);
    }
    expect(html).not.toMatch(/>Test(?: connection)?<|>Edit(?: connection)?<|>Disconnect</);
    expect(html).toContain('aria-label="Add connection to GitHub"');
    expect(html).toContain('aria-label="Add connection to Jira"');
    expect(html).not.toContain('aria-label="Add connection to GitLab"');
    expect(html.match(/>Add connection<\/button>/g)).toHaveLength(2);
    expect(html.indexOf("Review c")).toBeLessThan(html.indexOf('id="ig-provider-gitlab"'));
    expect(html.indexOf('id="ig-provider-jira"')).toBeLessThan(html.indexOf("Review b"));
    expect(html).not.toMatch(/Healthy|Online|Working:/);
  });

  it("offers a direct Add connection beside a connected provider while preserving its alias and Manage path", async () => {
    const html = await draw([connection("work", "gitlab")]);
    const provider = html.slice(html.indexOf('id="ig-provider-gitlab"'), html.indexOf('id="ig-provider-jira"'));
    expect(provider).toContain('id="ig-provider-name-gitlab">GitLab</h3>');
    expect(provider).toMatch(/<button[^>]*aria-label="Add connection to GitLab"[^>]*>Add connection<\/button>/);
    expect(provider).toContain('aria-label="Manage GitLab: Review work (review)"');
    expect(provider).toContain("gitlab.example.com");
    expect(provider).not.toContain('aria-label="Connect GitLab"');
    expect(provider).not.toMatch(/>Test(?: connection)?<|>Edit(?: connection)?<|>Disconnect</);
  });

  it("keeps unavailable saved connections manageable without offering Add or Connect for that provider", async () => {
    const html = await draw([connection("work", "gitlab"), connection("tracker", "jira")],
      providers.map(provider => ({ ...provider, available: provider.kind !== "gitlab" })));
    expect(html).toContain('aria-label="Manage GitLab: Review work (review)"');
    expect(html).toContain("GitLab is not available on this deck.");
    expect(html).not.toContain('aria-label="Add connection to GitLab"');
    expect(html).not.toContain('aria-label="Connect GitLab"');
    expect(html).toContain('aria-label="Add connection to Jira"');
    expect(html).toContain('aria-label="Connect GitHub"');
    expect(html).not.toMatch(/>Test(?: connection)?<|>Edit(?: connection)?<|>Disconnect</);
  });

  it("offers no creation controls when only unavailable saved connections remain", async () => {
    const html = await draw([connection("work", "gitlab")], []);
    expect(html).toContain('aria-label="Manage GitLab: Review work (review)"');
    expect(html).toContain("GitLab is not available on this deck.");
    expect(html).not.toMatch(/aria-label="(?:Add connection to|Connect) /);
    expect(html).not.toMatch(/>Add connection<|<form|>Test(?: connection)?<|>Edit(?: connection)?<|>Disconnect</);
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
