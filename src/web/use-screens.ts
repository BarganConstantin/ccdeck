// The way in to Chat and the Decision card: one dynamic import, two lazy doors,
// and a slot that draws nothing unless a flag is on and a screen was handed data.
//
// IMPORTS NO SCREEN. Types cross (they compile away); no value from
// components/chat/ or components/decision/ is imported here, so the pane that
// holds the slot costs the deck nothing with the flags off. `loadScreens` is the
// only `import()` of components/screens.ts, named once (v4-screens-gate.test.ts).
//
// NOTHING IS FETCHED UNTIL A SCREEN IS DRAWN. The chunk is not preloaded: the
// slot renders a lazy component only when a flag is on, the view is Workspace
// and the caller handed it a source or a question, which the deck never does
// (it has no transcript). So a deck with a flag set by hand makes no request,
// shows no switch and logs no error. A stale tab after an upgrade, asking for a
// chunk the new build no longer has, draws nothing.
import { createElement, lazy, Suspense, useMemo, useState, type ComponentType } from "react";
import type { ChatSource } from "./components/chat/chat-model";
import type { DecisionCardProps } from "./components/decision/DecisionCard";
import { readScreenFlags, screensEffective, type ScreenFlags } from "./use-screen-flags";

export const loadScreens = () => import("./components/screens");

const Unavailable = () => null;

const LazyChatView = lazy(() => loadScreens().then(
  m => ({ default: m.ChatView as ComponentType<{ source: ChatSource; decision?: DecisionCardProps }> }),
  () => ({ default: Unavailable as ComponentType<{ source: ChatSource; decision?: DecisionCardProps }> }),
));
const LazyDecisionCard = lazy(() => loadScreens().then(
  m => ({ default: m.DecisionCard as ComponentType<DecisionCardProps> }),
  () => ({ default: Unavailable as ComponentType<DecisionCardProps> }),
));

/** What the pane is handed to draw. Left out entirely in the deck. */
export interface ScreensProps {
  /** Which of the two the header's switch has on screen. */
  view: "chat" | "term";
  /** A transcript. With none there is nothing for Chat to show. */
  source?: ChatSource;
  /** A question to dock under the chat, or alone under the terminal. */
  decision?: DecisionCardProps;
}

/** The flags as they count in this pane: read once, then gated by where the pane is. */
export function useScreenFlags(workspace: boolean): ScreenFlags {
  const [stored] = useState<ScreenFlags>(readScreenFlags);
  // The stage exists only where the Command Panel's gate is on, and no phone has Workspace.
  return useMemo(() => screensEffective(stored, { gate: true, workspace, phone: false }), [stored, workspace]);
}

/** Whether the pane shows Chat in place of the terminal. */
export function chatShown(flags: ScreenFlags, screens: ScreensProps | undefined): boolean {
  return flags.chat && !!screens && screens.view === "chat" && !!screens.source;
}

/** The slot: nothing at all unless a screen is on and has data. */
export function ScreensSlot({ screens, flags }: { screens?: ScreensProps; flags: ScreenFlags }) {
  if (!screens) return null;
  const decision = flags.decision ? screens.decision : undefined;
  if (chatShown(flags, screens)) {
    return createElement(Suspense, { fallback: null }, createElement(LazyChatView, { source: screens.source!, decision }));
  }
  if (decision) {
    return createElement(Suspense, { fallback: null }, createElement(LazyDecisionCard, decision));
  }
  return null;
}
