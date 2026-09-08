// The machine's own state, docked beside the canvas, so the answer to "is this
// box coping" does not require another window.
//
// IT USED TO BE A TOPBAR METER TOO. A 50x24 box in the status strip drew a
// 60-second CPU sparkline and a memory bar, and clicking it disclosed this
// panel. The readings were real and the box was small, but it moved on its own
// every three seconds in the corner of a bar whose job is to say whether the
// stream is alive — an animation nobody asked for, in the one place the eye
// keeps returning to. It is a button in the icon run now, and everything the
// meter said is one click away in here, where there is room to say it properly.
//
// NO COLOUR THRESHOLD ON CPU, deliberately, and it is the most load-bearing "no"
// here. QuotaBar turns amber at 70 and red at 90 because a quota at 90% means
// you are about to be cut off. A CPU at 90% means the machine is doing the work
// you asked for. Colouring it would make this red through every build and every
// parallel subagent run — precisely the sessions this deck exists to watch — and
// an indicator that alarms during the normal case teaches you to stop reading
// it. Memory and swap keep a warning, because near-exhaustion there is real.
//
// ABSOLUTE NUMBERS, NOT RATIOS. A percentage answers "how full", which is the
// ambient question the meter was answering; it cannot answer "how much of how
// much", which is the question you open a panel to ask. Everything here is in
// bytes and cores.
import React, { useEffect, useRef, useState } from "react";
import SectionHistoryModal from "./SectionHistoryModal";
import ProcessListModal from "./ProcessListModal";

/** Matches the server's CPU cadence, so the panel advances one reading per poll
 *  rather than redrawing the same frame or skipping one. */
const POLL_MS = 3_000;

/** How a bar is painted. `calm` is the resting appearance and carries no class
 *  of its own, which is what keeps the memory rows drawing exactly as before. */
type Tone = "calm" | "warn" | "hot";

/**
 * Which band a temperature falls in.
 *
 * The numbers are the sensor's own wherever the platform publishes them — Linux
 * hwmon carries `temp*_max` and `temp*_crit` per sensor — because one scale for
 * every source would be a threshold this app invented. 75 and 90 are the
 * fallback for the platforms that publish none.
 */
export function thermalTone(celsius: number, warnAt: number, critAt: number): Tone {
  if (celsius >= critAt) return "hot";
  if (celsius >= warnAt) return "warn";
  return "calm";
}

/**
 * Throttling, stated as the share of the CPU's speed that has been TAKEN AWAY.
 *
 * `pmset -g therm` reports the share still allowed, and the obvious rendering
 * — "Thermal headroom 100%", a full bar — would put a full bar meaning "all is
 * well" directly beneath a memory bar where a full bar means "nearly out". Two
 * opposite conventions in one panel is a panel that has to be read twice. So it
 * is inverted here: every bar in this section fills with the problem, and an
 * empty track means nothing is wrong on every row and every platform.
 *
 * The note is the sentence somebody actually needs. A speed limit is already
 * the consequence a temperature has to be interpreted into, so it is worth
 * saying in words rather than leaving as a number.
 */
export function throttleRow(
  speedLimit: number,
  /** What the history says has already happened. A desktop reads 0% forever —
   *  measured: ninety seconds of AES-NI on twelve cores never moved this — and
   *  a row that only ever says 0% reads as a readout that does not work. It was
   *  reported that way twice. The current value is still the value; the note is
   *  where "and it did happen, at 12:21" belongs. */
  past?: { peak: number; lastMs: number } | null,
  now = Date.now(),
): { pct: number; value: string; tone: Tone; note: string } {
  const held = Math.max(0, Math.min(100, 100 - speedLimit));
  return {
    pct: held,
    // A number, never the word "none", and that was a bug report: a healthy
    // machine read as though the check had not run. Every other reading in this
    // panel is a figure on a scale — "20.5 GB of 32.0 GB", "84.49", "63 °C" —
    // so a word where a number goes is the one token that looks like an absent
    // value rather than a measured one. A speedometer at rest reads 0; it does
    // not read "none". And 0% sits on the same scale as the 9% that appears
    // under load, which is what makes it legible as a reading.
    value: `${held}%`,
    // Any throttling at all is worth a colour: it means the machine is slower
    // than the one you think you are running on. A third of the clock gone is
    // where that stops being a detail.
    tone: held === 0 ? "calm" : held >= 30 ? "hot" : "warn",
    // Short enough to sit on one line in a 280px panel: the longer phrasings
    // wrapped and orphaned their last word.
    note: held > 0
      ? `CPU held to ${speedLimit}% of full speed to cool down`
      : past
        ? `at full speed · held to ${100 - past.peak}% ${sinceLabel(past.lastMs, now)}`
        : "running at full speed, and never held back",
  };
}

