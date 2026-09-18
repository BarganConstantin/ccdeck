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
  command, embedSrc, FATAL_ERRORS, FULL_VOLUME, DUCK_VOLUME, GEAR_CELLS,
  listenCommand, nextActivity, nextIdleMs, PLAYER_ORIGIN, PROP_ART, readSignal,
  spriteRects, SPRITE_H, SPRITE_W,
  ballRollTo, BALL_FLIGHT_MS, BEAT_MS, crossSteps, DANCES, facingFor, HAT, HAT_X, HAT_Y, SKIP_BEAT_MS,
  LEG_SPLIT_COL, LEG_TOP_ROW, walkMsFor,
  nextDance, nextDanceMs, WALK_SPAN_PX,
  type Act, type Dance, type Facing, type Ground, type Obstacle, type Place,
  type Prop, type Step,
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
        <rect key={`${key}${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1}
          fill={r.cell === "s" ? "var(--fm-prop-shadow, var(--bg))" : r.cell === "l" ? "var(--fm-prop-light, var(--text))" : r.cell === "a" ? "var(--accent)" : undefined} />
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
    const [act, setAct] = useState<Act | null>(null);
    /** The thing on the ledge it is doing something with, or null. It is
     *  drawn in one of two places: on the ledge while it lies there, and
     *  inside the walker once it is held — because on the floor it must stay
     *  put and in hand it must travel, and one element cannot do both. */
    const [prop, setProp] = useState<Prop | null>(null);
    const [ballFlight, setBallFlight] = useState({ x: 0, drop: 0 });
    /** Which surface it is standing on. The ledge for all but one activity. */
    const [place, setPlace] = useState<Place>("ledge");
    /** Which way it is looking. Without it a symmetric sprite walking left is
     *  the same picture as one walking right, which reads as reversing. */
    const [facing, setFacing] = useState<Facing>("left");
    /** How far above its surface it is standing. Non-zero only when it is on
     *  top of something sitting on the canvas floor. */
    const [riser, setRiser] = useState(0);
    const scene = useRef<HTMLDivElement | null>(null);
    /** Which of the three dances, and at what tempo. Changed every ten seconds
     *  or so while the music is on — one loop repeated forever reads as a GIF
     *  rather than as a character. */
    const [dance, setDance] = useState<Dance | null>(null);
    const [beatMs, setBeatMs] = useState(BEAT_MS);
    const [reducedMotion, setReducedMotion] = useState(
      () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    );
    useEffect(() => {
      const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
      if (!query) return;
      const changed = () => setReducedMotion(query.matches);
      changed();
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    }, []);

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

    // WHAT IT DOES WITH ITSELF. A rest, then an activity, then
    // long stillness again — see claude-fm.ts for why the restraint is the
    // design.
    //
    // THIS RUNS WHETHER OR NOT THE MUSIC IS ON, which is the opposite of what
    // it did first. Stopping the errands while something played made the
    // character less alive exactly when it was most looked at: it stood in one
    // spot and danced for as long as the track ran. It goes about its business
    // either way now — wearing the headphones while the music is on, which is
    // what anybody does — and the dance fills the gaps between errands rather
    // than replacing them.
    //
    // Not at all for somebody who asked for no motion, and asked in the one
    // place that answer lives, rather than by hiding the movement behind a
    // media query that would leave the timers running for nobody.
    useEffect(() => {
      if (!probe || dead) return;
      if (reducedMotion) return;

      let timer: ReturnType<typeof setTimeout> | null = null;
      let here = 0;
      setX(now => (here = now));

      /** Walks the list one step at a time. Each step says how the world should
       *  look and how long to hold it there; nothing here decides what the list
       *  is (claude-fm.ts does) and nothing there knows about a clock. */
      const run = (steps: Step[]) => {
        const [step, ...rest] = steps;
        if (!step) { setAct(null); setProp(null); idle(); return; }
        setAct(step.act);
        setProp(step.prop);
        setPlace(step.place ?? "ledge");
        setRiser(step.riser ?? 0);
        const to = reachable(step);
        // React may evaluate this updater after `here` has advanced below.
        // Capture the departure point so a turn cannot compare the target
        // with itself and silently keep the previous facing.
        const from = here;
        if (step.act === "kick") {
          const ball = scene.current?.querySelector('.fm-prop[data-prop="ball"]')?.getBoundingClientRect();
          if (ball) {
            setBallFlight({
              x: ballRollTo(ball.x, facingFor(step, from, "left"), window.innerWidth),
              drop: Math.max(48, window.innerHeight - ball.y + 24),
            });
          }
        }
        const moving = step.act === "walk" || step.act === "carry";
        const duration = moving ? walkMsFor(from, to) : step.ms;
        setWalkMs(duration);
        setFacing(was => facingFor({ ...step, x: to }, from, was));
        setX(to);
        here = to;
        timer = setTimeout(() => run(rest), duration);
      };

      /**
       * How much floor there is, right now.
       *
       * EVERY NUMBER COMES FROM A RECT, and none from `getComputedStyle`. That
       * is the cost #612/#613 removed from this canvas, and render-path-cost
       * keeps a list of the two files still allowed it; adding a third is what
       * that test exists to make somebody think twice about. The gutter is the
       * gap between the scene and its parent, which is already laid out.
       */
      const floorReach = (): number | null => {
        const el = scene.current;
        const sprite = el?.querySelector<HTMLElement>(".fm-sprite");
        const parent = el?.parentElement;
        if (!el || !sprite || !parent) return null;
        const box = el.getBoundingClientRect();
        const outer = parent.getBoundingClientRect();
        const gutter = outer.right - box.right;
        const span = outer.width - gutter * 2 - sprite.offsetWidth;
        return span > 0 ? span : null;
      };

      /**
       * What a trip needs to know: how far there is to fall, and how much floor
       * is at the bottom. The minimap is a fixed size; the canvas is whatever
       * the window is today, and both change on a resize — so both are read
       * when a trip is planned rather than held in a constant.
       *
       * The ledge height is how far the walker is standing above the scene's
       * own floor, which is only meaningful while it is up there. That is the
       * only moment a trip is ever planned, so it is the only moment this is
       * asked.
       */
      const ground = (): Ground | undefined => {
        const el = scene.current;
        const walker = el?.querySelector<HTMLElement>(".fm-walker");
        const floorSpan = floorReach();
        if (!el || !walker || floorSpan == null) return undefined;
        const ledgeH = el.getBoundingClientRect().bottom - walker.getBoundingClientRect().bottom;
        if (!(ledgeH > 0)) return undefined;
        return { ledgeH, floorSpan };
      };

      /**
       * Whatever is standing on the canvas floor in the character's way.
       *
       * The deck's controls sit on that floor and the character walks along it,
       * so without this it strolls straight through the Auto-fit chip as though
       * the chip were a picture of one. Read from the page each time a walk is
       * planned: the chip only exists while auto-fit is off, and a walk planned
       * when it was there must not assume it still is.
       *
       * Converted into the character's own coordinates, which count leftward
       * from the scene's right edge.
       */
      const obstacle = (): Obstacle | null => {
        const el = scene.current;
        const chip = document.querySelector<HTMLElement>(".autofit-chip");
        if (!el || !chip) return null;
        const box = el.getBoundingClientRect();
        const bar = chip.getBoundingClientRect();
        if (bar.width <= 0 || bar.height <= 0) return null;
        return {
          left: bar.left - box.right,
          right: bar.right - box.right,
          height: bar.height,
        };
      };

      /**
       * The step's target, brought inside whatever room there is NOW.
       *
       * A trip is planned in one go against the floor it measured at the time,
       * and then takes the better part of ten seconds to walk. Narrow the
       * window in the middle of one and those targets are suddenly off the left
       * edge of a canvas that no longer reaches them — the character would walk
       * out of the deck and come back from nowhere.
       *
       * Clamping per step rather than re-planning keeps the trip's own shape:
       * it still goes down and comes back up at the same corner, because that
       * corner is inside any canvas wide enough to have shown the minimap in
       * the first place.
       */
      const reachable = (step: Step): number => {
        const room = (step.place ?? "ledge") === "floor"
          ? floorReach() ?? WALK_SPAN_PX
          : WALK_SPAN_PX;
        return Math.max(-room, Math.min(0, step.x));
      };

      const idle = () => {
        timer = setTimeout(() => {
          const plan = nextActivity(here, Math.random, ground());
          // A walk along the floor goes OVER whatever is standing on it. Every
          // other step is left exactly as planned — only floor walks can meet
          // anything, and only they are rewritten.
          const bar = plan.some(st => st.place === "floor") ? obstacle() : null;
          // Each walk is rewritten from where the one before it left off, so
          // the crossing knows which side of the obstacle it is approaching
          // from. Only floor walks can meet anything; every other step is
          // passed through exactly as planned.
          let at = here;
          const walked = plan.flatMap(st => {
            const from = at;
            at = st.x;
            return st.place === "floor" && st.act === "walk"
              ? crossSteps(from, st.x, bar)
              : [st];
          });
          run(walked);
        }, nextIdleMs(Math.random));
      };

      idle();
      return () => {
        if (timer) clearTimeout(timer);
        // Whatever it was in the middle of, it is not any more — and if that
        // was a trip, it must not be left standing on the canvas floor with
        // nothing scheduled to bring it home.
        setPlace("ledge");
        setX(now => Math.max(-WALK_SPAN_PX, Math.min(0, now)));
        setWalkMs(0);
        // Whatever it was in the middle of, it is not any more. Leaving a prop
        // on the ledge that nothing will ever come back for is the one way this
        // can litter for real.
        setAct(null);
        setProp(null);
        setRiser(0);
      };
    }, [probe, dead, reducedMotion]);

    // IT CHANGES ITS MIND. Only while something is playing — there is nothing to
    // dance to otherwise, and a timer running for a character standing still is
    // a timer running for nothing.
    useEffect(() => {
      if (!playing || reducedMotion) { setDance(null); return; }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const pick = (from: Dance | null) => {
        const next = nextDance(from, Math.random);
        setDance(next.dance);
        setBeatMs(next.beatMs);
        timer = setTimeout(() => pick(next.dance), nextDanceMs(Math.random));
      };
      pick(null);
      return () => { if (timer) clearTimeout(timer); };
    }, [playing, reducedMotion]);

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

    /** Everything that is not headphones, split below into torso and legs. */
    const body = spriteRects().filter(r => !GEAR_CELLS.has(r.cell));
    const torso = body.filter(r => r.y < LEG_TOP_ROW && r.cell !== "e")
      .map(r => {
        if (r.y !== 8 && r.y !== 9) return r;
        const x = Math.max(6, r.x);
        return { ...r, x, w: Math.max(0, Math.min(12, r.x + r.w) - x) };
      }).filter(r => r.w > 0);

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
      <div
        ref={scene}
        className="fm"
        data-place={place}
        style={{ "--fm-beat": `${beatMs}ms` } as CSSProperties}
      >
        {/* On the ledge, and not inside the walker: a thing lying on the floor
            does not travel with whoever is about to pick it up. */}
        {prop && !prop.held && (
          <div
            className="fm-prop"
            data-prop={prop.kind}
            data-leaving={prop.leaving ? "" : undefined}
            style={{
              "--fm-prop-x": `${prop.at}px`,
              "--fm-roll-to": `${ballFlight.x}px`,
              "--fm-ball-drop": `${ballFlight.drop}px`,
              "--fm-ball-flight-ms": `${BALL_FLIGHT_MS}ms`,
              "--fm-ball-turn": facing === "right" ? "1080deg" : "-1080deg",
            } as CSSProperties}
          >
            {pixels(PROP_ART[prop.kind], "p")}
          </div>
        )}
        {/* THE ROPE IS NOT INSIDE THE WALKER, and it cannot be: it is fixed to
            the ledge, and the character climbs past it. A rope that travelled
            with whoever was climbing it would be a rope climbing itself. */}
        {(act === "lasso" || act === "rope-throw" || act === "rope-catch" || act === "climb" || act === "pull-up") && (
          <div
            className="fm-rope"
            data-act={act}
            style={{ "--fm-rope-x": `${x}px`, "--fm-rope-ms": `${walkMs}ms` } as CSSProperties}
          >
            <div className="fm-rope-line" />
            <svg className="fm-rope-hook" viewBox="0 0 9 9" shapeRendering="crispEdges" aria-hidden>
              <path d="M4 8V3H3V1H1V3H0V5H2V4H3V6H5V4H6V5H8V3H7V1H5V3H4" />
              <rect className="fm-rope-knot" x="3" y="6" width="3" height="2" />
            </svg>
          </div>
        )}
        <div
          className="fm-walker"
          data-act={act ?? undefined}
          data-place={place}
          data-facing={facing}
          style={{
            // Where it is standing and how long the current trip takes. Inline
            // because both are values rather than states: a class per pixel of
            // the ledge is not a thing a stylesheet can hold.
            "--fm-x": `${x}px`,
            "--fm-walk-ms": `${walkMs}ms`,
            // How high whatever it is standing on is. Zero for the floor
            // itself, and the height of the Auto-fit chip while it is up there.
            "--fm-riser": `${riser}px`,
            "--fm-skip-beat": `${SKIP_BEAT_MS}ms`,
          } as CSSProperties}
        >
        {/* In hand, so it travels with the character — and on the way out,
            so the throw has something to animate. */}
        {prop?.held && (
          <div className="fm-held" data-prop={prop.kind} data-toss={prop.leaving ? "" : undefined}>
            {pixels(PROP_ART[prop.kind], "h")}
          </div>
        )}
        {(["cast", "fish", "reel", "stow"] as (Act | null)[]).includes(act) && (
          <svg className="fm-fishing" viewBox="0 0 24 32" shapeRendering="crispEdges" aria-hidden>
            <g>
              <path d="M24 11H22V9H20V7H18V5H16V3H13V2H8" />
              <rect className="fm-fishing-grip" x="21" y="9" width="3" height="3" />
            </g>
            <g className="fm-fishing-line">
              <path d="M8 2V26" />
              <g className="fm-float">
                <rect x="7" y="25" width="3" height="2" />
                <rect x="8" y="24" width="1" height="1" />
              </g>
            </g>
            <path className="fm-ripple" d="M3 28H6M10 28H14M5 30H12" />
          </svg>
        )}
        {(["skip-ready", "skip", "skip-rest"] as (Act | null)[]).includes(act) && (
          <svg className="fm-skipping-rope" viewBox="0 0 26 26" shapeRendering="crispEdges" aria-hidden>
            <path className="fm-skip-back" d="M5 18H3V8H5V5H8V2H18V5H21V8H23V18H21" />
            <path className="fm-skip-forward" d="M5 18H3V14H5V11H8V9H18V11H21V14H23V18H21" />
            <path className="fm-skip-front" d="M5 18H3V21H5V23H8V25H18V23H21V21H23V18H21" />
            <path className="fm-skip-return" d="M5 18H3V19H8V20H18V19H23V18H21" />
            <path className="fm-skip-handles" d="M5 17V19M21 17V19" />
          </svg>
        )}
        <button
          type="button"
          className="fm-sprite"
          data-playing={playing ? "" : undefined}
          data-dance={playing ? dance ?? DANCES[0] : undefined}
          aria-pressed={playing}
          onClick={press}
          title={playing ? "Stop Claude FM" : "Play Claude FM — streams from YouTube"}
          aria-label={playing ? "Stop Claude FM" : "Play Claude FM"}
        >
          <svg viewBox={`0 0 ${SPRITE_W} ${SPRITE_H}`} shapeRendering="crispEdges" aria-hidden>
            {/* Two groups so the body can bob while the cups hold still — a
                character whose headphones swim around its head reads as a
                glitch rather than as dancing. */}
            {/* TWO NESTED GROUPS, AND THE NESTING IS THE WHOLE TRICK. The outer
                one owns where the headphones are WORN — on the head while
                something is playing, down around the neck when nothing is — and
                the inner one owns how they move while worn. One element cannot
                hold both: a transition and an animation on the same transform
                do not compose, the animation simply wins, and the headphones
                would snap between the two positions instead of travelling.

                DRAWN BEFORE THE BODY ON PURPOSE. SVG paints in document order,
                so the body covers this — and that is what makes the neck
                position free: the band slides down behind the head and is
                simply gone, with the cups tucked behind the arms. Nothing has
                to be hidden, because nothing was ever in front. */}
            <g className="fm-gear">
              <g className="fm-gear-motion">
                {spriteRects().filter(r => GEAR_CELLS.has(r.cell)).map(r => (
                  <rect
                    key={`g${r.y}-${r.x}`}
                    x={r.x} y={r.y} width={r.w} height={1}
                    className={CELL_CLASS[r.cell]}
                  />
                ))}
              </g>
            </g>
            {/* THE LEGS ARE THEIR OWN PARTS, so they can take a step. A body
                that rises and falls without its legs alternating is a hop, not
                a walk — which is why the walk never looked like walking.

                They are separated by position rather than by a letter of their
                own in the grid: they are the only thing below LEG_TOP_ROW and
                there is nothing between them, so a row and a column is all it
                takes. The sprite stays eighteen lines of text. */}
            <g className="fm-body">
              {/* Fill the original eye cells before pupils move or blink.
                  Otherwise their old positions become holes showing the canvas. */}
              {body.filter(r => r.cell === "e").map(r => (
                <rect key={`eye-bed-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill="var(--accent)" />
              ))}
              {torso.map(r => (
                <rect
                  key={`b${r.y}-${r.x}`}
                  x={r.x} y={r.y} width={r.w} height={1}
                  className={CELL_CLASS[r.cell]}
                />
              ))}
              {/* Arms are separate from the torso so a greeting never moves
                  the head, feet, or the walking animation. Kept inside the
                  body group so they still follow its dance. */}
              <g className="fm-arms">
                <rect x={4} y={8} width={2} height={2} />
                <rect x={12} y={8} width={1} height={2} />
                <rect x={13} y={8} width={1} height={2} className="fm-shade" />
              </g>
              {/* Pupils paint last: looking right must not slide them beneath
                  the next body/shadow rectangle in SVG paint order. */}
              {body.filter(r => r.cell === "e").map(r => (
                <rect key={`eye-${r.x}`}
                  x={r.x - (r.x >= SPRITE_W / 2 ? 1 : 0) + (facing === "right" ? 1 : 0)}
                  y={r.y} width={r.w} height={1} className="fm-eye" />
              ))}
            </g>
            {/* DRAWN AFTER THE BODY, which is the whole reason it is its own group.
                The headphones are drawn BEFORE it so they can slide down and
                hide behind the head; a hat has to do the opposite — the brim
                sits over the forehead, so it has to be painted on top of it. */}
            <g className="fm-hat">
              {spriteRects(HAT).map(r => (
                <rect
                  key={`h${r.y}-${r.x}`}
                  x={HAT_X + r.x} y={HAT_Y + r.y} width={r.w} height={1}
                  className={r.cell === "k" ? "fm-hatband" : undefined}
                />
              ))}
            </g>
            {(act === "climb" || act === "rope-throw" || act === "rope-catch" || act === "pull-up") && (
              <g className="fm-grip">
                <path className="fm-grip-left" d="M5 9H4V4H7V3H9V5H6V9Z" />
                <path className="fm-grip-right" d="M12 9H14V6H11V5H9V7H12Z" />
              </g>
            )}
            {(act === "land" || act === "dismount") && (
              <g className="fm-crouch-legs">
                <path d="M6 11H8V13H6Z" />
                <path d="M10 11H12V13H10Z" />
              </g>
            )}
            {(["sit", "cast", "fish", "reel", "stow"] as (Act | null)[]).includes(act) && (
              <g className="fm-seated-legs">
                <path className="fm-seated-far" d="M10 10H12V11H11V14H8V13H9V11H10Z" />
                <path d="M6 10H9V11H7V15H4V14H5V11H6Z" />
              </g>
            )}
            {(["left", "right"] as const).map(side => (
              <g key={side} className="fm-leg" data-side={side}>
                {body
                  .filter(r => r.y >= LEG_TOP_ROW)
                  .filter(r => (side === "left" ? r.x < LEG_SPLIT_COL : r.x >= LEG_SPLIT_COL))
                  .map(r => (
                    <rect
                      key={`${side}${r.y}-${r.x}`}
                      x={r.x} y={r.y} width={r.w} height={1}
                      className={CELL_CLASS[r.cell]}
                    />
                  ))}
              </g>
            ))}
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
