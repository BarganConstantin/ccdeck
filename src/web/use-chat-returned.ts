// A message sent from Chat that the session did not take goes back into the
// composer, so it is not lost under the conversation as a line that says so.
//
// ONLY INTO AN EMPTY BOX. A draft written since is the person's and stays;
// then the message stays drawn where it was, as "not taken", with Show Term.
// Put back, it is no longer drawn under the conversation: the composer says
// why it is back (ChatComposer `notTaken`), once.
//
// TAKEN AFTER ALL. Chat says "not taken" when the session has not been seen
// to take it in time (chat-progress.ts); it can still take it later (it sat
// in Term's input behind a dialog). Then the words it took leave the box, if
// they are still the box's words, so they are not sent twice.
//
// Imports no screen: the stage's half, as chat-progress.ts is.
import { useEffect, useLayoutEffect, useState } from "react";
import type { ChatOutgoing } from "./components/chat/chat-model";

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface ChatReturned {
  /** What Chat draws under the conversation: the message, unless it is back in the box. */
  outgoing?: ChatOutgoing;
  /** The words put back in this session's box, while they are not taken. */
  text?: string;
}

export function useChatReturned(
  session: string,
  outgoing: ChatOutgoing | undefined,
  draft: string,
  setDraft: (text: string) => void,
): ChatReturned {
  const [returned, setReturned] = useState<Record<string, string>>({});
  const mine = returned[session];
  const late = outgoing?.state === "unconfirmed" ? outgoing.text : undefined;
  useBeforePaint(() => {
    if (late !== undefined && mine !== late) {
      // Late, and the box is free: the words go back.
      if (draft.trim() !== "") return;
      setReturned(all => ({ ...all, [session]: late }));
      setDraft(late);
      return;
    }
    if (mine === undefined || late === mine) return;
    // Taken after all, or sent again: no longer back in the box.
    setReturned(all => {
      const rest = { ...all };
      delete rest[session];
      return rest;
    });
    if (outgoing?.state !== "sending" && draft === mine) setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [late, mine, session, outgoing?.state]);
  const back = mine !== undefined && late === mine;
  return { outgoing: back ? undefined : outgoing, text: back ? mine : undefined };
}
