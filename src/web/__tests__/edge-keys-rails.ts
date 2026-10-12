// The deck's chrome controls drawn without a DOM, for the suites that ask what
// a stripe, the dock, the topbar's utilities or the waiting count say to
// assistive tech. No suites here: importing a *.test.ts registers its suites
// into the importer as well, so the shared half is a plain module.
//
// renderToStaticMarkup runs no effects. The two layout effects these
// components carry — the stripe word's whole-pixel length and the keyboard's
// hand-over between the stripes and the dock — measure a DOM that is not
// here, and React says so once per component on the server renderer. That
// warning is about rendering on a server, which the deck never does, so it is
// dropped here and every other console.error still reaches the run.
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { railItems, type RailItems } from "../rail-items";

const noop = () => {};
const ref = () => ({ current: null });

/** The chrome's eight controls, with the state a case wants and every press a
 *  no-op. Claude Code installed unless said otherwise. */
export function items(state: Partial<{
  claude: boolean;
  codex: boolean;
  sessionListOpen: boolean;
  accountsPanelOpen: boolean;
  usagePanelOpen: boolean;
  machinePanelOpen: boolean;
  watchOn: boolean | null;
  watchUnseen: number;
}> = {}): RailItems {
  return railItems({
    providers: { kind: "reported", claude: state.claude ?? true, codex: state.codex ?? true } as never,
    sessionListOpen: state.sessionListOpen ?? false, toggleSessionList: noop,
    accountsPanelOpen: state.accountsPanelOpen ?? false, toggleAccountsPanel: noop,
    usagePanelOpen: state.usagePanelOpen ?? false, setUsagePanelOpen: noop,
    machinePanelOpen: state.machinePanelOpen ?? false, setMachinePanelOpen: noop,
    setUsageHistoryOpen: noop, watchOn: state.watchOn ?? false, watchUnseen: state.watchUnseen ?? 0,
    setBrowserWatchOpen: noop, openSettings: noop, onFeedback: noop,
    toggles: { sessionList: ref(), usage: ref(), accounts: ref(), machine: ref() } as never,
  });
}

/** The markup of an element, without the server renderer's layout-effect warning. */
export function draw(element: ReactElement): string {
  const error = console.error;
  console.error = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
    error(...args);
  };
  try {
    return renderToStaticMarkup(element);
  } finally {
    console.error = error;
  }
}

/** Every <button …> opening tag in the markup, keyed by its data-rail-item. */
export function buttons(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<button\b[^>]*>/g)) {
    const id = /data-rail-item="([\w-]+)"/.exec(m[0])?.[1];
    if (id) out.set(id, m[0]);
  }
  return out;
}

/** One attribute of an opening tag, or null where it is not drawn. */
export function attr(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

export { createElement };
