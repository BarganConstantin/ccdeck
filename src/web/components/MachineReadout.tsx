// How the machine panel draws a reading: a figure, a bar with its label and
// note, and the one control that opens a section's history.
//
// Lifted out of MachinePanel.tsx unchanged. Every section of the panel is made
// of these three, and each says in its own comment why it is drawn the way it
// is; which readings a section draws, and in what order, stays with the
// section.
import React, { useState } from "react";

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
 * A section of this panel that keeps a history, wrapped in the one control that
 * opens it.
 *
 * ONE control per reading, never one per row. It was one per row first, and
 * that was a mistake with a tell: every row of a section opens the SAME dialog
 * showing EVERY series in it, so the second button did nothing the first had
 * not. Two controls for one action made a section read as a list of separately
 * operable things when it is one reading of one machine.
 *
 * The heading goes inside the button so the whole block lights as one, and
 * keeps its `aria-hidden`: the group is already named, and the button carries
 * its own name, so the word a third time is noise. `value` is the exception the
 * CPU section needs — a strip of bars with no figure anywhere — and it is the
 * reading itself, so it is spoken by the button rather than hidden with the
 * heading.
 */
export function OpensHistory({ group, title, action, label, value, hint, children }: {
  group: "thermal" | "cores" | "memory" | "load" | "network";
  /** What the dialog calls itself. A name for a thing. */
  title: string;
  /** What the BUTTON calls itself, which is not the same string: a control is
   *  named for what pressing it does. "Core history" announces as a label and
   *  reads as one; "Show core history" is the action. Spelled out per section
   *  rather than derived, because deriving it produced "Show cores history". */
  action: string;
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
  return (
    <>
      <button
        type="button"
        className="sd-open"
        onClick={() => setOpen(true)}
        title={action}
        aria-label={value == null ? action : `${action}, now ${value}`}
        aria-describedby={hint ? `sd-hint-${group}` : undefined}
      >
        <div className="sd-h" aria-hidden>
          {label} <i className="sd-row-more">›</i>
          {value != null && <span className="sd-h-val">{value}</span>}
        </div>
        {children}
      </button>
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
