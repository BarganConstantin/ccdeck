import { describe, expect, it, vi } from "vitest";
import { mount, one } from "./fake-react";
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), ...(await import("./fake-react")).react }));
const { default: AccountTelemetry } = await import("../components/AccountTelemetry");
const { default: AnchoredPopover } = await import("../components/AnchoredPopover");

describe("account telemetry disclosure", () => {
  it("opens the complete privacy explanation and closes through the shared popover", () => {
    const telemetry = { text: "Telemetry · prompts", tone: "warn" as const, detail: "Example organization sends prompts to its collector. Seen 2h ago." };
    const view = mount(AccountTelemetry, { num: 3, name: "Work", telemetry });
    const trigger = () => one(view.tree, e => e.props.id === "ap-telemetry-mark-3")!;
    expect(trigger().props["aria-expanded"]).toBe(false);
    expect(trigger().props["aria-controls"]).toBeUndefined();
    expect(trigger().props.title).toBe(telemetry.detail);
    (trigger().props.onClick as () => void)();
    expect(trigger().props["aria-expanded"]).toBe(true);
    const popover = one(view.tree, e => e.type === AnchoredPopover)!;
    expect(popover.props.id).toBe(trigger().props["aria-controls"]);
    expect(popover.props.anchorId).toBe(trigger().props.id);
    expect(one(view.tree, e => e.props.className === "ap-pop-note")!.props.children).toBe(telemetry.detail);
    (popover.props.onClose as () => void)();
    expect(trigger().props["aria-expanded"]).toBe(false);
    expect(one(view.tree, e => e.type === AnchoredPopover)).toBeNull();
    view.unmount();
  });
});
