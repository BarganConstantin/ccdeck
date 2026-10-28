// The feedback dialog's two tabs while a ccdeck account is connected: Write,
// the form it always was, and Your conversations, the threads that form starts
// with the people who make ccdeck (feedback-unread.ts, FeedbackConversations).
//
// A REAL TAB WIDGET (tablist-keys.ts, tablist-contract.test.ts): the strip is
// one tab stop, ←/→/Home/End walk it and select as they land, each tab names
// the panel it controls and each panel the tab it is under. Both panels stay
// mounted, so a half-written message survives a look at the conversations and
// a reply draft survives a look back; the one not shown is `hidden`.
//
// IN THE MAIN BUNDLE, AND NOTHING OF THE ACCOUNT IN IT. Without an account the
// dialog never draws this. Your conversations is a chunk of its own
// (FeedbackConversations.tsx), fetched the first time the tab is drawn, behind
// a small boundary of its own: a chunk that does not arrive — the deck updated
// under an open tab — says so with a reload, LazyDialog.tsx's way, and a panel
// that throws says the same, instead of taking the deck down to the crash pane.
import { Component, Suspense, lazy, useRef, type ComponentType, type ErrorInfo, type ReactNode, type RefObject } from "react";
import { tabStripMove } from "../tablist-keys";
import { CONVERSATIONS_TAB, WRITE_TAB, type FeedbackTab } from "../feedback";
import type { FeedbackAccount } from "../feedback-unread";

const TABS: readonly FeedbackTab[] = ["write", "conversations"];

/** What the conversations chunk is handed. */
export interface ConversationsProps {
  account: FeedbackAccount;
  /** Whether its tab is the one shown: it fetches when it opens, not before. */
  active: boolean;
  /** Says something in the dialog's one live region. */
  announce: (words: string) => void;
}

/** Said when the conversations could not be drawn at all. */
export const CONVERSATIONS_DID_NOT_LOAD = "Couldn't load your conversations. Reload the deck.";

/** The note a missing chunk or a thrown panel leaves, with the reload that
 *  fixes the first. */
export function ConversationsDidNotLoad() {
  return (
    <div className="fc-missing">
      <p className="fc-note">{CONVERSATIONS_DID_NOT_LOAD}</p>
      <button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}

/** The chunk, settling on the note rather than on the error when it does not
 *  arrive — a tab older than the deck asking for a name the build no longer
 *  has. Not a crash, so nothing is reported. */
export const FeedbackConversations = lazy((): Promise<{ default: ComponentType<ConversationsProps> }> =>
  import("./FeedbackConversations").catch((err: unknown) => {
    console.warn("ccdeck could not load your conversations", err);
    return { default: ConversationsDidNotLoad };
  }),
);

/** The small boundary round the panel: a render error inside it stays inside
 *  it, said and logged, and the dialog and the deck stay up. */
export class ConversationsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ccdeck could not draw your conversations", error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? <ConversationsDidNotLoad /> : this.props.children;
  }
}

/** Your conversations' panel content: the chunk, its boundary and nothing
 *  while it loads (the panel's own loading line is the chunk's). */
export function ConversationsPanel(props: ConversationsProps) {
  return (
    <ConversationsBoundary>
      <Suspense fallback={null}>
        <FeedbackConversations {...props} />
      </Suspense>
    </ConversationsBoundary>
  );
}

/** How the count on Your conversations reads to a screen reader: the badge
 *  itself is hidden, so the tab's name says it. */
export function conversationsTabLabel(unread: number): string | undefined {
  return unread > 0 ? `${CONVERSATIONS_TAB}, ${unread} unread` : undefined;
}

export default function FeedbackTabs({ tab, onTab, unread, conversationsTabRef, write, conversations }: {
  tab: FeedbackTab;
  onTab: (tab: FeedbackTab) => void;
  /** Conversations with a reply not yet seen: the grey count on the tab. */
  unread: number;
  /** The tab the dialog focuses when it opens on Your conversations. */
  conversationsTabRef?: RefObject<HTMLButtonElement>;
  write: ReactNode;
  conversations: ReactNode;
}) {
  const writeRef = useRef<HTMLButtonElement>(null);
  const ownConversationsRef = useRef<HTMLButtonElement>(null);
  const convRef = conversationsTabRef ?? ownConversationsRef;
  const refs = [writeRef, convRef];
  return (
    <>
      {/* Written out rather than mapped, so each tab names its panel's id as
          the panel spells it. */}
      <div className="fc-tabs" role="tablist" aria-label="Feedback"
        onKeyDown={e => {
          const move = tabStripMove(e.nativeEvent, TABS.indexOf(tab), TABS.length);
          if (move.kind !== "select") return;
          e.preventDefault();
          onTab(TABS[move.index]);
          refs[move.index].current?.focus();
        }}>
        <button ref={writeRef} type="button" id="fc-tab-write" className="fc-tab" role="tab"
          aria-selected={tab === "write"} aria-controls="fc-panel-write" tabIndex={tab === "write" ? 0 : -1}
          onClick={() => onTab("write")}>
          {WRITE_TAB}
        </button>
        <button ref={convRef} type="button" id="fc-tab-conversations" className="fc-tab" role="tab"
          aria-selected={tab === "conversations"} aria-controls="fc-panel-conversations" tabIndex={tab === "conversations" ? 0 : -1}
          aria-label={conversationsTabLabel(unread)} onClick={() => onTab("conversations")}>
          {CONVERSATIONS_TAB}
          {unread > 0 && <span className="fc-tab-count" aria-hidden="true">{unread}</span>}
        </button>
      </div>
      <div className="fc-panel" id="fc-panel-write" role="tabpanel" aria-labelledby="fc-tab-write" hidden={tab !== "write"}>
        {write}
      </div>
      <div className="fc-panel" id="fc-panel-conversations" role="tabpanel" aria-labelledby="fc-tab-conversations" hidden={tab !== "conversations"}>
        {conversations}
      </div>
    </>
  );
}