/**
 * How long ago something happened, in the fewest words that stay true.
 *
 * Coarse on purpose. The buckets are a minute wide, so "42 seconds ago" would
 * be a precision the reading does not have, and the question this answers is
 * "recently, or this morning" rather than "exactly when".
 */
function sinceLabel(atMs: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - atMs) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.floor(mins / 60);
  return h === 1 ? "an hour ago" : `${h} hours ago`;
}

interface Memory { total: number; available: number; usedPct: number }
interface Swap { total: number; used: number }
/** `warnAt`/`critAt` come from the chip itself where the platform publishes
 *  them — Linux hwmon does — because a laptop package sensor and an NVMe drive
 *  do not share a comfortable range. Elsewhere the server fills in 75/90. */
interface ThermalReading { label: string; celsius: number; warnAt: number; critAt: number }
/** Two fields, not one list: degrees and a throttle percentage are different
 *  readings, and a shape that could hold either under one label is how a
 *  percentage ends up printed under a °C heading. */
interface Thermal {
  celsius: ThermalReading[];
  throttle: { speedLimit: number } | null;
  /** Whether the machine has been held back at all since the deck started, and
   *  when it last was. Null on one that never has. */
  heldBack?: { peak: number; lastMs: number } | null;
}
interface Snapshot {
  ok: boolean;
  cpu: number | null;
  cpuHistory: number[];
  cores: number;
  memory: Memory | null;
  swap: Swap | null;
  perCore: number[] | null;
  uptimeSec: number;
  platform: string;
  loadavg: number[] | null;
  /** Null on a machine that publishes nothing, and then no section is drawn at
   *  all — not 0°C, not a dash, not an empty bar. */
  thermal: Thermal | null;
  intervalMs: number;
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Poll /api/system on our own timer, and stop while the tab is hidden.
 *
 * A background tab has nobody looking at it, and browsers throttle its timers
 * to once a minute anyway — which would leave the sparkline full of holes on
 * return. Dropping the poll and refetching on the way back gives a clean read
 * instead of a ragged one.
 */
function useSystem(): Snapshot | null {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await fetch("/api/system");
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data?.ok) setSnap(data);
      } catch { /* the deck is down; the connection pill already says so */ }
    };
    const start = () => {
      if (timer.current != null) return;
      load();
      timer.current = window.setInterval(load, POLL_MS);
    };
    const stop = () => {
      if (timer.current == null) return;
      window.clearInterval(timer.current);
      timer.current = null;
    };
    // Coming back deserves a reading now, not on the next tick. `start()` is a
    // no-op while the interval is alive, so without this explicit load a tab
    // that regained focus showed its last pre-hidden value for up to POLL_MS.
    const onVis = () => {
      if (document.visibilityState === "hidden") { stop(); return; }
      start();
      load();
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return snap;
}

/**
 * The panel's frame: its slot in the rail, its landmark name, its title and its
 * one ×.
 *
 * Written once because there are two things that can be inside it — the
 * readings, and the sentence that stands in for them until the first snapshot
 * lands — and a header copied into a second branch is how one × ends up saying
 * something the other does not.
 */
function Shell({ usageOpen, sub, onClose, children }: {
  usageOpen: boolean;
  /** The uptime and the core count, which only a measured panel has. */
  sub?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <aside className={`sysdetail${usageOpen ? " shifted" : ""}`} id="system-panel" aria-label="Machine detail">
      <div className="sd-head">
        <span className="sd-title">This machine</span>
        {sub && <span className="sd-sub">{sub}</span>}
        <button type="button" className="glyph-btn sd-close" onClick={onClose} aria-label="Close" title="Close">×</button>
      </div>
      {children}
    </aside>
  );
}

