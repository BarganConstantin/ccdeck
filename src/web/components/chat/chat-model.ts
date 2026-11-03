// What Chat draws, as props. Types only: the turns are built on the server from
// the session's transcript (src/server/transcript-turns.mjs) and read through
// use-session-transcript.ts. A test hands ChatView a stand-in; every line below
// is transcript text, so none of it is held in src/.

/** One line of the conversation. */
export type ChatTurn =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      /** "Read", "Edit", "Bash"… */
      name: string;
      /** Its argument, one line: "src/server/routes.ts". */
      arg: string;
      /** The note at the row's end: "182 lines", "+4 −1", "running". */
      note?: string;
      /** The call is still in flight. */
      running?: boolean;
      /** Which mark the row wears. */
      mark?: "file" | "search" | "terminal";
    }
  /** What you answered and how long it took, after the card folds. */
  | { kind: "record"; text: string };

export interface ChatSince {
  toolCalls: number;
  /** "now asking", or what the session is doing now. */
  label: string;
}

export type ChatSource =
  | { state: "loading" }
  | { state: "error"; message: string; onRetry?(): void }
  | { state: "ready"; turns: ChatTurn[]; since?: ChatSince };
