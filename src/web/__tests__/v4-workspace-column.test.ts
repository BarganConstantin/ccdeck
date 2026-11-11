// V4 Workspace's left column (review 12, as the coordinator restated it): entering
// Workspace at 1100px and wider puts the Sessions list in the column through the
// state L uses, remembering what it held; leaving gives that back unless the
// reader changed the column meanwhile; under 1100 nothing happens on entry; in
// Workspace the doors work as on the Board. Run as hooks under fake-react.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLeftColumn, useWorkspaceColumn } from "../use-left-column";
import { mount } from "./fake-react";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";

vi.mock("react", async () => (await import("./fake-react")).react);

let store: Map<string, string>;
beforeEach(() => {
  // CHANGED ON PURPOSE (owner, 2026-11-11): a fresh profile opens no panel now,
  // so the column these cases start from, Accounts open, is a reader's choice
  // on record. A case about an empty column stores "0" over it.
  store = new Map([["agent-dag.accountsPanelOpen", "1"]]);
  (globalThis as Record<string, unknown>).window = {
    innerWidth: 1440,
    matchMedia: () => ({ matches: false }),
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
    dispatchEvent: () => true,
  };
});
afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

interface Props { workspace: boolean; wide: boolean }
function Harness({ workspace, wide }: Props) {
  const column = useLeftColumn();
  useWorkspaceColumn({ active: workspace, wide, column });
  return column;
}
const setup = (props: Props) => {
  const view = mount(Harness, props);
  const col = () => view.tree as ReturnType<typeof useLeftColumn>;
  return { view, col, go: (next: Partial<Props>) => view.rerender({ ...props, ...next }) };
};

describe("entering Workspace at 1440 with Accounts left open", () => {
  it("shows the Sessions list, and leaving shows accounts again", () => {
    const { col, go } = setup({ workspace: false, wide: true });
    expect(col().panel).toBe("accounts");
    go({ workspace: true });
    expect(col().panel).toBe("session-list");
    go({ workspace: false });
    expect(col().panel, "what the column held comes back").toBe("accounts");
    expect(col().accountsPanelOpen).toBe(true);
  });

  it("gives back an empty column when it held nothing", () => {
    store.set("agent-dag.accountsPanelOpen", "0");
    const { col, go } = setup({ workspace: false, wide: true });
    expect(col().panel).toBeNull();
    go({ workspace: true });
    expect(col().panel).toBe("session-list");
    go({ workspace: false });
    expect(col().panel).toBeNull();
  });

  it("leaves a list that was already open alone, both ways", () => {
    store.set("agent-dag.sessionListOpen", "1");
    const { col, go } = setup({ workspace: false, wide: true });
    go({ workspace: true });
    expect(col().sessionListOpen).toBe(true);
    go({ workspace: false });
    expect(col().sessionListOpen, "it was the reader's, not ours to close").toBe(true);
  });
});

describe("entering at 1024", () => {
  it("opens no list: it is a sheet opened from its door (the accounts sheet is closed, see review E)", () => {
    const { col, go } = setup({ workspace: false, wide: false });
    go({ workspace: true });
    expect(col().sessionListOpen).toBe(false);
    go({ workspace: false });
    expect(col().panel).toBe("accounts");
  });
});

describe("entering under 1100 (review E)", () => {
  it("closes the accounts panel the column held, and leaving gives it back", () => {
    const { col, go } = setup({ workspace: false, wide: false });
    expect(col().panel).toBe("accounts");
    go({ workspace: true });
    expect(col().panel, "no column drawn over the pane").toBeNull();
    go({ workspace: false });
    expect(col().panel).toBe("accounts");
  });

  it("opens the list from its door inside Workspace, and leaving leaves it as the reader left it", () => {
    const { col, go } = setup({ workspace: false, wide: false });
    go({ workspace: true });
    col().toggleSessionList();
    expect(col().panel).toBe("session-list");
    go({ workspace: false });
    expect(col().panel).toBe("session-list");
    expect(col().accountsPanelOpen).toBe(false);
  });

  it("takes a list that was open away too, and gives it back", () => {
    store.set("agent-dag.sessionListOpen", "1");
    const { col, go } = setup({ workspace: false, wide: false });
    go({ workspace: true });
    expect(col().panel).toBeNull();
    go({ workspace: false });
    expect(col().panel).toBe("session-list");
  });

  it("forgets it when the reader opens accounts inside Workspace", () => {
    const { col, go } = setup({ workspace: false, wide: false });
    go({ workspace: true });
    col().toggleAccountsPanel();
    go({ workspace: false });
    expect(col().panel).toBe("accounts");
  });
});

