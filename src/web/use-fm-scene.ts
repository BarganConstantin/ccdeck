// What Claude FM's character does with itself: where it stands, the errand it
// is on, the dance while the music plays, and holding still while the tab is
// hidden or somebody asked for no motion.
//
// Lifted out of components/ClaudeFm.tsx unchanged. claude-fm.ts decides what
// the errands ARE; this is the clock that walks them and the page it measures
// them against — the scene element (`scene`, which the component renders), the
// canvas floor under it and the Auto-fit chip standing on that floor. The
// component draws whatever this says.
import { useEffect, useRef, useState } from "react";
import {
  ballRollTo, crossSteps, facingFor, nextActivity, nextIdleMs,
  walkMsFor, WALK_MIN_MS, WALK_SPAN_PX,
  type Act, type Facing, type Ground, type Obstacle, type Place, type Prop, type Step,
} from "./claude-fm";
import { BEAT_MS, nextDance, nextDanceMs, type Dance } from "./claude-fm-dance";
import { createSceneTimer } from "./claude-fm-runtime";
import type { Probe } from "./use-fm-player";

/** @param probe what there is to play; the scene runs only while there is some.
 *  @param dead the player said it cannot play here, and the character left.
 *  @param playing the music is on, which is what the dance is for. */
export function useFmScene(probe: Probe | null, dead: boolean, playing: boolean) {
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
  const [suspended, setSuspended] = useState(() => document.hidden);
  useEffect(() => {
    const paused = new Set<Animation>();
    const changed = () => {
      if (document.hidden) {
        for (const animation of scene.current?.getAnimations({ subtree: true }) ?? []) {
          if (animation.playState === "running" || animation.pending) {
            const time = animation.currentTime;
            animation.pause();
            if (time !== null) animation.currentTime = time;
            paused.add(animation);
          }
        }
      } else {
        for (const animation of paused) {
          if (animation.playState === "paused") animation.play();
        }
        paused.clear();
      }
      setSuspended(document.hidden);
    };
    changed();
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [probe, dead]);
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

    const timer = createSceneTimer(document);
    let here = 0;
    setX(now => (here = now));

    /** The step being walked and when it started, which is what a resize
     *  needs in order to re-aim it without moving when it arrives. */
    let current: Step | null = null;
    let startedAt = 0;
    let stepMs = 0;

    /** Walks the list one step at a time. Each step says how the world should
     *  look and how long to hold it there; nothing here decides what the list
     *  is (claude-fm.ts does) and nothing there knows about a clock. */
    const run = (steps: Step[]) => {
      const [step, ...rest] = steps;
      if (!step) { current = null; setAct(null); setProp(null); idle(); return; }
      setAct(step.act);
      setProp(step.prop);
      setPlace(step.place ?? "ledge");
      setRiser(step.riser ?? 0);
      const from = here;
      const to = reachable(step);
      if (step.act === "kick") {
        const ball = scene.current?.querySelector('.fm-prop[data-prop="ball"]')?.getBoundingClientRect();
        if (ball) {
          setBallFlight({
            x: ballRollTo(ball.x, facingFor(step, from, "left"), window.innerWidth),
            drop: Math.max(48, window.innerHeight - ball.y + 24),
          });
        }
      }
      // A walk lasts as long as the ground it actually has to cover. The
      // planned duration was for the floor as it was when the trip was
      // planned, and a step re-aimed at a wider one is a longer walk — held
      // to the planned time it would cross the extra floor by moving faster,
      // and the stride is a fixed cadence that would stop matching it.
      stepMs = step.act === "walk" ? Math.max(walkMsFor(from, to), WALK_MIN_MS) : step.ms;
      if (step.act === "carry") stepMs = walkMsFor(from, to);
      setWalkMs(stepMs);
      setFacing(was => facingFor({ ...step, x: to }, from, was));
      setX(to);
      here = to;
      current = step;
      startedAt = Date.now();
      timer.schedule(() => run(rest), stepMs);
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
     * The step's target, against whatever floor there is NOW.
     *
     * A trip is planned in one go against the floor it measured at the time,
     * and then takes the better part of ten seconds to walk. Change the
     * window in the middle of one and those targets are aimed at a canvas
     * that is no longer there: off the left edge of a narrowed one, where the
     * character would walk out of the deck and come back from nowhere — and
     * stopping short in the middle of a widened one, walking to where the
     * corner used to be and turning round at nothing.
     *
     * So a step that remembers WHICH FRACTION of the floor it was aimed at is
     * aimed again at that fraction of the floor there is now, and the shape
     * of the trip survives a window that changes underneath it.
     *
     * Every other step keeps the pixel it was planned with and is only
     * brought inside the edges. The corner is the reason: the trip goes down
     * and comes back up at the far end of the LEDGE, which is fixed and is
     * the only thing a thrown rope has to catch. Re-aiming that as a
     * proportion of the floor would hang the rope on nothing.
     */
    const reachable = (step: Step): number => {
      const floor = (step.place ?? "ledge") === "floor";
      const room = floor ? floorReach() ?? WALK_SPAN_PX : WALK_SPAN_PX;
      const aim = floor && step.floorFrac != null
        ? -Math.round(step.floorFrac * room)
        : step.x;
      return Math.max(-room, Math.min(0, aim));
    };

    /**
     * THE WINDOW CHANGED WHILE IT WAS WALKING.
     *
     * Re-aiming per step is only as current as the step is long, and these
     * are seconds long — somebody dragging a window edge is doing it in the
     * middle of one, not politely between two. So the step in flight is
     * worked out again and the character carries on to where it should have
     * been going, instead of arriving somewhere the canvas no longer has and
     * being tidied up a walk later.
     *
     * It keeps the step's own arrival: only the destination moves, and the
     * time left on the clock is what it is walked in, so everything scheduled
     * behind it stays where it was. A resize that does not change the
     * destination — which is most of them, since the ledge has a fixed span —
     * is not a re-aim at all.
     *
     * On the scene's parent rather than on `window`, because that box is what
     * `floorReach` measures: a panel that changes without the window doing so
     * is a change to the floor, and a window that changes without moving that
     * box is not.
     */
    const reaim = () => {
      if (!current) return;
      const to = reachable(current);
      if (to === here) return;
      setWalkMs(Math.max(0, startedAt + stepMs - Date.now()));
      // A destination that has moved to the other side of the character is a
      // character now walking backwards, which is the one thing a resize
      // must not be able to make it do.
      setFacing(was => facingFor({ ...current!, x: to }, here, was));
      setX(to);
      here = to;
    };

    const idle = () => {
      timer.schedule(() => {
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
          if (!(st.place === "floor" && st.act === "walk")) return [st];
          const crossing = crossSteps(from, st.x, bar);
          // The crossing's last step is the one that arrives where the walk
          // was aimed, so it is the one that inherits where that was. The
          // steps that climb the obstacle are at the obstacle's own
          // coordinates and belong to it, not to a fraction of the floor.
          const last = crossing.length - 1;
          return st.floorFrac == null
            ? crossing
            : crossing.map((c, i) => i === last ? { ...c, floorFrac: st.floorFrac } : c);
        });
        run(walked);
      }, nextIdleMs(Math.random));
    };

    const host = scene.current?.parentElement;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reaim);
    if (host && ro) ro.observe(host);

    idle();
    return () => {
      timer.dispose();
      ro?.disconnect();
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
    const timer = createSceneTimer(document);
    const pick = (from: Dance | null) => {
      const next = nextDance(from, Math.random);
      setDance(next.dance);
      setBeatMs(next.beatMs);
      timer.schedule(() => pick(next.dance), nextDanceMs(Math.random));
    };
    pick(null);
    return () => timer.dispose();
  }, [playing, reducedMotion]);

  return { scene, suspended, x, walkMs, act, prop, ballFlight, place, facing, riser, dance, beatMs };
}
