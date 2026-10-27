// Development-only replay: import from a Vite page and call replayTranslation().
// A translator replaces text nodes with nested fonts. Adding the online mark
// must still update the status, and remove it again, without a DOM exception.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import LanEntryRow from "../../components/LanEntryRow";

const noop = () => {};

export function replayTranslation() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (live: boolean) => flushSync(() => root.render(
    <LanEntryRow entry={{ live, text: live ? "1 online" : "none online", tone: live ? "ok" : "idle" }}
      rows={[]} onOpen={noop} peek={false} openPeek={noop} shutPeek={noop} holdPeek={noop} dropPeek={noop} />,
  ));
  try {
    render(false);
    const status = host.querySelector(".ap-nav-state")!;
    const walker = document.createTreeWalker(status, NodeFilter.SHOW_TEXT);
    const text: Text[] = [];
    while (walker.nextNode()) text.push(walker.currentNode as Text);
    for (const node of text) {
      const outer = document.createElement("font");
      const inner = document.createElement("font");
      inner.textContent = node.textContent;
      outer.append(inner);
      node.replaceWith(outer);
    }
    render(true);
    const online = status.textContent === "1 online" && !!status.querySelector(".ap-nav-live");
    render(false);
    const offline = status.textContent === "none online" && !status.querySelector(".ap-nav-live");
    if (!online || !offline) throw new Error("The translated network state did not update");
    return { online, offline };
  } finally {
    root.unmount();
    host.remove();
  }
}
