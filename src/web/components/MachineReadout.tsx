// How the machine panel draws a reading: a figure, a bar with its label and
// note, and the one control that opens a section's history.
//
// Lifted out of MachinePanel.tsx unchanged. Every section of the panel is made
// of these three, and each says in its own comment why it is drawn the way it
// is; which readings a section draws, and in what order, stays with the
// section.
import React, { useEffect, useId, useRef, useState } from "react";

import { KitIcon } from "./kit-icons";
import { LevelMark } from "./LevelMark";
import SectionHistoryModal from "./SectionHistoryModal";
import { DialogPresence } from "./Dialog";
import { useT } from "../i18n";

/**
 * One figure: the number in the panel's reading weight, and what it is under
 * it — three samples of one reading, where the numbers are what you compare.
 * (The network's three are plain rows now, one measurement each.) A span, not
 * a <b>: the figure is set like Usage's token figures, at the reading weight,
 * and nothing about it is offset from the text around it.
 */
export function Fig({ value, cap }: { value: string; cap: string }) {
  return (
    <span className="sd-fig">
      <span className="sd-fig-val">{value}</span>
      <span className="sd-fig-cap">{cap}</span>
    </span>
  );
}

/** How long a press on a section's readings waits before it opens the chart:
 *  long enough for the second press of a double-click, which selects the word
 *  under it, to call it off, and short enough that a single press still reads
 *  as the chart answering it. */
const DOUBLE_PRESS_MS = 300;

/**
 * A section of this panel that keeps a history, under the one control that
 * opens it.
 *
 * ONE control per reading, never one per row. It was one per row first, and
 * that was a mistake with a tell: every row of a section opens the SAME dialog
 * showing EVERY series in it, so the second button did nothing the first had
 * not. Two controls for one action made a section read as a list of separately
 * operable things when it is one reading of one machine.
 *
 * THE HEADING IS THE BUTTON, AND THE READINGS ARE NOT IN IT (#1771). The whole
 * block was the button once, so that it lit as one, and that silenced it: a
 * button's name is its label and everything inside it is presentational, so a
 * screen reader said "Show memory history, button" and never one figure — not
 * the bytes, not what was available, not a temperature, not "Can’t reach
 * Claude". The rows follow the button now as ordinary content, and
 * `.sd-reading` keeps the box the button had so nothing on screen moves.
 *
 * AND THE BLOCK STILL TAKES THE PRESS. Moving the readings out took the block's
 * press with them, and the press was the part people used: a click on the
 * figures, or on the sentence under them, is where the eye already is, and it
 * had opened the chart since the panel shipped. So `.sd-reading` answers a
 * pointer the way the button did, and forwards it rather than becoming a second
 * control: no role, no Tab stop, nothing for a screen reader to meet twice. The
 * heading stays the one control, and answers its own press — a keyboard's or a
 * pointer's — at once. The per-core and figure tooltips keep working, which an
 * overlay stretched from the button over the block would have covered.
 *
 * The name starts with the heading it shows — "Memory: show history" — so a
 * voice-control user who says the word on screen reaches it (SC 2.5.3). The
 * heading inside keeps its `aria-hidden` for that reason: the name already says
 * it. `value` is the exception the CPU section needs — a strip of bars with no
 * figure anywhere — and it is the reading itself, so the name says it too.
 */
export function OpensHistory({ group, title, action, label, value, hint, liveNote, children }: {
  group: "thermal" | "cores" | "memory" | "load" | "network";
  /** What the dialog calls itself. A name for a thing. */
  title: string;
  /** What pressing it does, on the tooltip: "Show core history" rather than
   *  "Core history", which reads as a label. Spelled out per section rather
   *  than derived, because deriving it produced "Show cores history". The
   *  accessible name is built from `label` instead, so it starts with the word
   *  on screen. */
  action: string;
  /** The heading, and the first words of the button's name. */
  label: string;
  /** The section's own reading, beside its heading, where it has one. */
  value?: string | null;
  /** What the reading is, for a reader who cannot hover for the tooltip that
   *  says the same thing. A DESCRIPTION rather than part of the name: a button
   *  is named for what pressing it does, and "Show load history, the queue for
   *  the cores, counted in tasks rather than as a share of them" is a sentence
   *  where a control's name belongs. Announced after the name, and only where a
   *  reader asks for more. */
  hint?: string;
  /** The same live reading remains visible while its history covers the panel. */
  liveNote?: string | null;
  children: React.ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLButtonElement>(null);
  const pending = useRef<number | null>(null);
  const callOff = () => {
    if (pending.current != null) window.clearTimeout(pending.current);
    pending.current = null;
  };
  useEffect(() => callOff, []);
  // Two things the block does that a press on the heading does for itself.
  // It hands the heading the focus a click on the button used to give it, so
  // the dialog gives it back there on close instead of to the page. And the
  // readings are text a reader can select now, so a press that is part of
  // selecting is left as a selection rather than taken as a request: the click
  // that ends a drag across a figure, and a double- or triple-click, whose
  // FIRST click arrives before anything is selected — so the chart waits a
  // moment for a second one before it opens.
  const pressBlock = (e: React.MouseEvent) => {
    callOff();
    if (e.detail > 1 || window.getSelection()?.isCollapsed === false) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      if (window.getSelection()?.isCollapsed === false) return;
      heading.current?.focus({ preventScroll: true });
      setOpen(true);
    }, DOUBLE_PRESS_MS);
  };
  return (
    <>
      <div className="sd-reading" data-group={group} onClick={pressBlock}>
        <button
          ref={heading}
          type="button"
          className="sd-open"
          // Not passed on to the block, which would open it a second time.
          onClick={e => { e.stopPropagation(); callOff(); setOpen(true); }}
          title={action}
          aria-label={value == null ? t("insights.machine.showHistory", { label }) : t("insights.machine.showHistoryNow", { label, value })}
          aria-describedby={hint ? `sd-hint-${group}` : undefined}
        >
          <span className="sd-h" aria-hidden>
            {label} <KitIcon name="chevron-right" className="sd-row-more" />
            {value != null && <span className="sd-h-val">{value}</span>}
          </span>
        </button>
        {children}
      </div>
      {hint && <span id={`sd-hint-${group}`} className="vis-hidden">{hint}</span>}
      <DialogPresence when={open}>{() => <SectionHistoryModal group={group} title={title} liveNote={liveNote} onClose={() => setOpen(false)} />}</DialogPresence>
    </>
  );
}

