// The Decision card's data, as props. Types only: nothing here is a value, and
// nothing in the deck builds one. The card draws what it is handed; a harness
// or a test hands it a stand-in.

export type DecisionKind = "permission" | "plan" | "question";

export interface DecisionOptionModel {
  /** The row's title: "Yes, run it". */
  label: string;
  /** Its line under the title: "Runs once. The next command asks again." */
  sub: string;
  /** Changes the session's rules or mode, so only in the terminal. */
  locked?: boolean;
  /** Said on a locked row, after a lock mark. */
  lockNote?: string;
  /** Claude's pick: a small tag on the right of the row. */
  pick?: boolean;
  /** Choosing it opens a field in place ("No, tell Claude what to do instead"). */
  free?: boolean;
}

export interface DecisionModel {
  /** Which question this is. A card keyed by it starts over on a new one. */
  id?: string;
  kind: DecisionKind;
  title: string;
  /** What would run, one line in mono. */
  command?: string;
  /** A plan to approve, as prose steps. */
  plan?: string[];
  /** The line under the command or the plan. */
  caption: string;
  /** One to three rows. */
  options: DecisionOptionModel[];
  /** Pick any: rows are checkboxes. */
  multi?: boolean;
  /** Started by this deck, or by something outside it (answered only there). */
  origin: "launched" | "outside";
  /** The session's name. */
  session: string;
  /** Seconds the question has waited. */
  since?: number;
}

/** What the host says happened after it re-read the prompt, or on its own. */
export type DecisionOutcomeInput =
  | { kind: "changed"; now: string }
  | { kind: "ended" }
  | { kind: "held" }
  | { kind: "elsewhere"; at: string };

/** What a re-read of the live prompt found. */
export type RecheckResult = "ok" | Exclude<DecisionOutcomeInput, { kind: "elsewhere" }>;

/** What was picked. */
export type DecisionAnswer =
  | { kind: "option"; index: number }
  | { kind: "text"; index: number; text: string }
  | { kind: "many"; indexes: number[] };

/** What the card asks of its host. All optional, and the deck passes none. */
export interface DecisionHooks {
  /** Re-read the live prompt. Nothing is sent until it says "ok". With none, a
   *  pick sends nothing and the card stays as it is. */
  recheck?(answer: DecisionAnswer): Promise<RecheckResult>;
  onAnswer?(answer: DecisionAnswer): void;
  /** The answer went out: the host writes the record line in the chat. */
  onRecord?(answer: DecisionAnswer): void;
  onClose?(): void;
  onShowTerm?(): void;
  /** "Show it": the question that replaced this one. */
  onShowNew?(): void;
  onOpenTranscript?(): void;
}
