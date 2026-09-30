// How the machine panel draws a reading: a figure, a bar with its label and
// note, and the one control that opens a section's history.
//
// Lifted out of MachinePanel.tsx unchanged. Every section of the panel is made
// of these three, and each says in its own comment why it is drawn the way it
// is; which readings a section draws, and in what order, stays with the
// section.
import React, { useRef, useState } from "react";

import type { Tone } from "../machine-readings";
import SectionHistoryModal from "./SectionHistoryModal";

/**
 * One figure: the number in the panel's reading weight, and what it is.
 *
 * Two orders, one component. Without a `unit` the caption goes under the number
 * — three samples of one reading, where the numbers are what you compare. With
 * one, the caption goes on top and the unit sits beside the number: three
 * different measurements, where the name is what you need first and the unit
 * belongs to the figure rather than to the label under it. The row's grid is
 * the same either way, so the columns line up down the panel.
 */
export function Fig({ value, unit, cap }: { value: string; unit?: string; cap: string }) {
  if (unit) {
    return (
      <span className="sd-fig">
        <span className="sd-fig-cap">{cap}</span>
        <span className="sd-fig-read"><b>{value}</b> <span className="sd-fig-unit">{unit}</span></span>
      </span>
    );
  }
  return (
    <span className="sd-fig">
      <b>{value}</b>
      <span className="sd-fig-cap">{cap}</span>
    </span>
  );
}

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
 * heading stays the one control, and a keyboard's press on it reaches the same
 * handler by bubbling. The per-core and figure tooltips keep working, which an
 * overlay stretched from the button over the block would have covered.
 *
 * The name starts with the heading it shows — "Memory: show history" — so a
 * voice-control user who says the word on screen reaches it (SC 2.5.3). The
 * heading inside keeps its `aria-hidden` for that reason: the name already says
 * it. `value` is the exception the CPU section needs — a strip of bars with no
 * figure anywhere — and it is the reading itself, so the name says it too.
 */
export function OpensHistory({ group, title, action, label, value, hint, children }: {
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
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const heading = useRef<HTMLButtonElement>(null);
  // Two things the block does that a press on the heading does for itself.
  // It hands the heading the focus a click on the button used to give it, so
  // the dialog gives it back there on close instead of to the page. And the
  // readings are text a reader can select now, so the click that ends a drag
  // across a figure is left as a selection rather than taken as a press.
  const pressBlock = () => {
    if (window.getSelection()?.isCollapsed === false) return;
    heading.current?.focus({ preventScroll: true });
    setOpen(true);
  };
  return (
    <>
      <div className="sd-reading" onClick={pressBlock}>
        <button
          ref={heading}
          type="button"
          className="sd-open"
          onClick={() => setOpen(true)}
          title={action}
          aria-label={value == null ? `${label}: show history` : `${label}: show history, now ${value}`}
          aria-describedby={hint ? `sd-hint-${group}` : undefined}
        >
          <span className="sd-h" aria-hidden>
            {label} <i className="sd-row-more">›</i>
            {value != null && <span className="sd-h-val">{value}</span>}
          </span>
        </button>
        {children}
      </div>
      {hint && <span id={`sd-hint-${group}`} className="vis-hidden">{hint}</span>}
      {open && <SectionHistoryModal group={group} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * A label, a reading, a track and an optional sentence.
 *
 * `value` is a node rather than a byte pair because this row draws three
 * different kinds of reading now — "20.5 GB of 32.0 GB", "58 °C", "0%" — and
 * the memory formatting belongs to the memory section rather than to the
 * component every section shares. `tone` for the same reason: `pct >= 90` is
 * the memory rule and it was never the thermal one.
 *
 * `mark` is where the fill changes colour, drawn as a notch in the track so the
 * bar is a scale with a point on it rather than a length with no units. Only
 * the temperature rows have one: memory's amber is at nine tenths of a bar that
 * is already full by then, and a mark there would sit under the fill's own end.
 */
export function Row({ label, value, pct, tone = "calm", note, mark, title, trackLabel }: {
  label: string; value: React.ReactNode; pct: number; tone?: Tone; note?: string;
  mark?: number; title?: string;
  /** The bar said in words, for a reader who gets no tooltip. Only the rows
   *  drawn against a threshold need one: a memory bar is the figure beside it,
   *  a thermal bar is the figure against a scale that is not on screen. */
  trackLabel?: string;
}) {
  return (
    <div className="sd-row" title={title}>
      <div className="sd-row-head">
        <span className="sd-row-label">{label}</span>
        {/* "How much of how much" — the question a percentage cannot answer and
            the reason this panel exists. */}
        <span className="sd-row-val">{value}</span>
      </div>
      <span className="sd-track" role={trackLabel ? "img" : undefined} aria-label={trackLabel}>
        {/* A floor of 1%, so a reading that is present but tiny still draws a
            sliver rather than reading as "no data" — but only ABOVE zero. Zero
            draws nothing, because on the thermal rows an empty track is the
            answer: "Throttling — 0%" beside a bar with a mark in it says two
            different things, and the section's whole convention is that a bar
            fills with the problem. Nothing is not a small amount of something.
            Memory never reaches zero, so it is unaffected either way. */}
        <span
          className={`sd-fill${tone === "calm" ? "" : ` ${tone}`}`}
          style={{ transform: `scaleX(${pct <= 0 ? 0 : Math.max(1, Math.min(100, pct)) / 100})` }}
        />
        {mark != null && mark > 0 && mark < 100 && (
          <span className="sd-mark" style={{ left: `${mark}%` }} aria-hidden />
        )}
      </span>
      {note && <div className="sd-note">{note}</div>}
    </div>
  );
}
