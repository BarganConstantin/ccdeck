// Three small decisions the usage panel makes — which board rows are worth a
// line, whether the note about unpriced tokens is owed, and what the header's
// ↻ is called — as functions a test can call.
//
// Lifted out of components/UsagePanel.tsx, where each was an expression in the
// render and the row rule was written out twice, once per board table. The
// notes that say why each is decided the way it is came with them.
import type { BoardModelRow, BoardSessionRow } from "./board-usage";
import type { Providers } from "./providers";
import type { ModelRow } from "./usage-from-ccusage";

/**
 * Whether a board row is worth a line, which is not the same question as
 * whether it is worth a dollar.
 *
 * Both tables used to filter on `cost > 0`, and in a deck holding one priced
 * Claude session and any number of unpriced Codex ones that filter was
 * invisible: `hasCost` was true, so the tables rendered, and every Codex row
 * was dropped out of them while its tokens stayed in the strip above. The
 * panel's own headline number then matched no visible row — the arithmetic
 * was right and there was nothing on screen to reconcile it against.
 *
 * One rule for both tables. A model row carries its dollars as a breakdown and
 * a session row as one figure; either is worth a line when it has either
 * dollars or tokens.
 */
export function worthALine(row: BoardModelRow | BoardSessionRow): boolean {
  const dollars = typeof row.cost === "number" ? row.cost : row.cost.total;
  return dollars > 0 || (row.inputTokens + row.outputTokens) > 0;
}

/**
 * Whether the panel owes the reader its note about unpriced tokens: tokens on
 * screen whose dollars are not in the total above them.
 *
 * A model ccusage priced at nothing is one IT does not know, and the note
 * means the same thing either way: these tokens are real and their dollars are
 * not in the total above them. A board row carries its own `priced` flag. Same
 * words, two different questions — so it is asked of whichever source the
 * figures are from.
 */
export function anyUnpriced(fromRange: boolean, rangeModelRows: ModelRow[], boardModelRows: BoardModelRow[]): boolean {
  return fromRange
    ? rangeModelRows.some(m => m.cost <= 0 && m.tokens > 0)
    : boardModelRows.some(m => !m.priced);
}

/**
 * What the header's ↻ is called, which is also what it says on hover: named
 * after the quota sections actually below it, per provider, so it can never
 * promise a section the panel is not rendering. The panel does not draw the
 * button at all when neither CLI is watched, so the last answer is only ever
 * read on a Claude-only deck.
 */
export function quotaRefreshLabel(providers: Providers): string {
  return providers.claude && providers.codex
    ? "Refresh Claude + Codex quota"
    : providers.codex ? "Refresh Codex quota"
      : "Refresh Claude quota";
}
