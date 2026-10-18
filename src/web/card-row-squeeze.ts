// What a card's model row gives up when it is tight (#2155, #2169).
//
// The row reads "session → 1 Opus 5.5 · xhigh" or "subagent · <folder> Sonnet
// 5.5 · medium", and a busy card has about 176px for it. AgentNode draws it
// whole, measures, and steps down one notch per paint while the row overflows
// or a subagent's folder is cut short. The order is what the card says
// elsewhere first: the kind word (the spawn badge, the edge to the session and
// the card's accessible name all say it), then the effort (the chip's tooltip,
// the session list, the peek and the details panel keep it). The folder is cut
// short last, on its own, and the model is never dropped.

/** How far the row may step down: nothing to protect without a chip, and
 *  nothing past the kind word without an effort in it. */
export function maxSqueeze(a: { model?: string | null; provider?: string; effort?: string | null }): number {
  if (!a.model && a.provider !== "codex") return 0;
  return a.model && a.effort ? 2 : 1;
}

/** The next notch, given what the last paint measured. */
export function nextSqueeze(squeeze: number, measured: { overflowing: boolean; folderCut: boolean; max: number }): number {
  return (measured.overflowing || measured.folderCut) && squeeze < measured.max ? squeeze + 1 : squeeze;
}

/** What the row draws at a notch. */
export function rowAt(squeeze: number): { kind: boolean; effort: boolean } {
  return { kind: squeeze < 1, effort: squeeze < 2 };
}
