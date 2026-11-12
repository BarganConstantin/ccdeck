// The pane's text size, in its header: one glyph, and a small popover with
// −, the percent and +.
//
// ONE MORE GLYPH, NOT A ROW. The header holds ⌨, ⤢ and ✕; a stepper drawn
// there for good would be three more controls the eye passes on every look, for
// a setting chosen once per screen. So the header gets one 24px glyph, a large
// A beside a small one, and the stepper opens under it. The glyph is filled
// while the text is at another size than 100%, as Zoom's ⤢ is while it is on,
// so a pane whose text was made larger says so without a word.
//
// THE KEYS ARE NAMED IN IT. The keyboard is the quick way — Ctrl and = / - / 0
// while typing, ⌘ on a Mac (terminal-text-size.ts) — and the popover's last
// line says so, which is how the reader learns the chords exist at all.
//
// Pressing − or + leaves the popover open, so a reader can step twice; Escape,
// a press outside it, or the glyph again closes it, and focus goes back to the
// glyph (AnchoredPopover, use-modal-dismiss). At either end a button is
// aria-disabled, never `disabled`: it holds the focus at the moment it reaches
// the end, and a disabled button would drop it to the page.
import { useRef, useState } from "react";
import AnchoredPopover from "../AnchoredPopover";
import { KitIcon } from "../kit-icons";
import { useT } from "../../i18n";
import { formatPercent } from "../../i18n/format";
import {
  DEFAULT_STEP,
  canGoLarger,
  canGoSmaller,
  textSizeKeysLabel,
  type TextStepDirection,
} from "../../terminal-text-size";

export const TEXT_SIZE_ID = "ts-text-size";
const TEXT_SIZE_POP_ID = "ts-text-size-pop";
const TEXT_SIZE_TITLE_ID = "ts-text-size-title";

/** The three chords as one unbreakable run. At 200 wide the line broke
 *  between them and left "Ctrl+0" alone on a line of its own; held together,
 *  the break falls after "While you type:" and the chords read as one row. */
const unbroken = (keys: string) => keys.replace(/ /g, "\u00a0");

export interface TextSizeView {
  /** The step the pane's text is at, in percent (100 is the stage's 13.3px). */
  step: number;
  onStep(direction: TextStepDirection): void;
}

export default function TextSizeControl({ size }: { size: TextSizeView }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const minusRef = useRef<HTMLButtonElement | null>(null);
  const plusRef = useRef<HTMLButtonElement | null>(null);
  const smaller = canGoSmaller(size.step);
  const larger = canGoLarger(size.step);
  const press = (direction: TextStepDirection, can: boolean) => { if (can) size.onStep(direction); };
  const label = t("board.stage.textSize");
  const percent = formatPercent(size.step);
  const changed = size.step !== DEFAULT_STEP;
  const tip = t("board.stage.textSizeTip", { percent });
  return (
    <>
      <button
        type="button"
        id={TEXT_SIZE_ID}
        className="glyph-btn"
        aria-label={label}
        title={tip}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? TEXT_SIZE_POP_ID : undefined}
        data-changed={changed || undefined}
        onClick={() => setOpen(o => !o)}
      >
        <KitIcon name="text-size" className="ts-icon" />
      </button>
      {open && (
        <AnchoredPopover anchorId={TEXT_SIZE_ID} id={TEXT_SIZE_POP_ID} className="ap-pop ts-text-pop" role="dialog"
          labelledBy={TEXT_SIZE_TITLE_ID} focusRef={smaller ? minusRef : plusRef} onClose={() => setOpen(false)}>
          <p className="ts-text-title" id={TEXT_SIZE_TITLE_ID}>{label}</p>
          <div className="ts-text-step" role="group" aria-labelledby={TEXT_SIZE_TITLE_ID}>
            <button ref={minusRef} type="button" className="glyph-btn" aria-label={t("board.stage.textSmaller")}
              title={t("board.stage.textSmaller")} aria-disabled={!smaller || undefined} onClick={() => press("smaller", smaller)}>
              <KitIcon name="minus" className="ts-icon" />
            </button>
            <output className="ts-text-pct" aria-live="polite">{percent}</output>
            <button ref={plusRef} type="button" className="glyph-btn" aria-label={t("board.stage.textLarger")}
              title={t("board.stage.textLarger")} aria-disabled={!larger || undefined} onClick={() => press("larger", larger)}>
              <KitIcon name="plus" className="ts-icon" />
            </button>
          </div>
          <button type="button" className="btn ts-text-reset" aria-disabled={!changed || undefined} onClick={() => press("reset", changed)}>
            {t("board.stage.textReset", { percent: formatPercent(DEFAULT_STEP) })}
          </button>
          <p className="ts-text-keys">{t("board.stage.textKeys", { keys: unbroken(textSizeKeysLabel()) })}</p>
        </AnchoredPopover>
      )}
    </>
  );
}
