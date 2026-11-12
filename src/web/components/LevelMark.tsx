// A warning colour never stands alone (WCAG 1.4.1). A figure the deck paints
// --warn or --err for its level wears the warning mark before it and a word
// after it, "⚠ 92% · high", all three in the figure's tone, in every theme.
// Below its level the figure is drawn as it always was, with nothing around it.
// With no figure inside (a cell too narrow to widen its head), it is the mark
// and the word alone: "⚠ hot".
import type { ReactNode } from "react";
import { useT } from "../i18n";
import { KitIcon } from "./kit-icons";

export type LevelTone = "warn" | "err";
/** "high" for an amount (a quota, memory, a GPU's load), "hot" for heat. */
export type LevelWord = "high" | "hot";

const WORD_KEY: Record<LevelWord, string> = { high: "common.level.high", hot: "common.level.hot" };

export function LevelMark({ tone, word, children }: { tone: LevelTone | null | undefined; word: LevelWord; children?: ReactNode }) {
  const t = useT();
  if (!tone) return <>{children}</>;
  return (
    <span className="level-mark" data-tone={tone}>
      <KitIcon name="warning" className="level-mark-glyph" />
      {children}
      {children != null && <span className="level-mark-dot" aria-hidden="true">·</span>}
      <span className="level-mark-word">{t(WORD_KEY[word])}</span>
    </span>
  );
}
