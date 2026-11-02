// The card's cost chip and the tooltip that checks its figure (V4's cost
// tooltip): the model, one row per kind of token as tokens × rate = dollars,
// then the total and, while the session runs, its burn. It replaces the
// browser's native title, which could not hold the multiplication in columns.
//
// Opens after the deck's hint wait under a mouse, at once under keyboard focus
// (:focus-visible), and goes on Escape through the deck's dismiss stack, on a
// press, a blur, a scroll or a resize. The chip names the tip with
// aria-describedby while it is open, so a reader on the chip hears the sum.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { modalStack } from "../modal-dismiss";
import type { CostTip } from "../card-cost";
import { FIRST_HINT_DELAY_MS } from "./use-hint";
import { useT } from "../i18n";

const EDGE = 8;
const GAP = 6;

export function CostChipTip({ tip, className, children }: { tip: CostTip; className: string; children: ReactNode }) {
  const id = useId();
  const chipRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);

  const hide = useCallback(() => { window.clearTimeout(timer.current); setOpen(false); }, []);
  const show = useCallback((wait: number) => {
    window.clearTimeout(timer.current);
    if (wait <= 0) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), wait);
  }, []);

  useEffect(() => {
    if (!open) return;
    const off = modalStack.push(hide, 0, "popover");
    window.addEventListener("resize", hide);
    window.addEventListener("scroll", hide, true);
    return () => { off(); window.removeEventListener("resize", hide); window.removeEventListener("scroll", hide, true); };
  }, [open, hide]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Placed once it has a size: under the chip, flipped above when the window
  // ends first, and kept inside the window sideways.
  useLayoutEffect(() => {
    const el = tipRef.current;
    const chip = chipRef.current;
    if (!open || !el || !chip) return;
    const box = chip.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(box.left, window.innerWidth - width - EDGE));
    const below = box.bottom + GAP;
    const top = below + height + EDGE > window.innerHeight ? Math.max(EDGE, box.top - GAP - height) : below;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  }, [open]);

  return (
    <>
      <span
        ref={chipRef}
        className={className}
        tabIndex={0}
        aria-describedby={open ? id : undefined}
        onPointerEnter={e => { if (e.pointerType === "mouse") show(FIRST_HINT_DELAY_MS); }}
        onPointerLeave={hide}
        onPointerDown={hide}
        onFocus={e => { if (e.currentTarget.matches(":focus-visible")) show(0); }}
        onBlur={hide}
      >
        {children}
      </span>
      {open && createPortal(
        <div ref={tipRef} id={id} role="tooltip" className="cost-tip" style={{ left: 0, top: 0, visibility: "hidden" }}>
          <CostTipBody tip={tip} />
        </div>,
        document.body,
      )}
    </>
  );
}

/** The tooltip's content. Exported so the markup can be read without a browser. */
export function CostTipBody({ tip }: { tip: CostTip }) {
  const t = useT();
  const priced = tip.sections.some(s => !s.noRate);
  return (
    <>
      {tip.sections.map((s, i) => (
        <div className="cost-tip-section" key={i}>
          <div className="cost-tip-title">{s.title}</div>
          {s.noRate
            ? <p className="cost-tip-norate">{t("board.cost.noRate")}</p>
            : (
              <div className="cost-tip-rows">
                {s.rows.map(r => (
                  <div className="cost-tip-row" key={r.label}>
                    <span className="cost-tip-label">{r.label}</span>
                    <span className="cost-tip-value">{r.value}</span>
                  </div>
                ))}
              </div>
            )}
        </div>
      ))}
      {tip.note && <p className="cost-tip-norate">{tip.note}</p>}
      {priced && (
        <>
          <hr className="cost-tip-rule" />
          <div className="cost-tip-rows">
            <div className="cost-tip-row">
              <span className="cost-tip-label">{t("board.cost.total")}</span>
              <span className="cost-tip-value">{tip.total}</span>
            </div>
            {tip.burn && (
              <div className="cost-tip-row">
                <span className="cost-tip-label">{t("board.cost.burnLabel")}</span>
                <span className="cost-tip-value">{tip.burn}</span>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
