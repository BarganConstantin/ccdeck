// Claude FM — the one control on this deck that exists to be enjoyed.
//
// A small character stands beside the minimap. Press it and the Claude
// channel's live stream plays; press it again and it stops. It dances while
// the music is on and stands still when it is not. That is the whole feature,
// and the rest of this file is the three ways it is allowed to be absent.
//
// ── absent, not broken ──────────────────────────────────────────────────────
//
// Nothing here renders unless there is something to play. The server is asked
// once whether the channel is broadcasting (src/server/claude-fm.mjs), and if
// the answer is no — off air, no network, YouTube unreachable, prefs say no —
// the canvas is exactly as it was before this file existed. The same is true
// after the fact: if the player reports an error, the character leaves and does
// not come back for the life of the tab.
//
// The alternative is a control that presses and does nothing, and a control
// that presses and does nothing is worse than no control. There is no error
// state, no "music unavailable" chip and no retry: a toy that cannot work
// should be invisible, not apologetic.
//
// ── the iframe ──────────────────────────────────────────────────────────────
//
// Mounted on the first press and never before. That matters twice: a page that
// starts making noise on load is a bug, and an iframe that exists has already
// called Google whether or not anybody pressed anything. Until somebody asks
// for music, this component is a button and an SVG.
//
// It is `visually-hidden` rather than `display: none` — a display:none iframe
// is allowed to be throttled or torn down, and this one has to keep playing
// while the tab is in the background, which is most of the time it is wanted.
//
// ── talking to the player ───────────────────────────────────────────────────
//
// postMessage, not the iframe API script. Loading `youtube.com/iframe_api`
// would put a third-party script in a bundle that has none and would run before
// anybody pressed play; the same commands go over postMessage with nothing
// added to the page. Every message that comes back is checked against the
// player's origin before it is read — see the handler.
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
  type CSSProperties,
} from "react";
import {
  choreSteps, CHORE_CHANCE, command, embedSrc, FATAL_ERRORS, FULL_VOLUME, DUCK_VOLUME,
  GEAR_CELLS, listenCommand, LITTER, LITTER_H, LITTER_W, litterSpot, nextIdleMs, nextWalk,
  PLAYER_ORIGIN, readSignal, spriteRects, SPRITE_H, SPRITE_W, type ChoreStep,
} from "../claude-fm";

/** What the deck's own sounds need from this: a way to get out of their way.
 *  App holds the ref and calls `duck` as it plays a chime. */
export interface ClaudeFmHandle {
  /** Drop the music for `ms`, then bring it back. Safe to call when nothing is
   *  playing, which is most of the time. */
  duck: (ms: number) => void;
}

interface Probe { live: boolean; channel: string }

/** What each grid cell is drawn as. A map here rather than a chain of
 *  comparisons in the markup below, because unstyled-class.test.ts reads every
 *  string a `className` expression holds and would count a bare `"e"` as a
 *  class this deck hard-codes and never styles — which is exactly the typo that
 *  test exists to catch. The names are quoted in a .tsx, which is also what
 *  dead-css.test.ts looks for before calling a rule unused. A cell with no
 *  entry takes its group's own fill. */
/** A grid drawn as one SVG of merged runs. Shared by the character and the
 *  thing it picks up, which are the same kind of object at different sizes. */
