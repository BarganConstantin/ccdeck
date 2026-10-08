// A history read that failed while the working tree and the refs read fine:
// a missing object, git taking too long on a huge repository, the size cap.
// The history pane said nothing at all, and a ref pressed in the sidebar said
// "The history is still loading." for as long as the view stayed open.
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HistoryFailed } from "../components/GitViewParts";
import { sourceOf } from "./client-source";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("a history that could not be read", () => {
  it("says so, and why, with a way to read it again", () => {
    const html = renderToStaticMarkup(createElement(HistoryFailed, { reason: "error", onRetry: () => {} }));
    expect(text(html)).toBe("Could not read the history. git could not read it. Try again");
    expect(html).toMatch(/<button type="button" class="btn gv-retry">Try again<\/button>/);
  });

  it("offers nothing reading again cannot mend", () => {
    expect(text(renderToStaticMarkup(createElement(HistoryFailed, { reason: "timeout", onRetry: () => {} })))).toBe("Could not read the history. git took too long to answer. Try again");
    expect(text(renderToStaticMarkup(createElement(HistoryFailed, { reason: "too-large", onRetry: () => {} })))).toBe("Could not read the history. The answer was too large.");
  });

  it("is drawn in both looks' history panes, and a ref pressed then says the history could not be read", () => {
    const view = sourceOf("components/GitView.tsx");
    const failed = /\{!reading && !data\.commits && data\.logReason && <HistoryFailed reason=\{data\.logReason\} onRetry=\{retryRead\} \/>\}/g;
    expect(view.match(failed)).toHaveLength(2);
    expect(view).toMatch(/const retryRead = useCallback\(\(\) => readAgain\(agent\.sessionId, agentParam, ownFolder\), \[agent\.sessionId, agentParam, ownFolder\]\);/);
    expect(view).toMatch(/const text = !data\.commits \? \(data\.logReason \? "The history could not be read\." : "The history is still loading\."\)/);
  });
});