/**
 * The detail, docked in the right rail beside the usage panel.
 *
 * NOT a dialog and not a popover, and the distinction is behavioural rather
 * than cosmetic. This is the same kind of thing the usage panel is: a region
 * you open, read alongside the canvas, and leave open while you work. So it
 * follows that idiom exactly — disclosure semantics on the button, no scrim, no
 * focus trap, and no dismissal when you click somewhere else, because clicking
 * the canvas while watching a build is not a request to close your instruments.
 *
 * It also means the two panels queue rather than overlap: with usage open this
 * sits to its left, and with usage closed it takes the slot usage would have
 * had. One rail, read right to left, nothing stacked on top of anything.
 *
 * Escape follows that idiom too. Its × read "Close (Esc)" from the day it
 * shipped and #545 made that key true — but a panel is not a dialog, and the
 * press it was taking belonged to the canvas behind it. The × says "Close" now,
 * and the topbar button closes it as readily as it opens it.
 *
 * IT POLLS ONLY WHILE IT IS OPEN, which it could not do while a topbar meter
 * was drawing the same snapshot: /api/system was fetched every three seconds
 * for the life of every tab, whether or not anybody was reading it. Nothing is
 * lost by stopping — the server samples on its own timers and keeps the
 * history, so a panel opened an hour from now still has the hour behind it.
 */
export default function MachinePanel({ usageOpen, onClose }: {
  usageOpen: boolean;
  onClose: () => void;
}) {
  const sys = useSystem();

  // The first snapshot is one localhost round trip away, and until it lands
  // there is nothing measured to draw. The panel appears anyway, at its own
  // width and with its own ×, because the alternative is a button that reports
  // itself expanded over an empty screen. It says what it is doing instead of
  // standing an empty frame there, and it prints no number it does not have —
  // the same rule the sections below it keep.
  if (!sys || sys.cpu == null || !sys.memory) {
    return (
      <Shell usageOpen={usageOpen} onClose={onClose}>
        <div className="sd-note">reading this machine…</div>
      </Shell>
    );
  }

  const { memory, swap, perCore, loadavg, cores, uptimeSec, platform, thermal } = sys;
  const used = memory ? memory.total - memory.available : 0;
  // Windows has no swap file in the Unix sense; what the same query reports
  // there is commit charge, so it is named for what it is.
  const swapLabel = platform === "win32" ? "Commit" : "Swap";
  const swapPct = swap && swap.total > 0 ? (swap.used / swap.total) * 100 : 0;

  return (
    <Shell usageOpen={usageOpen} sub={`up ${uptime(uptimeSec)} · ${cores} cores`} onClose={onClose}>

      {perCore && perCore.length > 0 && (
        <div className="sd-section" role="group" aria-label="Cores">
          <OpensHistory group="cores" title="Core history" action="Show core history" label="Cores">
          {/* One column per core. The aggregate in the topbar cannot tell a
              saturated machine from one hot single-threaded job; this can. */}
          <div className="sd-cores" style={{ "--n": perCore.length } as React.CSSProperties}>
            {perCore.map((v, i) => (
              <span key={i} className="sd-core" title={`core ${i + 1}: ${v}%`}>
                {/* A fraction of a full-height column, not a height (#505).
                    One element per core, restyled every 3 seconds while this
                    panel is open, so the difference between a composited
                    transform and a relayout is multiplied by the core count.
                    The 2% floor is unchanged and means the same thing it always
                    did: an idle core still draws a sliver, so an empty column
                    reads as "nothing running" rather than "no data". */}
                <span className="sd-core-fill" style={{ transform: `scaleY(${Math.max(2, v) / 100})` }} />
              </span>
            ))}
          </div>
          </OpensHistory>
        </div>
      )}

      <div className="sd-section" role="group" aria-label="Memory">
        <OpensHistory group="memory" title="Memory history" action="Show memory history" label="Memory">
        {memory && (
          <Row
            label="Physical"
            value={<><b>{bytes(used)}</b> of {bytes(memory.total)}</>}
            pct={memory.usedPct}
            tone={memory.usedPct >= 90 ? "warn" : "calm"}
            note={`${bytes(memory.available)} available`}
          />
        )}
        {swap && swap.total > 0 && (
          <Row
            label={swapLabel}
            value={<><b>{bytes(swap.used)}</b> of {bytes(swap.total)}</>}
            pct={swapPct}
            tone={swapPct >= 90 ? "warn" : "calm"}
            note={swapPct >= 50 ? "paging to disk" : undefined}
          />
        )}
        </OpensHistory>
      </div>

      {loadavg && (
        <div className="sd-section" role="group" aria-label="Load average">
          <OpensHistory group="load" title="Load history" action="Show load history" label="Load average">
          <div className="sd-load">
            {loadavg.map((v, i) => (
              <span key={i} className={`sd-load-item${v > cores ? " over" : ""}`}>
                <b>{v.toFixed(2)}</b>
                <span>{["1m", "5m", "15m"][i]}</span>
              </span>
            ))}
          </div>
          {/* The one number the topbar bar cannot express: past 100% it
              saturates, and this says by how much. */}
          <div className="sd-note">
            {loadavg[0] > cores
              ? `${(loadavg[0] / cores).toFixed(1)}× more work queued than cores to run it`
              : `within ${cores} cores`}
          </div>
          </OpensHistory>
        </div>
      )}

      <ThermalSection thermal={thermal} />

      <Processes sys={sys} />
    </Shell>
  );
}

