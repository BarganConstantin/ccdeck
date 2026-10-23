import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, one } from "./fake-react";
vi.mock("react", async orig => ({ ...(await orig<typeof import("react")>()), ...(await import("./fake-react")).react }));
const live = vi.hoisted(() => ({ state: { connections: [], providers: [{ kind: "github", label: "GitHub", available: true }], error: "" } }));
vi.mock("../integrations/client", async orig => ({ ...(await orig<typeof import("../integrations/client")>()), useIntegrations: () => live.state }));
const { requestIntegrationAdd, takeIntegrationAdd, requestIntegrationFocus, takeIntegrationFocus } = await import("../integrations/client");
const { default: IntegrationsSection } = await import("../components/IntegrationsSection");
const { default: IntegrationConnectionForm } = await import("../components/IntegrationConnectionForm");
afterEach(() => { takeIntegrationAdd(); takeIntegrationFocus(); });
describe("provider-targeted Settings navigation", () => {
  it("takes the provider intent once and mutually excludes reconnect", () => {
    requestIntegrationFocus("saved");
    requestIntegrationAdd("github");
    expect(takeIntegrationFocus()).toBeNull();
    expect(takeIntegrationAdd()).toBe("github");
    expect(takeIntegrationAdd()).toBeNull();
    requestIntegrationAdd("jira");
    requestIntegrationFocus("saved");
    expect(takeIntegrationAdd()).toBeNull();
    expect(takeIntegrationFocus()).toBe("saved");
  });
  it("mounts the original form for the requested provider without an extra picker", () => {
    requestIntegrationAdd("github");
    const section = mount(IntegrationsSection, {});
    const group = one(section.tree, e => e.props.id === "integrations-add-title")!;
    // The add form is a render-time branch; invoking the fragment's child
    // isn't needed because its form element is already in the element tree.
    const form = one(group, e => e.type === IntegrationConnectionForm)!;
    expect(form.props.def).toMatchObject({ kind: "github", label: "GitHub" });
    expect(form.props.existing).toBeUndefined();
    section.unmount();
    const reopened = mount(IntegrationsSection, {});
    expect(one(reopened.tree, e => e.type === IntegrationConnectionForm)).toBeNull();
    reopened.unmount();
  });
  it("does not mount an unavailable provider form", () => {
    requestIntegrationAdd("jira");
    const section = mount(IntegrationsSection, {});
    expect(one(section.tree, e => e.type === IntegrationConnectionForm)).toBeNull();
    section.unmount();
  });
});