function pixels(grid: readonly string[], key: string) {
  const w = grid[0]?.length ?? 0;
  return (
    <svg viewBox={`0 0 ${w} ${grid.length}`} shapeRendering="crispEdges" aria-hidden>
      {spriteRects(grid).map(r => (
        <rect key={`${key}${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} />
      ))}
    </svg>
  );
}

const CELL_CLASS: Record<string, string | undefined> = {
  e: "fm-eye",
  s: "fm-shade",
  p: "fm-pad",
};


export default forwardRef<ClaudeFmHandle, { fetchImpl?: typeof fetch }>(
  function ClaudeFm({ fetchImpl }, ref) {
    const [probe, setProbe] = useState<Probe | null>(null);
    /** Set once and never unset: the player told us it cannot play here. */
    const [dead, setDead] = useState(false);
    /** Whether the iframe exists at all. Separate from `playing`, because a
     *  pause keeps the player loaded and a second press should resume rather
     *  than reload a live stream from the top. */
    const [armed, setArmed] = useState(false);
    const [playing, setPlaying] = useState(false);

    /** Where along the minimap's top edge it is standing, in pixels left of
     *  the right-hand end. Zero is where it starts. */
    const [x, setX] = useState(0);
    const [walkMs, setWalkMs] = useState(0);
    /** What it is doing, which is what the sheet draws. Null when it is simply
     *  standing there, which is most of the time. */
    const [act, setAct] = useState<ChoreStep["act"] | null>(null);
    /** Where the piece of litter is sitting, or null when there is none. Once
     *  it is picked up it stops being here and starts being carried — two
     *  render slots for one object, because on the ledge it stays put and in
     *  hand it has to travel with the character, and a sibling element cannot
     *  do both. */
    const [litter, setLitter] = useState<number | null>(null);
    const [held, setHeld] = useState(false);

    const frame = useRef<HTMLIFrameElement | null>(null);
    const duckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    /** One place that talks to the player, so every send is origin-targeted
     *  rather than `"*"` — a wildcard target posts the message to whatever
     *  document happens to be in the frame, which is not a thing to be relaxed
     *  about even for a volume change. */
    const say = useCallback((json: string) => {
      frame.current?.contentWindow?.postMessage(json, PLAYER_ORIGIN);
    }, []);

    // WHETHER THERE IS ANYTHING TO PLAY. One request, on mount, and the answer
    // is cached by the server for everyone else. A failure is indistinguishable
    // from "not live" on purpose: both mean nothing renders.
    useEffect(() => {
      let alive = true;
      const get = fetchImpl ?? fetch;
      get("/api/claude-fm")
        .then(r => r.ok ? r.json() : null)
        .then(a => { if (alive && a?.live && a?.channel) setProbe({ live: true, channel: a.channel }); })
        .catch(() => { /* no music today */ });
      return () => { alive = false; };
    }, [fetchImpl]);

    // WHAT THE PLAYER SAYS BACK, once the iframe's onLoad below has opened the
    // conversation. The origin check is the whole security of this listener:
    // `message` fires for anything on the page that posts one, and this reads
    // JSON out of it.
    useEffect(() => {
      if (!armed) return;
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== PLAYER_ORIGIN) return;
        const signal = readSignal(e.data);
        if (!signal) return;
        // AUTOPLAY IS ASKED FOR TWICE, because once is not reliable. The src
        // carries `autoplay=1` and the frame is built inside the click that
        // asked for music, which is everything the autoplay policy wants — and
        // the player still came up at state -1 (unstarted) on a real deck. A
        // `playVideo` the moment it is ready costs nothing when the stream is
        // already running and is the difference between a press that works and
        // a press that silently does not.
        if (signal.kind === "ready") { say(command("playVideo")); return; }
        if (signal.kind === "playing") { setPlaying(signal.playing); return; }
        if (FATAL_ERRORS.includes(signal.code)) {
          // The stream is gone, or this channel does not allow embedding. There
          // is nothing to offer and nothing to say about it.
          setArmed(false);
          setPlaying(false);
          setDead(true);
        }
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [armed, say]);

    useEffect(() => () => { if (duckTimer.current) clearTimeout(duckTimer.current); }, []);

    // THE STROLL. Long stillness, a short slow walk along the edge, long
    // stillness — see claude-fm.ts for why the restraint is the design.
    //
    // Not while the music is on: it has somewhere to be, and a character that
    // wanders off mid-track reads as a bug rather than as life. Not at all for
    // somebody who asked for no motion — and asked in the one place that
    // answer lives, rather than by hiding the movement behind a media query
    // that would leave the timers running for nobody.
    useEffect(() => {
      if (!probe || dead || playing) return;
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

      let timer: ReturnType<typeof setTimeout> | null = null;
      let here = 0;
      setX(now => (here = now));

      /** Walks the list one step at a time. Each step says how the world should
       *  look and how long to hold it there; nothing here decides what the list
       *  is (claude-fm.ts does) and nothing there knows about a clock. */
      const run = (steps: ChoreStep[]) => {
        const [step, ...rest] = steps;
        if (!step) { setAct(null); setHeld(false); idle(); return; }
        setWalkMs(step.ms);
        setAct(step.act);
        setX(step.x);
        here = step.x;
        // The litter leaves the ledge at the moment it is picked up, which is
        // the end of the stoop rather than the start of it.
        if (step.act === "carry") { setLitter(null); setHeld(true); }
        if (step.act === "toss") setHeld(false);
        timer = setTimeout(() => run(rest), step.ms);
      };

      const idle = () => {
        timer = setTimeout(() => {
          if (Math.random() < CHORE_CHANCE) {
            const at = litterSpot(here, Math.random);
            setLitter(at);
            run(choreSteps(here, at));
          } else {
            const trip = nextWalk(here, Math.random);
            run([{ x: trip.to, litter: null, act: "walk", ms: trip.ms }]);
          }
        }, nextIdleMs(Math.random));
      };

      idle();
      return () => {
        if (timer) clearTimeout(timer);
        // Whatever it was in the middle of, it is not any more. Leaving a piece
        // of litter on the ledge that nothing will ever come back for is the
        // one way this can litter for real.
        setAct(null);
        setHeld(false);
        setLitter(null);
      };
    }, [probe, dead, playing]);

    useImperativeHandle(ref, () => ({
      duck(ms: number) {
        if (!playing) return;
        if (duckTimer.current) clearTimeout(duckTimer.current);
        say(command("setVolume", [DUCK_VOLUME]));
        duckTimer.current = setTimeout(() => {
          say(command("setVolume", [FULL_VOLUME]));
          duckTimer.current = null;
        }, ms);
      },
    }), [playing, say]);

    if (!probe || dead) return null;

    const press = () => {
      if (!armed) { setArmed(true); setPlaying(true); return; }
      // Optimistic: the player confirms with onStateChange a moment later, and
      // a control that waits for a round trip before it looks pressed feels
      // broken on a stream that takes a second to buffer.
      const next = !playing;
      setPlaying(next);
      say(command(next ? "playVideo" : "pauseVideo"));
    };

    return (
      <div className="fm">
        {/* On the ledge, and not inside the walker: a thing lying on the floor
            does not travel with whoever is about to pick it up. */}
        {litter != null && (
          <div className="fm-litter" style={{ "--fm-litter-x": `${litter}px` } as CSSProperties}>
            {pixels(LITTER, "l")}
          </div>
        )}
        <div
          className="fm-walker"
          data-act={act ?? undefined}
          style={{
            // Where it is standing and how long the current trip takes. Inline
            // because both are values rather than states: a class per pixel of
            // the ledge is not a thing a stylesheet can hold.
            "--fm-x": `${x}px`,
            "--fm-walk-ms": `${walkMs}ms`,
          } as CSSProperties}
        >
        {/* In hand, so it travels with the character — and on the way out,
            so the throw has something to animate. */}
        {(held || act === "toss") && (
          <div className="fm-held" data-toss={act === "toss" ? "" : undefined}>
            {pixels(LITTER, "h")}
          </div>
        )}
        <button
          type="button"
          className="fm-sprite"
          data-playing={playing ? "" : undefined}
          aria-pressed={playing}
          onClick={press}
          title={playing ? "Stop Claude FM" : "Play Claude FM — streams from YouTube"}
          aria-label={playing ? "Stop Claude FM" : "Play Claude FM"}
        >
          <svg viewBox={`0 0 ${SPRITE_W} ${SPRITE_H}`} shapeRendering="crispEdges" aria-hidden>
            {/* Two groups so the body can bob while the cups hold still — a
                character whose headphones swim around its head reads as a
                glitch rather than as dancing. */}
            <g className="fm-gear">
              {spriteRects().filter(r => GEAR_CELLS.has(r.cell)).map(r => (
                <rect
                  key={`g${r.y}-${r.x}`}
                  x={r.x} y={r.y} width={r.w} height={1}
                  className={CELL_CLASS[r.cell]}
                />
              ))}
            </g>
            <g className="fm-body">
              {spriteRects().filter(r => !GEAR_CELLS.has(r.cell)).map(r => (
                <rect
                  key={`b${r.y}-${r.x}`}
                  x={r.x} y={r.y} width={r.w} height={1}
                  className={CELL_CLASS[r.cell]}
                />
              ))}
            </g>
          </svg>
        </button>
        </div>
        {armed && probe.channel && (
          <iframe
            ref={frame}
            className="fm-frame"
            title="Claude FM"
            src={embedSrc(probe.channel, window.location.origin)}
            // THE HANDSHAKE GOES HERE AND NOWHERE ELSE, and the first build had
            // it the wrong way round: it waited for `onReady` and answered that
            // with `listening`. `onReady` is not something the player
            // volunteers — it is the reply to `listening`, so nothing was ever
            // sent, nothing ever came back, and an embed that could not play at
            // all would have looked exactly like one that was playing fine. The
            // frame's own load is the first moment there is anything to talk
            // to.
            onLoad={() => say(listenCommand())}
            // The permissions the stream needs and not one more. Nothing here
            // is ever seen or pointed at — the player is parked off-screen.
            allow="autoplay; encrypted-media"
            sandbox="allow-scripts allow-same-origin allow-presentation"
          />
        )}
      </div>
    );
  },
);