/**
 * The colour a meter's fill takes: `--accent`, the cores' own fill, below 90,
 * and `--err` from 90. Two levels and no step between them: a 70-89 band in
 * the text colour read as neither normal nor a warning. Never amber — amber
 * means an agent waits.
 *
 * Every meter left in the panel can alarm: memory, swap and the GPU. The CPU
 * has none — its total is a figure and its cores are columns in the accent,
 * which never take a level (see the top of MachinePanel.tsx).
 */
export function meterLevel(pct: number): "accent" | "err" {
  return pct >= 90 ? "err" : "accent";
}

/**
 * A meter 8 high on a --ctl-fill track, the fill scaled from the left.
 *
 * A floor of 1%, so a reading that is present but tiny still draws a sliver
 * rather than reading as "no data" — but only ABOVE zero: zero draws nothing.
 *
 * The colour comes from the figure as it is printed (rounded), so a reading of
 * 89.6 that says "90%" is also coloured as 90.
 */
export function Meter({ pct, label }: { pct: number; label?: string }) {
  return (
    <span className="sd-track" role={label ? "img" : undefined} aria-label={label}>
      <span
        className="sd-fill"
        data-level={meterLevel(Math.round(pct))}
        style={{ transform: `scaleX(${pct <= 0 ? 0 : Math.max(1, Math.min(100, pct)) / 100})` }}
      />
    </span>
  );
}

/**
 * A label, a reading, a meter and an optional line under it.
 *
 * `value` is a node rather than a byte pair because this row draws different
 * kinds of reading — "41 of 64 GB", "18%" — and the formatting belongs to the
 * section rather than to the component every section shares.
 */
export function Row({ label, value, pct, note }: {
  label: string; value: React.ReactNode; pct: number; note?: string;
}) {
  return (
    <div className="sd-row">
      <div className="sd-row-head">
        <span className="sd-row-label">{label}</span>
        {/* "How much of how much" — the question a percentage cannot answer and
            the reason this panel exists. At the meter's --err level it wears
            the warning mark and "high" as well, in the fill's tone. */}
        <LevelMark tone={meterLevel(Math.round(pct)) === "err" ? "err" : null} word="high">
          <span className="sd-row-val">{value}</span>
        </LevelMark>
      </div>
      <Meter pct={pct} />
      {note && <div className="sd-note">{note}</div>}
    </div>
  );
}

/**
 * A plain reading, 24 high: the label on the left in --text-secondary, the
 * value on the right in mono. `err` is for a reading the deck already treats as an error
 * (a sensor past its own critical point, a clock held down hard): --err, with
 * the warning mark and "hot" round it; anything else is --text, never amber.
 * `note` is the sentence that explains it, under.
 * `hint` is a fact about the reading that the frame has no room to draw (a
 * sensor's critical point): it is the row's tooltip and, for a reader who
 * cannot hover, a visually hidden description of the row.
 */
export function PlainRow({ label, value, err, note, hint }: { label: string; value: React.ReactNode; err?: boolean; note?: string; hint?: string }) {
  const hintId = useId();
  return (
    <div className="sd-plain" title={hint} aria-describedby={hint ? hintId : undefined}>
      <span className="sd-plain-label">{label}</span>
      <LevelMark tone={err ? "err" : null} word="hot">
        <span className="sd-plain-val" data-err={err ? "" : undefined}>{value}</span>
      </LevelMark>
      {hint && <span id={hintId} className="vis-hidden">{hint}</span>}
      {note && <span className="sd-plain-note">{note}</span>}
    </div>
  );
}
