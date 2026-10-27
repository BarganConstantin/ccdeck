import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { all, one } from "./fake-react";
import { items, draw, buttons, attr } from "./edge-keys-rails";
import { EdgeDock, EdgeRail } from "../components/EdgeRails";
import { railItems } from "../rail-items";
import { integrationDefs } from "../integrations/registry";
import { kindOpenable, type IntegrationsState } from "../integrations/client";
import type { IntegrationConnection, IntegrationKind } from "../integrations/types";
import ExploreIntegrationsModal from "../components/ExploreIntegrationsModal";

vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.mock("../components/use-modal-dismiss", () => ({ useModalDismiss: () => ({ current: null }), useScrimDismiss: () => ({}) }));

const noop = () => {};
const providers = integrationDefs().map(p => ({ kind: p.kind, label: p.label, available: true }));
const connection = (id: string, kind: IntegrationKind): IntegrationConnection => ({
  id, kind, name: id, baseUrl: "https://example.test", account: { id: "user", name: "Example", login: "example", avatarUrl: "" },
  tokenSaved: true, meta: {}, allowedOrigins: [], createdAt: "", updatedAt: "",
});
const state = (connections: IntegrationConnection[] | null = []): IntegrationsState => ({ connections, providers, error: "" });
function catalog(integrations = state()) {
  vi.stubGlobal("document", { body: {} });
  const props = { integrations, onClose: vi.fn(), onOpen: vi.fn(), onConnect: vi.fn(), onManage: vi.fn() };
  const tree = ExploreIntegrationsModal(props);
  return { props, tree, html: renderToStaticMarkup(tree) };
}
afterEach(() => vi.unstubAllGlobals());

describe("Explore's native catalog", () => {
  it("names every available provider, its capabilities, status and read-only policy", () => {
    const { html } = catalog();
    for (const p of providers) expect(html).toContain(`aria-label="Connect ${p.label}"`);
    expect(html.match(/Not connected/g)).toHaveLength(3);
    // Jira also moves issues (3.48.0); GitHub and GitLab only read.
    expect(html.match(/Read only/g)).toHaveLength(2);
    expect(html.match(/Can move issues/g)).toHaveLength(1);
    expect(html).toContain("Browsing only reads · Tokens stay on this machine");
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="explore-integrations-title"');
    expect(html).not.toMatch(/input|Show in sidebar|Hide|localStorage/);
  });
  it("closes before handing off Connect, Open and Manage to their existing owners", () => {
    const { tree, props } = catalog(state([connection("jira-1", "jira"), connection("jira-2", "jira")]));
    for (const [label, callback, arg] of [
      ["Connect GitHub", props.onConnect, "github"], ["Open Jira", props.onOpen, "jira"], ["Manage Jira", props.onManage, "jira-1"],
    ] as const) {
      (one(tree, e => e.props["aria-label"] === label)!.props.onClick as () => void)();
      expect(callback).toHaveBeenLastCalledWith(arg);
      expect(props.onClose.mock.invocationCallOrder.at(-1)).toBeLessThan(callback.mock.invocationCallOrder.at(-1)!);
    }
    const footer = all(tree, e => e.type === "button" && !e.props["aria-label"])[0];
    (footer.props.onClick as () => void)();
    expect(props.onManage).toHaveBeenLastCalledWith();
  });
  it("updates status from the shared snapshot, including the last disconnection", () => {
    const snapshot = state([connection("j1", "jira"), connection("j2", "jira")]);
    expect(catalog(snapshot).html).toContain('aria-label="Open Jira"');
    snapshot.connections!.splice(0, 1);
    expect(catalog(snapshot).html).toContain('aria-label="Open Jira"');
    snapshot.connections = [];
    expect(catalog(snapshot).html).toContain('aria-label="Connect Jira"');
    expect(kindOpenable(snapshot, "jira")).toBe(false);
  });
  it("does not offer invalid actions while loading, failed, unavailable or absent", () => {
    expect(catalog(state(null)).html).toContain("Reading integrations…");
    expect(catalog({ ...state(null), error: "Cannot reach the deck." }).html).toContain('role="alert"');
    const unavailable = { ...state([connection("j1", "jira")]), providers: [{ kind: "jira" as const, label: "Jira", available: false }] };
    const html = catalog(unavailable).html;
    expect(html).toContain("Unavailable on this deck");
    expect(html).toContain('aria-label="Manage Jira"');
    expect(html).not.toMatch(/aria-label="(?:Connect|Open) /);
    expect(html).not.toContain("GitHub");
    expect(catalog({ ...state(), providers: [] }).html).toContain("No integrations are available");
  });
});

describe("permanent discovery inside the roving rail", () => {
  const make = (connected: IntegrationKind[]) => {
    const r = items();
    // Use the actual factory for the discovery action and connected provider map.
    const native = railItems({
      providers: { kind: "reported", claude: true, codex: true },
      sessionListOpen: false, toggleSessionList: noop, accountsPanelOpen: false, toggleAccountsPanel: noop,
      usagePanelOpen: false, setUsagePanelOpen: noop, machinePanelOpen: false, setMachinePanelOpen: noop,
      setUsageHistoryOpen: noop, watchOn: false, watchUnseen: 0, setBrowserWatchOpen: noop,
      openSettings: noop, onFeedback: noop, toggles: { sessionList: { current: null }, accounts: { current: null }, usage: { current: null }, machine: { current: null } },
      openExploreIntegrations: noop,
      integrations: integrationDefs().filter(d => connected.includes(d.kind)).map(provider => ({ provider, onPress: noop })),
    });
    return { ...r, ...native };
  };
  for (const kinds of [[], ["jira"], ["jira", "github", "gitlab"]] as IntegrationKind[][]) {
    it(`keeps Explore last with ${kinds.length} connected kinds and one toolbar Tab stop`, () => {
      const rails = make(kinds);
      const html = draw(createElement(EdgeRail, { side: "left", label: "Left column", groups: [...rails.leftStripe, rails.integrations, rails.explore] }));
      const tags = buttons(html);
      expect([...tags.keys()].at(-1)).toBe("explore-integrations");
      expect([...tags.values()].filter(tag => attr(tag, "tabindex") === "0")).toHaveLength(1);
      expect(html).toContain('data-rail-group="explore"');
      expect(tags.size).toBe(rails.leftStripe.flat().length + kinds.length + 1);
    });
  }
  it("adds discovery to More without replacing the other mobile actions", () => {
    const rails = make(["jira"]);
    const html = draw(createElement(EdgeDock, { items: rails.left, more: [...rails.capacity, ...rails.right.slice(1).flat(), ...rails.integrations, ...rails.explore, rails.utilities[1]] }));
    expect(html).toContain("Explore integrations");
    expect(html).toContain("Usage history");
    expect(html).toContain("Send feedback");
    expect(html).toContain('aria-haspopup="menu"');
  });
});
