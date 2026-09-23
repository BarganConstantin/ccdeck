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
// FIVE SECTIONS, IN THE ORDER THE QUESTIONS ARRIVE. What is this machine doing
// (CPU), what is it holding (memory), what is its line doing (network), is it
// getting hot (thermal), and which process is responsible (the door at the
// foot). Each is one control over one reading, and the detail that only matters
// once — the path traffic takes — is behind the one disclosure in the panel
// rather than printed under the figures forever.
//
// NO COLOUR THRESHOLD ON CPU, deliberately, and it is the most load-bearing "no"
// here. QuotaBar turns amber at 70 and red at 90 because a quota at 90% means
// you are about to be cut off. A CPU at 90% means the machine is doing the work
// you asked for. Colouring it would make this red through every build and every
// parallel subagent run — precisely the sessions this deck exists to watch — and
// an indicator that alarms during the normal case teaches you to stop reading
// it. Memory and swap keep a warning, because near-exhaustion there is real.
//
// THE SAME "NO" NOW COVERS LOAD AVERAGE, which used to turn amber the moment
// the 1-minute figure passed the core count. That is not a fault condition: a
// load average counts every runnable task and, on Linux, tasks waiting on the
// kernel as well, so a machine running eight builds is over its cores by
// design and stays there for an hour. The ratio is the reading worth having,
// and it is said in words under the figures instead of coloured into an alarm.
//
// ABSOLUTE NUMBERS, NOT RATIOS. A percentage answers "how full", which is the
// ambient question the meter was answering; it cannot answer "how much of how
// much", which is the question you open a panel to ask. Everything here is in
// bytes and cores — with one exception, the CPU figure beside its heading,
// because a share of the machine's cores IS what that section measures and the
// strip under it is the only reading in the panel with no number of its own.
import React, { useEffect, useRef, useState } from "react";
import SectionHistoryModal from "./SectionHistoryModal";
import AnchoredPopover from "./AnchoredPopover";
import { figureText, latencyFigure, rateFigure } from "../net-format";
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
/** The path traffic takes when it is not this machine's own connection. */
interface NetRoute {
  kind: "tailscale-exit" | "tailscale" | "vpn";
  iface?: string;
  node?: string | null;
  relay?: string | null;
  name?: string | null;
  to: "claude" | "internet";
}
/** Throughput is sampled all the time; latency and route only while this panel
 *  is open (system-metrics.mjs), so each can be missing for the first poll.
 *
 *  THE THREE FIGURES ARE NOT ONE MEASUREMENT. `down` and `up` are this
 *  machine's own counters across every physical interface it has; `api` is a
 *  TCP handshake with one host. The section sets them apart rather than in a
 *  row of three, and the disclosure under them says so in words. */
