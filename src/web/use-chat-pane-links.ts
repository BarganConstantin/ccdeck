// What a Workspace pane tells the rest of the deck about its Chat | Term
// switch, and hears from it (chat-view-memory.ts): a request to show a session
// in Chat (an alert, a notification), the chord that turns the focused pane's
// switch, and which session it shows in Chat, which the alert stack leaves to
// the Decision card in front of the reader.
import { useEffect, useRef } from "react";
import { onChatViewRequest, setShownInChat, setViewToggle } from "./chat-view-memory";

export interface ChatPaneLinks {
  /** The session the pane can show in Chat, or null. */
  chatSession: string | null;
  /** Chat is on screen in this pane. */
  chatOn: boolean;
  /** The pane is the Workspace's focused one: the chord is its. */
  focused: boolean;
  showChat(): void;
  toggle(): void;
}

export function useChatPaneLinks(o: ChatPaneLinks): void {
  const pane = useRef({});
  const live = useRef(o);
  live.current = o;
  const { chatSession, chatOn, focused } = o;

  useEffect(() => onChatViewRequest(sessionId => {
    if (sessionId === live.current.chatSession) live.current.showChat();
  }), []);

  useEffect(() => {
    const me = pane.current;
    setViewToggle(me, focused && chatSession !== null ? () => live.current.toggle() : null);
    return () => setViewToggle(me, null);
  }, [focused, chatSession]);

  useEffect(() => {
    const me = pane.current;
    setShownInChat(me, chatOn ? chatSession : null);
    return () => setShownInChat(me, null);
  }, [chatOn, chatSession]);
}