/**
 * Is this machine getting hot, and is it being held back for it.
 *
 * The question the four sections above cannot answer. A saturated machine that
 * is cool is a machine doing work; a saturated machine that is thermally
 * limited is one where the next agent you launch makes everything slower, and
 * a load average of 67 reads identically in both cases.
 *
 * Headed "Thermal" rather than "Temperature", and that is a decision rather
 * than a hedge: on macOS the honest reading is not degrees at all — no CPU
 * sensor is readable without root, and what IS readable is how much of the
 * CPU's speed the thermal manager is currently allowing. A "Temperature"
 * heading over that would be a heading that lies on every Apple Silicon
 * install. "Thermal" holds degrees where the machine has them and the
 * consequence where it does not, and every row still says what it measured.
 *
 * Nothing is drawn when the machine publishes nothing. Not a zero, not a dash,
 * not an empty bar — the same refusal that keeps `cpu` null until two samples
 * exist. On a platform with no sensor this section has never existed.
 */
/**
 * A section of this panel that keeps a history, wrapped in the one control that
 * opens it.
 *
 * ONE control per section, never one per row. It was one per row first, and
 * that was a mistake with a tell: every row of a section opens the SAME dialog
 * showing EVERY series in it, so the second button did nothing the first had
 * not. Two controls for one action made a section read as a list of separately
 * operable things when it is one reading of one machine.
 *
 * The heading goes inside the button so the whole block lights as one, and
 * keeps its `aria-hidden`: the group is already named, and the button carries
 * its own name, so the word a third time is noise.
 */