interface Network {
  down: number | null;
  up: number | null;
  /** `ms` null is a host that did not answer. */
  api: { host: string; ms: number | null } | null;
  route: NetRoute | null;
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
  /** Null until anything about the network has been read. */
  network?: Network | null;
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
 * The one condition in this snapshot worth saying at the top, or nothing.
 *
 * NOT A HEALTH SCORE, and not a badge that says "all good" on a quiet machine:
 * a permanent green word is read once and then stops being read, and it would
 * have to be computed from thresholds this app does not have for most of what
 * it measures. Three conditions qualify, all of them measured rather than
 * inferred, and each is already a warning colour in the section it comes from:
 *
 *   1. the machine is being held below full speed — `pmset` reports the limit;
 *   2. physical memory is at the 90% the memory row already turns amber at;
 *   3. the API host was asked and did not answer.
 *
 * One at a time, worst first. A stack of flags at the top of a 280px panel is
 * a second panel, and the section each one comes from says it again in place.
 */
export function attentionFlag(sys: Pick<Snapshot, "thermal" | "memory" | "network">): string | null {
  const limit = sys.thermal?.throttle?.speedLimit;
  if (limit != null && limit < 100) return `throttled to ${limit}% of full speed`;
  if (sys.memory && sys.memory.usedPct >= 90) return `physical memory ${Math.round(sys.memory.usedPct)}% full`;
  if (sys.network?.api && sys.network.api.ms == null) return "the Claude API is not answering";
  return null;
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
 * The panel's frame: its slot in the rail, its landmark name, its title, the
 * one thing worth flagging and its one ×.
 *
 * Written once because there are two things that can be inside it — the
 * readings, and the sentence that stands in for them until the first snapshot
 * lands — and a header copied into a second branch is how one × ends up saying
 * something the other does not.
 *
 * THE HEAD STAYS PUT WHEN THE BODY SCROLLS. On a short window the panel is
 * taller than its slot, and everything that scrolled away first was the part
 * that says what you are looking at and how to close it. It is sticky against
 * the panel's own scrollport now, on the panel's own ground, and the flag rides
 * with it: a machine held below full speed should not be a fact you have to
 * scroll back up to find.
 */
function Shell({ usageOpen, leaving, sub, flag, onClose, children }: {
  usageOpen: boolean;
  /** Asked to close, still on screen for the length of its exit. */
  leaving?: boolean;
  /** The uptime and the core count, which only a measured panel has. */
  sub?: string;
  /** The one condition worth saying at the top, or nothing at all. */
  flag?: string | null;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    // Named by its own heading (#879). The title was a styled <span>, so this
    // was the one panel a screen reader's heading list skipped: Usage and
    // Claude accounts each open with an <h2>, and a reader moving by heading
    // went from one to the other past it. The landmark takes its name from
    // the heading so the region and its title cannot disagree.
    <aside className={`sysdetail${usageOpen ? " shifted" : ""}${leaving ? " leaving" : ""}`} id="system-panel" aria-labelledby="sd-title">
      <div className="sd-top">
        <div className="sd-head">
          <h2 className="sd-title" id="sd-title">This machine</h2>
          {sub && <span className="sd-sub">{sub}</span>}
          <button type="button" className="glyph-btn sd-close" onClick={onClose} aria-label="Close" title="Close">×</button>
        </div>
        {flag && <p className="sd-flag">{flag}</p>}
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
export default function MachinePanel({ usageOpen, leaving, onClose }: {
  usageOpen: boolean;
  /** Asked to close, still on screen for the length of its exit. */
  leaving?: boolean;
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
      <Shell usageOpen={usageOpen} leaving={leaving} onClose={onClose}>
        <div className="sd-note">reading this machine…</div>
      </Shell>
    );
  }

  const { memory, swap, perCore, loadavg, cores, uptimeSec, platform, thermal, network, cpu } = sys;

  return (
    <Shell
      usageOpen={usageOpen}
      leaving={leaving}
      sub={`up ${uptime(uptimeSec)} · ${cores} cores`}
      flag={attentionFlag(sys)}
      onClose={onClose}
    >
      <CpuSection cpu={cpu} perCore={perCore} loadavg={loadavg} cores={cores} />
      <MemorySection memory={memory} swap={swap} platform={platform} />
      {network && <NetworkSection network={network} />}
      <ThermalSection thermal={thermal} />
      <Processes sys={sys} />
    </Shell>
  );
}

/**
 * What this machine is doing with its cores, and what is waiting for them.
 *
 * ONE SECTION, TWO READINGS, and they were two sections until the strip and the
 * load average had a panel's width between them — cores at the top, load
 * halfway down sharing a line with the network, which is a different question
 * about a different device. A load average is a statement about the CPU's queue
 * and it is unreadable without the core count the strip is drawing; together
 * they answer "is this box coping" in one glance, which neither does alone.
 *
 * Two controls rather than one, because there are two charts: the strip opens
 * what every core did, the figures open what the queue did. The alternative —
 * one button over both — would open one of the two and leave the other
 * unreachable from the block it belongs to.
 */
function CpuSection({ cpu, perCore, loadavg, cores }: {
  cpu: number | null;
  perCore: number[] | null;
  loadavg: number[] | null;
  cores: number;
}) {
  const hasStrip = !!perCore && perCore.length > 0;
  if (!hasStrip && !loadavg) return null;
  return (
    <div className="sd-section sd-cpu" role="group" aria-label="CPU">
      {hasStrip && (
        <OpensHistory group="cores" title="Core history" action="Show core history" label="CPU"
          value={cpu == null ? null : `${Math.round(cpu)}%`}>
          {/* One column per logical core — what `os.cpus()` counts, which is
              threads on a machine with SMT and physical cores on one without.
              The aggregate beside the heading cannot tell a saturated machine
              from one hot single-threaded job; this can.

              No `--n` any more: the strip counted its own columns into a
              custom property so the grid could repeat a 1fr track that many
              times, and that had no minimum — at 64 threads a column measured
              1.93px and at 128 it measured zero. The strip wraps now and the
              count is the number of children, which the layout can see for
              itself.

              ONE ACCESSIBLE NAME FOR THE WHOLE STRIP, not one per column: a
              pointer gets the per-core figure from each column's own tooltip,
              and a reader who cannot hover gets the two numbers that matter —
              how many cores there are and how hard the busiest is working —
              without 64 nodes to step through. The chart behind the button has
              the rest. */}
          <div
            className="sd-cores"
            role="img"
            aria-label={`${perCore!.length} logical cores, busiest at ${Math.round(Math.max(...perCore!))}%`}
          >
            {perCore!.map((v, i) => (
              <span key={i} className="sd-core" title={`logical core ${i + 1} · ${v}% busy`}>
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
      )}
      {loadavg && (
        <OpensHistory
          group="load" title="Load history" action="Show load history" label="Load average"
          hint="the queue for the cores, counted in tasks rather than as a share of them"
        >
          {/* The figures keep the number on top and the window under it: these
              are three samples of ONE reading rather than three named ones, and
              the eye compares 1m with 15m down the row. The network's three ARE
              named, and it puts the name on top for that reason. */}
          <div
            className="sd-figs"
            title="The queue for this machine's cores, averaged over one, five and fifteen minutes. A count of tasks, not a share of the CPU."
          >
            {loadavg.map((v, i) => (
              <Fig key={i} value={v.toFixed(2)} cap={["1m", "5m", "15m"][i]} />
            ))}
          </div>
          {/* NOTHING HERE WHEN THE QUEUE FITS. It read "within 16 cores" on
              every quiet machine, which is the core count from the panel's own
              header and the figures' own comparison, said a third time. The
              sentence below says something the figures cannot: by how much the
              queue exceeds the cores once it has. No colour on it — see the
              note at the top of this file about what a load average counts. */}
          {loadavg[0] > cores && (
            <div className="sd-note">
              {`${(loadavg[0] / cores).toFixed(1)}× more work queued than cores to run it`}
            </div>
          )}
        </OpensHistory>
      )}
    </div>
  );
}

/**
 * What the machine is holding, and what is left.
 *
 * The used figure is the total less what the kernel says it can hand over
 * without swapping, which is the same arithmetic the server's own `usedPct`
 * does — not the OS's "used" column, which counts caches it would give back on
 * demand. One definition, in one place, so the bar and the figure cannot
 * disagree.
 *
 * NO NOTE UNDER SWAP. It read "paging to disk" above half full, and that is a
 * claim about what the machine is doing right now that nothing here measures:
 * an occupied swap file is pages that were moved out at some point, possibly
 * hours ago, on a machine that has not touched the disk since. The rate that
 * would justify the sentence — Linux's pswpin/pswpout, or a Windows page-fault
 * counter — is not sampled, so the row says what it has: how much is held.
 */
function MemorySection({ memory, swap, platform }: {
  memory: Memory;
  swap: Swap | null;
  platform: string;
}) {
  const used = memory.total - memory.available;
  // Windows has no swap file in the Unix sense; what the same query reports
  // there is commit charge, so it is named for what it is.
  const swapLabel = platform === "win32" ? "Commit" : "Swap";
  const swapPct = swap && swap.total > 0 ? (swap.used / swap.total) * 100 : 0;
  return (
    <div className="sd-section" role="group" aria-label="Memory">
      <OpensHistory group="memory" title="Memory history" action="Show memory history" label="Memory">
        <Row
          label="Physical"
          value={<><b>{bytes(used)}</b> of {bytes(memory.total)}</>}
          pct={memory.usedPct}
          tone={memory.usedPct >= 90 ? "warn" : "calm"}
          note={`${bytes(memory.available)} available`}
        />
        {swap && swap.total > 0 && (
          <Row
            label={swapLabel}
            value={<><b>{bytes(swap.used)}</b> of {bytes(swap.total)}</>}
            pct={swapPct}
            tone={swapPct >= 90 ? "warn" : "calm"}
          />
        )}
      </OpensHistory>
    </div>
  );
}

/**
 * What the connection is moving, how far Claude is, and — behind one press —
 * which way any of it is going.
 *
 * THREE FIGURES, TWO MEASUREMENTS. Down and up are this machine's own interface
 * counters, every physical wire and radio it has, differenced over five
 * seconds. The third is a TCP handshake with one host: it costs no tokens and
 * sends nothing, and it says nothing about the other two. Set as an even row of
 * three they would read as one connection's three readings, so the latency sits
 * apart at the far edge with the host in its caption, and the disclosure under
 * them says both scopes in words.
 *
 * The figures are set exactly as the load average's are — the number in the
 * weight, its unit and direction in the caption under it — so the two read as
 * one kind of thing. Bytes rather than bits, like the memory above
 * (net-format.ts).
 */
function NetworkSection({ network }: { network: Network }) {
  const { down, up, api, route } = network;
  const [details, setDetails] = useState(false);
  const latency = api && api.ms != null ? latencyFigure(api.ms) : null;
  const rates = down != null && up != null;
  return (
    <div className="sd-section" role="group" aria-label="Network">
      <OpensHistory group="network" title="Network history" action="Show network history" label="Network">
        {(rates || latency) && (
          /* THE NAME ON TOP HERE, and under it the value with its unit beside
             it. These three columns are three different measurements, so the
             first thing each needs to say is which one it is — the same order
             the memory rows read in, label then figure. Written the other way
             round the caption had to carry both the unit and the name, and
             "KB/s down" puts the unit where the name belongs. */
          <div className="sd-figs sd-figs-named">
            {rates && ([["Download", down!], ["Upload", up!]] as const).map(([name, v]) => {
              const f = rateFigure(v);
              return <Fig key={name} value={f.value} unit={f.unit} cap={name} />;
            })}
            {latency && <Fig value={latency.value} unit={latency.unit} cap="Claude API" />}
          </div>
        )}
        {/* The first rate needs two readings five seconds apart, and the two
            probes do not land together: a latency that has arrived is drawn
            rather than held back until the counters catch up. */}
        {!rates && <div className="sd-note">measuring…</div>}
        {api && api.ms == null && (
          // The one network state that is a fault rather than a figure stays in
          // the panel, never folded into the disclosure below: a connection
          // that cannot be asked is exactly what somebody opens this to find.
          <div className="sd-note sd-note-warn">Can’t reach Claude</div>
        )}
      </OpensHistory>
      {route && (
        <>
          {/* THE PATH IS BEHIND A PRESS, and it was two lines of sentence under
              the figures before — "Traffic to Claude goes through Tailscale
              exit node …, relayed via fra" — which is worth reading once and
              then occupies the panel forever. What stays outside is the part
              that changes what you should do: a relayed path is slower than the
              same node reached directly, and it is named here in the warning
              colour whether or not anybody opens the detail. */}
          <button
            type="button"
            className="sd-detail"
            id="sd-conn"
            aria-expanded={details}
            aria-haspopup="dialog"
            onClick={() => setDetails(o => !o)}
          >
            Connection details
            {route.relay && <span className="sd-route-relay"> · relayed</span>}
            <i className="sd-row-more" aria-hidden>›</i>
          </button>
          {details && <ConnectionDetails route={route} api={api} onClose={() => setDetails(false)} />}
        </>
      )}
    </div>
  );
}

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
function Fig({ value, unit, cap }: { value: string; unit?: string; cap: string }) {
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

/** The path, in the words the server's own route label uses. */
function pathText(route: NetRoute): string {
  if (route.kind === "tailscale-exit") return route.node ? `Tailscale exit node ${route.node}` : "a Tailscale exit node";
  if (route.kind === "tailscale") return "Tailscale";
  return `${route.name ? `${route.name} ` : ""}VPN${route.iface ? ` (${route.iface})` : ""}`;
}

/**
 * Which way the traffic goes, and what each figure above it was measuring.
 *
 * A popover rather than a dialog: it is four short facts about the row it hangs
 * off, nothing here is a task, and a scrim over the canvas to read a route
 * would be a modal for something that needs neither interruption nor protected
 * focus. AnchoredPopover owns the placement, the Escape, the press-outside and
 * the hand-back of focus to the button; the panel it hangs off is its boundary,
 * so scrolling the route out of view closes it rather than leaving it floating
 * over the canvas.
 *
 * Every row is a reading that exists. A direct line draws no route at all — the
 * server reports one only when the path is not this machine's own — so this is
 * never a surface with "direct" written on it, and it is not rendered at all
 * when there is nothing to disclose.
 */
function ConnectionDetails({ route, api, onClose }: {
  route: NetRoute;
  api: Network["api"];
  onClose: () => void;
}) {
  return (
    <AnchoredPopover
      anchorId="sd-conn"
      boundaryId="system-panel"
      id="sd-conn-pop"
      className="sd-pop"
      role="dialog"
      labelledBy="sd-conn-title"
      onClose={onClose}
    >
      <p className="sd-pop-title" id="sd-conn-title">Connection</p>
      <dl className="sd-pop-rows">
        <div className="sd-pop-row">
          <dt>{route.to === "claude" ? "Traffic to Claude" : "Internet traffic"}</dt>
          <dd>through {pathText(route)}</dd>
        </div>
        {route.relay && (
          <div className="sd-pop-row">
            <dt>Relay</dt>
            <dd>
              <span className="sd-route-relay">{route.relay}</span> — not a direct path, so every packet
              carries one more round trip than it has to
            </dd>
          </div>
        )}
        {api && (
          <div className="sd-pop-row">
            <dt>Round trip</dt>
            <dd>{api.ms == null ? `${api.host} did not answer` : `${figureText(latencyFigure(api.ms))} to open a connection to ${api.host}`}</dd>
          </div>
        )}
        <div className="sd-pop-row">
          <dt>Throughput</dt>
          <dd>every interface on this machine, not this path alone</dd>
        </div>
      </dl>
    </AnchoredPopover>
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
function OpensHistory({ group, title, action, label, value, hint, children }: {
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
 * Is this machine getting hot, and is it being held back for it.
 *
 * The question the sections above cannot answer. A saturated machine that is
 * cool is a machine doing work; a saturated machine that is thermally limited
 * is one where the next agent you launch makes everything slower, and a load
 * average of 67 reads identically in both cases.
 *
 * Headed "Thermal" rather than "Temperature", and that is a decision rather
 * than a hedge: on macOS the honest reading is not degrees at all — no CPU
 * sensor is readable without root, and what IS readable is how much of the
 * CPU's speed the thermal manager is currently allowing. A "Temperature"
 * heading over that would be a heading that lies on every Apple Silicon
 * install. "Thermal" holds degrees where the machine has them and the
 * consequence where it does not, and every row still says what it measured.
 *
 * THE TRACK ENDS WHERE THE ROW TURNS RED. It was 0–100°C for every sensor,
 * which is a limit this app invented: it put a 63°C drive at two thirds of a
 * scale whose end means nothing, and on a chip whose own critical point is 100
 * it was a coincidence rather than a scale. Each row is drawn against its own
 * `critAt` — the chip's where hwmon publishes one, the 90 the server falls back
 * to otherwise — with a mark at the temperature the fill turns amber. So a full
 * bar is the one claim the reading supports: this row is at the point it is
 * called critical, whoever called it.
 *
 * Nothing is drawn when the machine publishes nothing. Not a zero, not a dash,
 * not an empty bar — the same refusal that keeps `cpu` null until two samples
 * exist. On a platform with no sensor this section has never existed.
 */
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
            pct={(r.celsius / r.critAt) * 100}
            mark={(r.warnAt / r.critAt) * 100}
            tone={thermalTone(r.celsius, r.warnAt, r.critAt)}
            // WHAT THE BAR AND THE MARK ARE, in both the places a reader can
            // ask. The scale is stated as this app's own rule — where the row
            // turns amber, where it turns red — and never as a claim about the
            // silicon: `critAt` is the chip's own `temp*_crit` where hwmon
            // publishes one and the server's 90 where it does not, and nothing
            // in the snapshot says which. A sentence that named the hardware
            // would be right on one machine and wrong on the next.
            title={`bar runs 0–${r.critAt} °C · amber from ${r.warnAt} °C, red at ${r.critAt} °C`}
            trackLabel={`${r.celsius} °C on a bar that runs to ${r.critAt} °C, amber from ${r.warnAt} °C`}
          />
        ))}
        {held && (
          <Row label="Throttling" value={<b>{held.value}</b>} pct={held.pct} tone={held.tone} note={held.note} />
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
    <div className="sd-section sd-door-section">
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
function Row({ label, value, pct, tone = "calm", note, mark, title, trackLabel }: {
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
