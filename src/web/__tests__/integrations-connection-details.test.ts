import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntegrationConnectionDetails, { verificationTime } from "../components/IntegrationConnectionDetails";
import { integrationDef } from "../integrations/registry";
import type { IntegrationConnection } from "../integrations/types";

const connection: IntegrationConnection = {
  id: "review", kind: "jira", name: "Work tracker", baseUrl: "https://jira.example.com",
  account: { id: "reviewer", name: "Review Developer", login: "reviewer", avatarUrl: "" },
  meta: { deploymentType: "DataCenter", serverVersion: "9.0", checkedAt: "2026-10-23T08:00:00Z" },
  tokenSaved: true, allowedOrigins: [], createdAt: "", updatedAt: "",
};
const draw = (available = true, armed = false, value = connection) => renderToStaticMarkup(createElement(IntegrationConnectionDetails, {
  connection: value, provider: integrationDef("jira"), available, armed, busy: null, headingRef: { current: null },
  onTest: () => {}, onEdit: () => {}, onAdd: () => {}, onDisconnect: () => {},
}));

describe("focused connection management", () => {
  it("shows complete account/instance facts and historical verification without implying current health", () => {
    const html = draw();
    for (const fact of ["Jira · Saved connection", "Work tracker", "https://jira.example.com", "Review Developer (reviewer)", "Jira Data Center 9.0", "Last verified", "Stored locally"]) expect(html).toContain(fact);
    for (const action of ["Test connection", "Edit connection", "Add connection", "Disconnect"]) expect(html).toContain(`>${action}</button>`);
    expect(html).toContain('id="ig-managed-title" class="ig-managed-title">Work tracker</h3>');
    expect(html).not.toContain('class="btn primary"');
    expect(html).toContain('class="btn ig-disconnect"');
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
    expect(html).toContain('role="status">Press Confirm disconnect to delete this connection and its saved token.');
    expect(html).toContain('>Confirm disconnect</button>');
  });

  it("identifies a connection without an alias by its instance URL", () => {
    const html = draw(true, false, { ...connection, name: "" });
    expect(html).toContain('id="ig-managed-title" class="ig-managed-title">https://jira.example.com</h3>');
  });

  it("does not turn absent or malformed metadata into an invented verification", () => {
    for (const meta of [{}, { checkedAt: "invalid" }]) {
      const value = { ...connection, meta };
      expect(verificationTime(value)).toBeNull();
      expect(draw(true, false, value)).toContain("No verification time available");
    }
  });
});
