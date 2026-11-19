// #2637: with Workspace offered, a click on a Board card switches to Workspace
// with that card's session on the pane. The pane takes the keys, as the
// stage's own card click does: left on the deck, the first letters typed for
// the agent fired the deck's shortcuts instead (u opened Usage in the browser
// pass). Without Workspace the click is the stage's, exactly as it was.
import { describe, expect, it } from "vitest";
import { sourceOf } from "./client-source";
import { withoutComments } from "./tsx-scan";

const app = withoutComments(sourceOf("App.tsx"));
const stage = withoutComments(sourceOf("use-stage.ts"));

describe("a Board card clicked while Workspace is offered", () => {
  it("switches to Workspace with the card's terminal session", () => {
    expect(app).toMatch(/const openBoardNode = \(id: string, el: Element \| null\) => \{\s*if \(!stage\.workspaceOffered\) return stage\.onNodeClick\(id, el\);\s*switchView\("workspace", "pointer", terminalSessionId\(stateRef\.current\.agents, id\)\);\s*return true;\s*\};/);
    expect(app).toMatch(/useCanvasClicks\(\{[\s\S]*?stage: \{ onNodeClick: openBoardNode \}/);
  });

  it("puts that session on the pane with the keys in it, and lands its row", () => {
    const switchView = app.slice(app.indexOf("const switchView = useCallback("), app.indexOf("const switchViewRef"));
    expect(switchView).toMatch(/if \(sessionId\) \{\s*openInPane\(sessionId, \{ focusPane: true \}\);\s*markLanded\(sessionId\);\s*\}/);
  });

  it("takes the keys the way the stage's own card click does", () => {
    expect(stage).toMatch(/const onNodeClick = useCallback\([\s\S]*?openOn\(\{ kind: "session", id: sessionId \}, \{[^}]*focusPane: true[^}]*\}\);/);
    expect(stage).toMatch(/const openInPane = useCallback\(\(sessionId: string, opts: \{ focusPane\?: boolean \} = \{\}\) => \{[\s\S]*?focusPane: opts\.focusPane === true/);
  });

  it("leaves the keyboard's ways in alone: the view chord carries no session", () => {
    expect(app).not.toMatch(/switchView(?:Ref\.current)?\([^)]*"key"[^)]*,[^)]*\)/);
  });
});
