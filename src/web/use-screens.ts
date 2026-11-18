// The way in to Chat, its composer and the Decision card: one dynamic import,
// and a slot that draws nothing unless a flag is on and a screen was handed data.
//
// IMPORTS NO SCREEN. Types cross (they compile away); no value from
// components/chat/ or components/decision/ is imported here, so the pane that
// holds the slot costs the deck nothing until a screen is drawn. `loadScreens` is the
// only `import()` of components/screens.ts, named once (v4-screens-gate.test.ts).
//
// NOTHING IS FETCHED UNTIL A SCREEN IS DRAWN. The chunk is not preloaded: the
// slot renders a lazy component only when a flag is on, the view is Workspace
// and the caller handed it a source: the stage does that for a supported session,
// reading its conversation from the deck's transcript route
// (use-session-transcript.ts, asked only while Chat is on screen). So a deck
// with Chat on (the default) and Term showing makes no request, and logs no
// error. A stale tab after an upgrade, asking for a chunk the new build no
// longer has, draws nothing.
import { createElement, lazy, Suspense, useMemo, useState, type ComponentType } from "react";
import type { Provider } from "./types";
import type { ChatViewProps } from "./components/chat/ChatView";
import type { ChatSource } from "./components/chat/chat-model";
import type { ChatComposerProps } from "./components/chat/ChatComposer";
import type { DecisionCardProps } from "./components/decision/DecisionCard";
import { readScreenFlags, screensEffective, type ScreenFlags } from "./use-screen-flags";

export const loadScreens = () => import("./components/screens");

const Unavailable = () => null;

const LazyChatView = lazy(() => loadScreens().then(
  m => ({ default: m.ChatView as ComponentType<ChatViewProps> }),
  () => ({ default: Unavailable as ComponentType<ChatViewProps> }),
));
const LazyDecisionCard = lazy(() => loadScreens().then(
  m => ({ default: m.DecisionCard as ComponentType<DecisionCardProps> }),
  () => ({ default: Unavailable as ComponentType<DecisionCardProps> }),
));
const LazyChatComposer = lazy(() => loadScreens().then(
  m => ({ default: m.ChatComposer as ComponentType<ChatComposerProps> }),
  () => ({ default: Unavailable as ComponentType<ChatComposerProps> }),
));

/** Shares Chat's existing lazy chunk; Term never loads its input or styles. */
export function ChatComposerSlot(props: ChatComposerProps) {
  return createElement(Suspense, { fallback: null }, createElement(LazyChatComposer, props));
}

/** What the pane is handed to draw. Left out for a pane with no conversation to show. */
export interface ScreensProps {
  /** Which of the two the header's switch has on screen. */
  view: "chat" | "term";
  /** A transcript. With none there is nothing for Chat to show. */
  source?: ChatSource;
  provider?: Provider;
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
    return createElement(Suspense, { fallback: null }, createElement(LazyChatView, { source: screens.source!, provider: screens.provider, decision }));
  }
  if (decision) {
    return createElement(Suspense, { fallback: null }, createElement(LazyDecisionCard, decision));
  }
  return null;
}