function OpensHistory({ group, title, action, label, children }: {
  group: "thermal" | "cores" | "memory" | "load";
  /** What the dialog calls itself. A name for a thing. */
  title: string;
  /** What the BUTTON calls itself, which is not the same string: a control is
   *  named for what pressing it does. "Core history" announces as a label and
   *  reads as one; "Show core history" is the action. Spelled out per section
   *  rather than derived, because deriving it produced "Show cores history". */
  action: string;
  label: string;
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
        aria-label={action}
      >
        <div className="sd-h" aria-hidden>{label} <i className="sd-row-more">›</i></div>
        {children}
      </button>
      {open && <SectionHistoryModal group={group} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}

function ThermalSection({ thermal }: { thermal: Thermal | null }) {
  if (!thermal) return null;
  const held = thermal.throttle ? throttleRow(thermal.throttle.speedLimit, thermal.heldBack) : null;
  return (
    <div className="sd-section" role="group" aria-label="Thermal">
      <OpensHistory group="thermal" title="Thermal history" action="Show thermal history" label="Thermal">
        {thermal.celsius.map(r => (
          <Row
            key={r.label}
            label={r.label}
            value={<><b>{r.celsius}</b> °C</>}
            // The track is 0 to 100°C, which is the range silicon lives in, so
            // the fill is the reading itself rather than a ratio of a number
            // nobody would recognise.
            pct={r.celsius}
            tone={thermalTone(r.celsius, r.warnAt, r.critAt)}
          />
        ))}
        {held && (
          <Row label="Throttling" value={held.value} pct={held.pct} tone={held.tone} note={held.note} />
        )}
      </OpensHistory>
    </div>
  );
}

/**
 * The way into the process list, and no longer a list of its own.
 *
 * It was eight rows with sortable headers, and it was answering the same
 * question the dialog answers — worse, and at a cost the panel paid whether or
 * not anybody was reading it. Eight of five hundred processes, three of seven
 * columns, names truncated at 120px, and `ps` run every four seconds for the
 * life of an open panel to keep them moving. The dialog beside it has every
 * candidate, the command line that says WHICH `node` this is, the pid, and the
 * machine's own readings down its left edge.
 *
 * So the section is one control now. Nothing here polls: the dialog owns the
 * process read, and a panel with the list closed spawns no `ps` at all.
 *
 * It keeps the heading it had. `Busiest processes` is what the dialog is called
 * and what the reader was already looking for, and the chevron is the same one
 * the four sections above it use for "there is more of this".
 *
 * AND IT LOOKS LIKE A WAY THROUGH, which the four above do not have to. They
 * are headings over readings: the reading is what you came for and the chevron
 * is a bonus. This one has nothing under it, so a dim uppercase heading alone
 * reads as a section whose contents failed to load — and a control nobody
 * presses is worth no more than the rows it replaced.
 *
 * So it wears a plate: the name in the panel's own text colour rather than the
 * heading's grey, one line of what is behind it, and the chevron at the far
 * edge. Still `.sd-open`, so the hover, the press and the bleed are the four
 * sections' own and there is one definition of each.
 */
function Processes({ sys }: {
  /** Threaded through rather than re-polled inside the dialog: this panel is
   *  already holding a snapshot of the same machine, and two independent
   *  three-second polls of one endpoint would put two readings on screen that
   *  disagree by a tick. */
  sys: Snapshot;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sd-section">
      <button
        type="button"
        className="sd-open sd-door"
        onClick={() => setOpen(true)}
        /* NO `title`. The four sections above carry one because their heading is
           two words over a chart; this control already prints what it is and
           what is behind it, and a native tooltip repeating that in other words
           lands ON the line it is repeating — it covers the sub-line, which is
           the one thing here a reader has not seen before. The accessible name
           stays, because a screen reader gets no plate. */
        aria-label="Show every process the deck is watching"
      >
        <span className="sd-door-plate">
          <span className="sd-door-name">
            Busiest processes
            <i className="sd-row-more" aria-hidden>›</i>
          </span>
          <span className="sd-door-sub">every process, with its command line</span>
        </span>
      </button>
      {open && <ProcessListModal sys={sys} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * A label, a reading, a track and an optional sentence.
 *
 * `value` is a node rather than a byte pair because this row draws three
 * different kinds of reading now — "20.5 GB of 32.0 GB", "58 °C", "none" — and
 * the memory formatting belongs to the memory section rather than to the
 * component every section shares. `tone` for the same reason: `pct >= 90` is
 * the memory rule and it was never the thermal one.
 */
function Row({ label, value, pct, tone = "calm", note }: {
  label: string; value: React.ReactNode; pct: number; tone?: Tone; note?: string;
}) {
  return (
    <div className="sd-row">
      <div className="sd-row-head">
        <span className="sd-row-label">{label}</span>
        {/* "How much of how much" — the question a percentage cannot answer and
            the reason this panel exists. */}
        <span className="sd-row-val">{value}</span>
      </div>
      <span className="sd-track">
        {/* A floor of 1%, so a reading that is present but tiny still draws a
            sliver rather than reading as "no data" — but only ABOVE zero. Zero
            draws nothing, because on the thermal rows an empty track is the
            answer: "Throttling — none" beside a bar with a mark in it says two
            different things, and the section's whole convention is that a bar
            fills with the problem. Nothing is not a small amount of something.
            Memory never reaches zero, so it is unaffected either way. */}
        <span
          className={`sd-fill${tone === "calm" ? "" : ` ${tone}`}`}
          style={{ transform: `scaleX(${pct <= 0 ? 0 : Math.max(1, Math.min(100, pct)) / 100})` }}
        />
      </span>
      {note && <div className="sd-note">{note}</div>}
    </div>
  );
}