describe("the doors in Workspace work as on the Board", () => {
  it("opening accounts inside Workspace sticks after leaving", () => {
    const { col, go } = setup({ workspace: false, wide: true });
    go({ workspace: true });
    expect(col().panel).toBe("session-list");
    col().toggleAccountsPanel();
    expect(col().panel).toBe("accounts");
    go({ workspace: false });
    expect(col().panel).toBe("accounts");
    expect(col().sessionListOpen).toBe(false);
  });

  it("opening accounts and leaving from an empty column keeps the reader's accounts", () => {
    store.set("agent-dag.accountsPanelOpen", "0");
    const { col, go } = setup({ workspace: false, wide: true });
    go({ workspace: true });
    col().toggleAccountsPanel();
    go({ workspace: false });
    expect(col().panel).toBe("accounts");
  });

  it("L inside Workspace closes the list at 1440", () => {
    const { col, go } = setup({ workspace: false, wide: true });
    go({ workspace: true });
    col().toggleSessionList();
    expect(col().sessionListOpen).toBe(false);
    go({ workspace: false });
    expect(col().sessionListOpen, "no memory left to act on").toBe(false);
  });

  it("L inside Workspace closes the list at 1024, and L opens it (the sheet)", () => {
    const { col, go } = setup({ workspace: false, wide: false });
    go({ workspace: true });
    col().toggleSessionList();
    expect(col().sessionListOpen).toBe(true);
    col().toggleSessionList();
    expect(col().sessionListOpen).toBe(false);
    go({ workspace: false });
    expect(col().sessionListOpen).toBe(false);
  });
});

describe("nothing is forced at render", () => {
  it("App draws the Board's column from the Board's flags, in every view", () => {
    const app = withoutComments(sourceOf("App.tsx"));
    expect(app).toContain("{(sessionListDrawn || accountsDrawn) && (");
    expect(app).toContain("<LeftColumn width={leftColumnTarget}>");
    expect(app).toContain("useWorkspaceColumn({ active: inWorkspace && stage.enabled,");
    expect(app).not.toContain("columnDrawn");
    expect(app).not.toContain("workspaceColumnWidth");
  });
});

describe("what Workspace does to the column is not stored", () => {
  // The deck remembers the column across a reload (the two open flags). The
  // list Workspace puts there, and the column it empties under 1100, are its
  // own doing: written, a reload in Workspace (or a crash) came back to a list
  // the reader never opened, or to no column at all.
  it("keeps the reader's column in storage while the list is put in it, and gives it back", () => {
    const { go } = setup({ workspace: false, wide: true });
    expect(store.get("agent-dag.accountsPanelOpen")).toBe("1");
    expect(store.get("agent-dag.sessionListOpen")).toBe("0");
    go({ workspace: true });
    expect(store.get("agent-dag.sessionListOpen"), "the list is Workspace's, not stored open").toBe("0");
    expect(store.get("agent-dag.accountsPanelOpen"), "accounts are evicted, not closed").toBe("1");
    go({ workspace: false });
    expect(store.get("agent-dag.sessionListOpen")).toBe("0");
    expect(store.get("agent-dag.accountsPanelOpen")).toBe("1");
  });

  it("comes back to the same column after a reload in Workspace, and leaving still restores it", () => {
    const first = setup({ workspace: false, wide: true });
    first.go({ workspace: true });
    // The reload: a new page reads what was stored.
    const second = setup({ workspace: true, wide: true });
    expect(second.col().panel).toBe("session-list");
    second.go({ workspace: false });
    expect(second.col().panel, "accounts, as the reader left them").toBe("accounts");
    expect(store.get("agent-dag.accountsPanelOpen")).toBe("1");
  });

  it("keeps both flags under 1100, where entering empties the column", () => {
    const { col, go } = setup({ workspace: false, wide: false });
    go({ workspace: true });
    expect(col().panel).toBeNull();
    expect(store.get("agent-dag.accountsPanelOpen"), "emptied for the view, not by the reader").toBe("1");
    go({ workspace: false });
    expect(col().panel).toBe("accounts");
    expect(store.get("agent-dag.accountsPanelOpen")).toBe("1");
  });

  it("stores what the reader does with the column inside Workspace, and only that", () => {
    // Under 1100 entering empties the column (Workspace's doing, not stored).
    // The reader then opens the Sessions sheet: that flag is theirs and is
    // written; the Accounts panel they never closed stays stored open.
    const { col, go, view } = setup({ workspace: false, wide: false });
    expect(store.get("agent-dag.sessionListOpen")).toBe("0");
    go({ workspace: true });
    expect(col().panel).toBeNull();
    col().toggleSessionList();
    view.rerender();
    expect(store.get("agent-dag.sessionListOpen"), "the reader's own open").toBe("1");
    expect(store.get("agent-dag.accountsPanelOpen"), "never closed by the reader").toBe("1");
  });

  it("keeps a wide reader's own Accounts open too, and the list it was never given", () => {
    store.set("agent-dag.accountsPanelOpen", "0");
    const { col, go, view } = setup({ workspace: false, wide: true });
    go({ workspace: true });
    expect(col().panel).toBe("session-list");
    col().openAccountsPanel();
    view.rerender();
    expect(store.get("agent-dag.accountsPanelOpen")).toBe("1");
    expect(store.get("agent-dag.sessionListOpen")).toBe("0");
  });
});
