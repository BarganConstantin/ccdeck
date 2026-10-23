import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { all, mount } from "./fake-react";
vi.mock("react", async orig => ({ ...(await orig<typeof import("react")>()), ...(await import("./fake-react")).react }));
vi.mock("../components/use-hint", () => ({ useHint: () => ({ bind: () => ({}), node: null }) }));
const { EdgeRail } = await import("../components/EdgeRails");
import type { RailItem } from "../components/EdgeRails";

const item = (id: string): RailItem => ({ id, label: id, short: id, ariaLabel: id, kind: "dialog", glyph: null, onPress: () => {} });

describe("the permanent launcher's React identity", () => {
  it("survives the first provider group appearing and the last one disappearing", () => {
    const primary = [item("session-list")], explore = [item("explore-integrations")];
    const rail = mount(EdgeRail, { side: "left" as const, label: "Left column", groups: [primary, [], explore] });
    const exploreKey = () => (all(rail.tree, e => e.props["data-rail-group"] === "explore")[0] as unknown as ReactElement).key;
    const key = exploreKey();
    expect(key).not.toBeNull();
    rail.rerender({ side: "left", label: "Left column", groups: [primary, [item("integration-github")], explore] });
    // React replaces a group's children when its key changes. An opener saved
    // by Settings would then refer to a detached button after Connect.
    expect(exploreKey()).toBe(key);
    rail.rerender({ side: "left", label: "Left column", groups: [primary, [], explore] });
    expect(exploreKey()).toBe(key);
    rail.unmount();
  });
});
