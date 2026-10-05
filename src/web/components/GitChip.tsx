import React, { useLayoutEffect, useRef, useState } from "react";
import { fitBranch, type BranchChip } from "../git-chip";
import { openGitFor } from "../git-open";

/** The card's widest inner width: agent-node.css's `max-width` less its
 *  padding and edge (260 − 16 − 12 − 2). Stated rather than read off the
 *  computed style, which nothing on the canvas may ask for on a render
 *  (render-path-cost-612-613.test.ts); git-chip.test.ts holds it to the sheet. */
export const CARD_INNER_MAX = 230;
/** The gap the chip keeps from what is before it, as the model chip keeps 6px
 *  from its own neighbour. */
const CHIP_GAP = 6;
/** Fewer letters than this fit, and the chip shows its glyph alone. */
const BARE_BELOW = 5;
/** The sheet's gap between the glyph and the name (`.git-chip`). */
const NAME_GAP = 4;

/**
 * The branch on a card's sub row, shortened in the middle to the room the row
 * leaves it at the card's widest, full name in the tooltip.
 *
 * The room is worked out from the card's maximum width and what else is on the
 * row — never from the card's current width, which the chip itself widens — so
 * the label settles in one pass and does not grow and shrink the card. `row` is
 * what else the row says, so the label is fitted again when that changes. The
 * name is monospace, so one character's width, read off the rendered label,
 * measures every spelling.
 */
export default function GitChip({ agentId, chip, row }: { agentId: string; chip: BranchChip; row: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [label, setLabel] = useState(chip.name);
  /** No room for even a few letters: the glyph alone. */
  const [bare, setBare] = useState(false);
  /** One character of the name, measured while the name was showing — the
   *  chip mounts with it showing, and a bare chip has nothing to measure. */
  const charRef = useRef(0);

  useLayoutEffect(() => {
    const el = ref.current;
    const name = el?.querySelector<HTMLElement>(".git-chip-name");
    const sub = el?.parentElement;
    const whole = () => { setLabel(chip.name); setBare(false); };
    if (!el || !name || !sub || chip.kind === "detached") { whole(); return; }
    const bareNow = el.hasAttribute("data-bare");
    if (!bareNow && name.textContent) charRef.current = name.scrollWidth / name.textContent.length;
    const charWidth = charRef.current;
    // The canvas is scaled; offsetWidth is not, and a rect is. One ratio
    // turns the rects back into the card's own units.
    const rowBox = sub.getBoundingClientRect();
    const scale = sub.offsetWidth > 0 ? rowBox.width / sub.offsetWidth : 0;
    if (!(scale > 0) || !(charWidth > 0)) { whole(); return; }
    let right = rowBox.left;
    for (const n of Array.from(sub.childNodes)) {
      if (n === el) continue;
      let box: DOMRect | null = null;
      if (n instanceof Element) box = n.getBoundingClientRect();
      else if (n.nodeType === Node.TEXT_NODE && n.textContent) {
        const range = document.createRange();
        range.selectNodeContents(n);
        box = range.getBoundingClientRect();
      }
      if (box && box.width > 0) right = Math.max(right, box.right);
    }
    const used = (right - rowBox.left) / scale;
    // The glyph, the gap, the padding and the edge — the gap being the 4px
    // between glyph and name, which a bare chip does not draw.
    const chrome = bareNow ? el.offsetWidth + NAME_GAP : el.offsetWidth - name.offsetWidth;
    const room = CARD_INNER_MAX - used - CHIP_GAP - chrome - 1;
    // What is left may be less than the shortest spelling; the ellipsis in the
    // sheet takes it from there, and the tooltip still has the whole name.
    // Under five letters' room there is nothing worth reading, and the glyph
    // stands alone.
    setLabel(fitBranch(chip.name, text => text.length * charWidth <= room));
    setBare(room < BARE_BELOW * charWidth);
  }, [chip.name, chip.kind, row]);

  return (
    <button
      ref={ref}
      type="button"
      className="git-chip"
      data-kind={chip.kind}
      data-bare={bare ? "" : undefined}
      title={chip.title}
      aria-label={chip.label}
      // The card's own click selects it and goes to its session; this one is
      // a press on the chip alone, and opens the agent's details.
      onClick={e => { e.stopPropagation(); openGitFor(agentId); }}
      onDoubleClick={e => e.stopPropagation()}
    >
      {chip.kind === "detached" ? <CommitGlyph /> : <BranchGlyph />}
      <span className="git-chip-name">{label}</span>
    </button>
  );
}

function BranchGlyph() {
  return (
    <svg className="git-chip-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="4.4" cy="3.3" r="1.4" /><circle cx="4.4" cy="10.7" r="1.4" /><circle cx="9.8" cy="4.6" r="1.4" />
      <path d="M4.4 4.7v4.6M9.8 6c0 2.4-2.2 2.8-5.2 3.5" />
    </svg>
  );
}

function CommitGlyph() {
  return (
    <svg className="git-chip-glyph" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="2.3" /><path d="M1.6 7h3.1M9.3 7h3.1" />
    </svg>
  );
}
