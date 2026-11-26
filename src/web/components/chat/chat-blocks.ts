// The blocks of the conversation as ChatView draws them: each one redrawn only
// when what it shows changed (chat-live.ts says when that is). The stage above
// Chat draws again on every clock tick, every key typed in the composer and
// every event the board hears; without these the whole conversation, up to
// 2000 turns, was drawn again each time.
import { memo } from "react";
import { AssistantBlock, RecordLine, YourCommand, YourMessage } from "./ChatTurn";
import { sameBlockProps } from "./chat-live";

/** A reply of the assistant's: its turns compared one by one (sameBlockProps). */
export const MemoAssistantBlock = memo(AssistantBlock, sameBlockProps);
/** Your message, your command and a record: props that are words and counts, or one kept turn. */
export const MemoYourMessage = memo(YourMessage);
export const MemoYourCommand = memo(YourCommand);
export const MemoRecordLine = memo(RecordLine);
