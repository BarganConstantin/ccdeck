import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationConnectionDetails, { connectionServer, verificationTime } from "../components/IntegrationConnectionDetails";
import { integrationDef } from "../integrations/registry";
import type { IntegrationConnection } from "../integrations/types";

const connection: IntegrationConnection = {
  id: "review", kind: "jira", name: "Work tracker", baseUrl: "https://jira.example.com",
  account: { id: "reviewer", name: "Review Developer", login: "reviewer", avatarUrl: "" },
  meta: { deploymentType: "DataCenter", serverVersion: "9.0", checkedAt: "2026-10-23T08:00:00Z" },
  tokenSaved: true, allowedOrigins: [], createdAt: "", updatedAt: "",
};
type DetailsNote = ComponentProps<typeof IntegrationConnectionDetails>["note"];
const draw = (available = true, armed = false, value = connection, note?: DetailsNote) => renderToStaticMarkup(createElement(IntegrationConnectionDetails, {
  connection: value, provider: integrationDef(value.kind), available, armed, note, busy: null, headingRef: { current: null },
  onTest: () => {}, onEdit: () => {}, onDisconnect: () => {}, onCancelDisconnect: () => {},
}));

describe("focused connection management", () => {
  it("shows complete account/instance facts and historical verification without implying current health", () => {
    const html = draw();
    for (const fact of ["Jira · Saved connection", "Work tracker", "https://jira.example.com", "Review Developer (reviewer)", "Jira Data Center 9.0", "Last verified", "Stored locally"]) expect(html).toContain(fact);
    for (const action of ["Test connection", "Edit connection", "Disconnect"]) expect(html).toContain(`>${action}</button>`);
    expect(html).toMatch(/<h2[^>]*id="ig-managed-title"[^>]*>Work tracker<\/h2>/);
    expect(html).toContain('aria-labelledby="ig-managed-title"');
    expect(html).not.toContain('>Add connection</button>');
    expect(html).toContain('<dt>Host</dt><dd>https://jira.example.com</dd>');
    expect(html).not.toContain('class="btn primary"');
    expect(html).toContain('data-integration-disconnect="true" class="btn danger"');
    expect(html).toContain('<h3>Remove connection</h3>');
    expect(html).not.toMatch(/Healthy|Online|<input|type="password"/);
  });

  it("lets an unavailable provider's saved connection be disconnected without offering unusable actions", () => {
    const html = draw(false);
    expect(html).toContain('aria-label="Disconnect Work tracker"');
    expect(html).toContain("Jira is not available on this deck.");
    expect(html).not.toMatch(/>Test connection<|>Edit connection<|>Add connection</);
  });

  it("names the destructive confirmation and explicitly explains the saved-token consequence", () => {
    const html = draw(true, true);
    expect(html).toContain('aria-label="Confirm disconnecting Work tracker"');
    expect(html).toContain('role="status">Press Confirm disconnect to delete this connection and its saved token, or Cancel to keep it.</p>');
    expect(html).toContain('>Confirm disconnect</button>');
    expect(html).toContain('data-integration-disconnect="true" class="btn danger armed"');
    const cancel = html.match(/<button[^>]*aria-label="Cancel disconnect"[^>]*>Cancel<\/button>/)?.[0];
    expect(cancel).toBeDefined();
    expect(cancel).toContain('type="button"');
    expect(cancel).not.toMatch(/disabled=|aria-disabled="true"/);
    expect(draw()).not.toContain('aria-label="Cancel disconnect"');
  });

  it("identifies a connection without an alias by its instance URL", () => {
    const html = draw(true, false, { ...connection, name: "" });
    expect(html).toMatch(/<h2[^>]*id="ig-managed-title"[^>]*>https:\/\/jira.example.com<\/h2>/);
  });

  it("keeps the complete instance URL visible, including its scheme and path", () => {
    const baseUrl = "http://jira.example.com/tracker/";
    expect(draw(true, false, { ...connection, baseUrl })).toContain(`<dt>Host</dt><dd>${baseUrl}</dd>`);
  });

  it("shows stored-credential status without rendering a secret or a credential field", () => {
    expect(draw()).toContain("<dt>Credentials</dt><dd>Stored locally</dd>");
    const html = draw(true, false, { ...connection, tokenSaved: false });
    expect(html).toContain("<dt>Credentials</dt><dd>No token saved</dd>");
    expect(html).not.toContain("Stored locally");
    expect(html).not.toMatch(/<input|type="password"/);
  });

  it("identifies a known GitLab version without inventing server facts when metadata is missing", () => {
    const gitlab = { ...connection, kind: "gitlab" as const, meta: { serverVersion: "17.5.1" } };
    expect(connectionServer(gitlab)).toBe("GitLab 17.5.1");
    expect(draw(true, false, gitlab)).toContain("<dt>Server</dt><dd>GitLab 17.5.1</dd>");
    for (const meta of [{}, { serverVersion: "" }, { serverVersion: 175 }]) {
      const unknown = { ...gitlab, meta };
      expect(connectionServer(unknown)).toBeNull();
      expect(draw(true, false, unknown)).not.toContain("<dt>Server</dt>");
    }
  });

  it.each([
    ["Cloud", "Jira Cloud"],
    ["Server", "Jira Server 9.0"],
    ["DataCenter", "Jira Data Center 9.0"],
  ])("retains the Jira %s deployment identity", (deploymentType, label) => {
    const value = { ...connection, meta: { deploymentType, serverVersion: "9.0" } };
    expect(connectionServer(value)).toBe(label);
    expect(draw(true, false, value)).toContain(`<dt>Server</dt><dd>${label}</dd>`);
  });

  it("does not label another provider as Jira when it carries deployment metadata", () => {
    const github = { ...connection, kind: "github" as const };
    expect(connectionServer(github)).toBeNull();
    expect(draw(true, false, github)).not.toContain("<dt>Server</dt>");
    const gitlab = { ...connection, kind: "gitlab" as const, meta: { deploymentType: "Cloud" } };
    expect(connectionServer(gitlab)).toBeNull();
    expect(draw(true, false, gitlab)).not.toContain("<dt>Server</dt>");
  });

  it("does not infer an unknown server from a version alone", () => {
    const value = { ...connection, meta: { serverVersion: "9.0" } };
    expect(connectionServer(value)).toBeNull();
    expect(draw(true, false, value)).not.toContain("<dt>Server</dt>");
  });

  it("places a failed disconnect with Remove connection, including for an unavailable provider", () => {
    for (const available of [true, false]) {
      const html = draw(available, false, connection, { tone: "err", text: "Could not remove the saved connection. Try again.", scope: "disconnect" });
      const remove = html.slice(html.indexOf('<div class="ig-disconnect-section">'));
      expect(remove).toContain('role="alert">Could not remove the saved connection. Try again.</p>');
      expect(html.slice(0, html.indexOf('<div class="ig-disconnect-section">'))).not.toContain("Could not remove the saved connection");
    }
  });

  it.each([
    ["err", "The token was refused. Edit the connection to replace it.", "alert"],
    ["ok", "Verified as Review Developer.", "status"],
  ] as const)("keeps %s test feedback with the regular management actions", (tone, text, role) => {
    const html = draw(true, false, connection, { tone, text });
    const removeAt = html.indexOf('<div class="ig-disconnect-section">');
    const management = html.slice(0, removeAt);
    expect(management).toContain(`role="${role}">${text}</p>`);
    expect(management.indexOf(text)).toBeGreaterThan(management.indexOf(">Test connection</button>"));
    expect(html.slice(removeAt)).not.toContain(text);
  });

  it("does not turn absent or malformed metadata into an invented verification", () => {
    for (const meta of [{}, { checkedAt: "invalid" }]) {
      const value = { ...connection, meta };
      expect(verificationTime(value)).toBeNull();
      expect(draw(true, false, value)).toContain("No verification time available");
    }
  });
});
