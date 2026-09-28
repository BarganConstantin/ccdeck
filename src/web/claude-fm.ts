// Claude FM: what the character does with itself.
//
// Everything here is pure and runs under node, because the parts of this
// feature worth getting wrong are all arithmetic — how far a walk goes, how
// long a fall takes, which dance comes next — and none of them need a DOM to be
// checked. The component next door (components/ClaudeFm.tsx) and its hooks are
// the part that cannot be, and they are deliberately thin. The player
// conversation is claude-fm-player.ts, what the character looks like is
// claude-fm-sprite.ts, and how it dances is claude-fm-dance.ts.

// ── walking the edge ────────────────────────────────────────────────────────
//
// The character stands ON the minimap's top edge rather than floating above it,
// and every so often it walks along that edge to somewhere else on it. That is
// the whole of the behaviour, and the restraint is the design: this is a
// monitoring tool, and something that moved continuously in the corner of it
// would be the thing people turn off first.
//
// So: long stillness, a short slow walk, long stillness. It never leaves the
// edge, never crosses the canvas, and never walks at all while the music is on
// — a character that wanders off mid-track reads as a bug rather than as life.

/** How far along the minimap's edge it can get: the minimap's width less its
 *  own, so it is standing on the edge at both ends rather than hanging off one.
 *
 *  A DEFAULT RATHER THAN A CONSTANT EVERYTHING READS. The ledge is one place
 *  the character can be and its width is known at build time; the canvas floor
 *  is another and its width is whatever the window is today. Every function
 *  below that needed this takes it as an argument now, so the only thing that
 *  has to know which place is being walked is the caller. */
export const WALK_SPAN_PX = 148;

/** Where it is. The ledge is the minimap's top border; the floor is the bottom
 *  of the canvas, which it can only reach by leaving the ledge. */
export type Place = "ledge" | "floor";

/** How long it stands before it thinks about doing something again.
 *
 *  This was 18-40s, chosen when walking was the only thing it did and the worry
 *  was a monitoring deck with something twitching in the corner of it. Now that
 *  there are five things and most of them are worth seeing, forty seconds of
 *  nothing meant a person could watch for a minute and conclude it was a
 *  static image — the restraint had stopped protecting the deck and started
 *  hiding the feature.
 *
 *  6-16s instead: still long enough to be plainly resting between things, short
 *  enough that whatever it does next is worth waiting for. A range rather than
 *  a number, so two decks open side by side do not step in time. */
export const WALK_IDLE_MIN_MS = 6_000;
export const WALK_IDLE_MAX_MS = 16_000;

/** Its pace. Slow on purpose — this is a stroll along a ledge, and anything
 *  quicker pulls the eye away from the canvas, which is what the canvas is
 *  for. */
export const WALK_MS_PER_PX = 46;

/** The shortest trip worth taking. Without a floor the random walk spends most
 *  of its time shuffling a few pixels, which reads as a twitch. */
export const WALK_MIN_STEP_PX = 34;

/**
 * Where it goes next, and how long it takes to get there.
 *
 * `rand` is passed in rather than reached for, so this is a pure function and a
 * test can say exactly where the character ends up.
 */
export function nextWalk(from: number, rand: () => number, span = WALK_SPAN_PX): { to: number; ms: number } {
  // Somewhere on the edge that is not roughly where it already is. Picking a
  // point and then pushing it away from the start keeps the distribution over
  // the whole ledge instead of bunching it at the two ends, which is what
  // clamping a too-short trip would do.
  let to = -Math.round(rand() * span);
  if (Math.abs(to - from) < WALK_MIN_STEP_PX) {
    const away = from - WALK_MIN_STEP_PX >= -span ? -WALK_MIN_STEP_PX : WALK_MIN_STEP_PX;
    to = Math.max(-span, Math.min(0, Math.round(from + away)));
  }
  return { to, ms: Math.round(Math.abs(to - from) * WALK_MS_PER_PX) };
}

/** How long to wait before the next trip. */
export function nextIdleMs(rand: () => number): number {
  return Math.round(WALK_IDLE_MIN_MS + rand() * (WALK_IDLE_MAX_MS - WALK_IDLE_MIN_MS));
}

// ── what it does with itself ────────────────────────────────────────────────
//
// Walking the ledge was the whole of it once, and a character that only ever
// walks is a screensaver. So there are four things it might do when it has
// nothing to listen to, and it picks one each time it gets bored.
//
// This is the part of the feature with no purpose at all, and it is on purpose.
// A deck is watched for hours by somebody waiting on an agent, and what makes a
// corner of a screen worth glancing at is that it is occasionally doing
// something rather than always doing the same thing. Rarely, and slowly.
//
// It does them with the music on as well, which is the opposite of what this
// did first. Holding the errands back while something played made the character
// least alive exactly when it was most looked at — it stood on one spot and
// danced for as long as the track ran. It wears the headphones and gets on with
// its day, and the dance fills the gaps between errands rather than replacing
// them.

export type Act =
  | "walk" | "stoop" | "carry" | "windup" | "toss" | "kick" | "sit" | "watch"
  // Leaving the ledge and getting back onto it.
  | "peer" | "fall" | "land" | "lasso" | "rope-throw" | "rope-catch" | "climb"
  // Getting onto and off something standing on the floor.
  | "mount" | "dismount"
  | "cast" | "fish" | "reel" | "stow" | "stand"
  | "skip-ready" | "skip" | "skip-rest" | "scope-pack" | "pull-up";

/** A thing on the ledge it can do something with. */
export interface Prop {
  kind: "litter" | "ball" | "scope";
  /** Where it is, in the same coordinates the character walks in. */
  at: number;
  /** In hand rather than on the floor — it travels with the character then. */
  held?: boolean;
  /** On its way out: thrown, or rolling off. */
  leaving?: boolean;
}

export interface Step {
  /** A stationary activity may deliberately turn toward its prop. */
  facing?: Facing;
  /** Where the character should be by the end of this step. */
  x: number;
  /** Which surface it is standing on by the end of it. Absent means the ledge,
   *  which is where it is for all but one activity. */
  place?: Place;
  /** How far above that surface it is standing, for the one case where it is
   *  standing on something: a control sitting on the canvas floor. */
  riser?: number;
  /** The prop, or null when there is not one. */
  prop: Prop | null;
  act: Act;
  ms: number;
  /** Where along the floor this step was aimed, as a fraction of it — set only
   *  on the steps whose `x` was DRAWN from the floor's width, and left off
   *  every step aimed at something that is somewhere regardless of how wide the
   *  canvas is. The ledge corner is the one that matters: a rope is thrown at
   *  it, so it has to stay the corner and not a proportion of the floor.
   *
   *  A trip is planned in one go and walked over the better part of ten
   *  seconds. This is what lets the window change in the middle of one: a step
   *  that says "two thirds of the way along" can be put back where it belongs
   *  against the floor that exists when it is walked, where a step that only
   *  remembers a pixel cannot. */
  floorFrac?: number;
}

/** What it might do, and how often. Walking is still most of it: the others are
 *  what make walking worth noticing, and they stop being that if they are the
 *  usual thing. */
export const ACTIVITIES = [
  { kind: "stroll", weight: 44 },
  { kind: "tidy",   weight: 17 },
  { kind: "kick",   weight: 17 },
  { kind: "sit",    weight: 12 },
  { kind: "watch",  weight: 16 },
  // The rarest thing it does, and the longest. Leaving the ledge is worth
  // seeing precisely because it almost never happens.
  { kind: "leave",  weight: 7 },
  { kind: "fish",   weight: 12 },
  { kind: "skip",   weight: 10 },
] as const;

export type Activity = typeof ACTIVITIES[number]["kind"];

export function pickActivity(rand: () => number): Activity {
  const total = ACTIVITIES.reduce((n, a) => n + a.weight, 0);
  let roll = rand() * total;
  for (const a of ACTIVITIES) {
    roll -= a.weight;
    if (roll < 0) return a.kind;
  }
  return "stroll";
}

/** Bending down and standing back up. Long enough to read as deliberate at a
 *  glance from across a room, which is the only way anyone will ever see it. */
export const STOOP_MS = 720;

/** The throw, and the beat before it. It stops, then throws — a character that
 *  arrives and tosses in one motion reads as dropping something. */
export const TOSS_WINDUP_MS = 260;
export const TOSS_MS = 620;

/** The kick, and its own wind-up. Shorter than the throw's: a kick is the
 *  quicker motion of the two and a long one reads as hesitation. */
export const KICK_WINDUP_MS = 220;

/** THE STEP HAS TO OUTLAST THE ANIMATION IT STARTS. The ball rolls for 520ms
 *  and this step used to end at 480, so the prop was unmounted forty
 *  milliseconds before it landed and the ball vanished in mid-flight. `stoop`
 *  and `toss` already matched their own animations exactly; this one had
 *  drifted, and nothing pointed at it because each number looked reasonable
 *  alone. The test now reads both sides. */
export const KICK_MS = 520;
export const BALL_FLIGHT_MS = 1600;

/** How long it stands there looking at the board through the scope. Long, like
 *  sitting — this is the one activity that is ABOUT the deck rather than about
 *  the ledge, and it only reads as looking at something if it lasts longer than
 *  a glance. */
export const WATCH_MIN_MS = 7_000;
export const WATCH_MAX_MS = 15_000;

/** How long it sits there. The longest thing it does by some way, because that
 *  is what sitting is — and because a rest beat is what stops the other three
 *  from running into each other. */
export const SIT_MIN_MS = 6_000;
export const SIT_MAX_MS = 14_000;

/** Where a prop turns up. Never so close that the errand is over before it
 *  starts, and always somewhere on the ledge. */
export function propSpot(from: number, rand: () => number, span = WALK_SPAN_PX): number {
  let at = -Math.round(rand() * span);
  if (Math.abs(at - from) < WALK_MIN_STEP_PX) {
    const away = from - WALK_MIN_STEP_PX >= -span ? -WALK_MIN_STEP_PX : WALK_MIN_STEP_PX;
    at = Math.max(-span, Math.min(0, Math.round(from + away)));
  }
  return at;
}

/** How long it takes to walk a given distance, at the pace the stroll uses. */
export const walkMsFor = (from: number, to: number) =>
  Math.round(Math.abs(to - from) * WALK_MS_PER_PX);

/** The shortest a walk is ever held for. A walk re-aimed at a floor that has
 *  just been narrowed to almost nothing can end up with no ground left to
 *  cover, and a step of no duration chains the whole rest of the plan through
 *  in a single frame. This is the floor under that: long enough to be a beat
 *  somebody could see, short enough never to read as standing still. */
export const WALK_MIN_MS = 120;

/** The bin is the right-hand end of the ledge — the corner it starts at, and
 *  the one spot on the minimap's edge nothing else is ever standing on. */
export const BIN_X = 0;

/**
 * The errand, as a list of steps.
 *
 * Written out rather than scattered through nested timeouts so the whole shape
 * of it can be read in one place and checked without a clock: each step says
 * how the world should look and how long to hold it there. The component walks
 * the list; this decides what the list is.
 */
export function tidySteps(from: number, at: number): Step[] {
  const it = (p: Partial<Prop>): Prop => ({ kind: "litter", at, ...p });
  return [
    { x: at,    prop: it({}),                          act: "walk",   ms: walkMsFor(from, at) },
    { x: at,    prop: it({}),                          act: "stoop",  ms: STOOP_MS },
    { x: BIN_X, prop: it({ held: true }),              act: "carry",  ms: walkMsFor(at, BIN_X) },
    { x: BIN_X, prop: it({ held: true }),              act: "windup", ms: TOSS_WINDUP_MS },
    { x: BIN_X, prop: it({ held: true, leaving: true }), act: "toss", ms: TOSS_MS },
  ];
}

/**
 * The ball, which is the same errand with the opposite ending: it walks up to
 * the thing, and instead of tidying it away it sends it down the ledge.
 *
 * The ball stays on the floor the whole time — it is never held — which is the
 * one structural difference and the reason both fit one prop shape.
 */
export function kickSteps(from: number, at: number): Step[] {
  // Stop one foot short: the ball must be beside the foot, not under the torso.
  const direction = at > from ? 1 : -1;
  const approach = at - direction * Math.min(15, Math.abs(at - from));
  const ball = (p: Partial<Prop> = {}): Prop => ({ kind: "ball", at, ...p });
  return [
    { x: approach, prop: ball(), act: "walk", ms: walkMsFor(from, approach) },
    { x: approach, prop: ball(), act: "windup", ms: KICK_WINDUP_MS, facing: direction > 0 ? "right" : "left" },
    { x: approach, prop: ball({ leaving: true }), act: "kick", ms: KICK_MS, facing: direction > 0 ? "right" : "left" },
    { x: approach, prop: ball({ leaving: true }), act: "stand", ms: BALL_FLIGHT_MS - KICK_MS },
  ];
}

export const SKIP_BEAT_MS = 640;

/** Sit, lower the line over the minimap, wait for a bite, then pack it away
 * before standing. The final walk makes the return to the scene explicit. */
export function fishSteps(from: number, at: number, rand: () => number): Step[] {
  // Leave room on the left for the rod, line and float, within the minimap.
  const spot = Math.max(-70, Math.min(-20, at));
  const pose = { x: spot, prop: null, facing: "left" as const };
  return [
    { x: spot, prop: null, act: "walk", ms: walkMsFor(from, spot) },
    { ...pose, act: "sit", ms: 600 },
    { ...pose, act: "cast", ms: 900 },
    { ...pose, act: "fish", ms: 6000 + Math.round(rand() * 4000) },
    { ...pose, act: "reel", ms: 1200 },
    { ...pose, act: "stow", ms: 500 },
    { ...pose, act: "stand", ms: 400 },
    { x: 0, prop: null, act: "walk", ms: walkMsFor(spot, 0) },
  ];
}

/** Whole rope revolutions end with both feet on the ledge. */
export function skipSteps(from: number, at: number, rand: () => number): Step[] {
  const spot = Math.max(-110, Math.min(-30, at));
  const pose = { x: spot, prop: null };
  return [
    { ...pose, act: "walk", ms: walkMsFor(from, spot) },
    { ...pose, act: "skip-ready", ms: 500 },
    { ...pose, act: "skip", ms: SKIP_BEAT_MS * (6 + Math.floor(rand() * 5)) },
    { ...pose, act: "skip-rest", ms: 600 },
    { ...pose, act: "stand", ms: 350 },
    { x: 0, prop: null, act: "walk", ms: walkMsFor(spot, 0) },
  ];
}

/** Sitting down on the edge for a while. It walks somewhere first, because
 *  sitting down on the spot it is already standing on reads as falling over. */
export function sitSteps(from: number, at: number, rand: () => number): Step[] {
  return [
    { x: at, prop: null, act: "walk", ms: walkMsFor(from, at) },
    { x: at, prop: null, act: "sit",  ms: Math.round(SIT_MIN_MS + rand() * (SIT_MAX_MS - SIT_MIN_MS)) },
    { x: at, prop: null, act: "stand", ms: 400 },
  ];
}

/**
 * It takes out a scope and looks at the board.
 *
 * The only thing it does that is about the canvas rather than about the ledge
 * it is standing on: it turns away from the minimap, points the thing at the
 * sessions, and watches them for a while. Nothing is read and nothing is
 * reported — it is not a feature wearing a character, it is a character that
 * has noticed there is something to look at.
 */
export function watchSteps(from: number, at: number, rand: () => number): Step[] {
  // The tripod needs a patch of ledge to the character's left.
  at = Math.max(-110, Math.min(0, at));
  const scope = (): Prop => ({ kind: "scope", at, held: true });
  return [
    { x: at, prop: null,    act: "walk",  ms: walkMsFor(from, at) },
    { x: at, prop: scope(), act: "watch", ms: Math.round(WATCH_MIN_MS + rand() * (WATCH_MAX_MS - WATCH_MIN_MS)) },
    { x: at, prop: scope(), act: "scope-pack", ms: 480 },
    { x: at, prop: null, act: "stand", ms: 240 },
  ];
}

/**
 * The acts during which it is looking AT SOMETHING, and its eyes narrow for
 * these and only these.
 *
 * Each one is the character attending to an object: the litter it is bending
 * for, the ball it is about to send down the ledge, and whatever it is aiming
 * the scope at. Walking is not among them — it walks with its eyes open.
 *
 * An earlier build also shifted the eyes a column to say which way it was
 * travelling, on the argument that a symmetric sprite moving sideways reads as
 * sliding. That is gone, and the reason it had to go is the same reason the
 * narrowing was worth having: the shift was on at every single moment, so the
 * eyes were never simply open, and a face that is always doing something has no
 * expression left to spend. There is nothing left to say direction with, and
 * nothing that needs saying — the walk cycle already says it is walking.
 */
export type Facing = "left" | "right";

/**
 * Which way it is looking.
 *
 * TWO DIFFERENT THINGS HAPPEN TO THESE EYES and they were briefly confused for
 * each other. NARROWING says it is looking at an object, and belongs to the
 * four acts below. SHIFTING says which way it is travelling, and belongs to
 * everything — without it a symmetric sprite walking left looks exactly like
 * the same sprite walking right, which reads as the character going backwards.
 * The first build did both at once and the second removed both; they are
 * separate, and this is the one that has to be on whenever it is moving.
 *
 * `x` runs from 0 at the right-hand end of the ledge to -span at the left, so a
 * smaller number is further left. Standing still keeps whatever it had: it does
 * not spin round to face the viewer every time it stops.
 *
 * WHICH IS NOT THE SAME AS SHOWING IT. The facing is remembered whatever it is
 * doing, and the eyes only move while it is actually travelling — a character
 * parked on the ledge staring off to one side looks like it is avoiding your
 * eye. Standing still, they sit where they are drawn.
 */
export const MOVING_ACTS: readonly Act[] = ["walk", "carry"];

export const isMoving = (act: Act | null): boolean =>
  act != null && MOVING_ACTS.includes(act);

export function facingFor(step: Step, from: number, prev: Facing): Facing {
  if (step.facing) return step.facing;
  // Looking at the board, which is everything to the left of the minimap.
  if (step.act === "watch" || step.act === "scope-pack") return "left";
  if (step.x === from) return prev;
  return step.x > from ? "right" : "left";
}

export const FOCUS_ACTS: readonly Act[] = ["stoop", "windup", "kick", "watch"];

export const isFocused = (act: Act | null): boolean =>
  act != null && FOCUS_ACTS.includes(act);


// ── leaving the ledge ───────────────────────────────────────────────────────
//
// The one activity that is not on the minimap's edge at all. It walks to the
// far end, looks over, drops onto the canvas floor, walks about down there, and
// ropes its way back up.
//
// EVERYTHING HERE IS DERIVED RATHER THAN PICKED, because a fall that is merely
// a duration reads as a slide. The drop is timed from an acceleration and the
// height it is actually falling, so a minimap of a different size falls for a
// different length of time on its own; the climb is timed from a speed, because
// climbing a rope is work at a steady rate and not the fall run backwards.

/** Gravity, in canvas pixels per second squared. Chosen by what it produces:
 *  over this deck's 152px ledge it gives a 450ms drop, which is a fall with
 *  weight in it rather than a float or a teleport. */
export const FALL_G = 1500;

/** How long a drop of `height` takes under it. The `t = sqrt(2h/g)` every
 *  falling body obeys, which is what makes the motion read as a fall at any
 *  height rather than only at the one it was tuned on. */
export const fallMsFor = (height: number) => Math.round(1000 * Math.sqrt((2 * height) / FALL_G));

/** Going up is not the fall backwards. A rope is climbed at a steady rate, so
 *  this is a speed rather than an acceleration — and a slow one, because the
 *  effort is the point. */
export const CLIMB_PX_PER_S = 115;
export const climbMsFor = (height: number) => Math.round((height / CLIMB_PX_PER_S) * 1000);

/** Looking over the edge before stepping off it. Nothing sensible jumps from a
 *  height it has not looked at. */
export const PEER_MS = 620;

/** The landing. Long enough for the squash to be seen and short enough that it
 *  is a landing rather than a stumble. */
export const LAND_MS = 200;

/** Swinging the rope before it is thrown. */
export const LASSO_MS = 760;
export const ROPE_THROW_MS = 600;
export const ROPE_CATCH_MS = 240;

/**
 * The trip off the ledge and back.
 *
 * `ledgeH` is how far it has to fall, and `floorSpan` how far it can walk once
 * it is down — both measured from the page rather than assumed, because the
 * minimap is a fixed size and the canvas is whatever the window is today.
 *
 * It comes back up where it went down. That is not a shortcut: a rope thrown at
 * the ledge has to catch something, and the only part of the ledge this
 * character has any business hooking is the corner it just left.
 */
export function leaveLedgeSteps(
  from: number,
  opts: { ledgeH: number; floorSpan: number; ledgeSpan?: number },
  rand: () => number,
): Step[] {
  const ledgeSpan = opts.ledgeSpan ?? WALK_SPAN_PX;
  // The far end of the ledge, which is the only corner with canvas under it
  // rather than more minimap.
  const edge = -ledgeSpan;
  const fall = fallMsFor(opts.ledgeH);
  const climb = climbMsFor(opts.ledgeH);

  // Two wanders down there, so the trip is worth having taken. Kept as the
  // fractions they were drawn as and not only as the pixels those came out to:
  // the floor is whatever the window is today, and the window is allowed to
  // change while the character is down there walking it.
  const firstFrac = rand();
  const secondFrac = rand();
  const first = -Math.round(firstFrac * opts.floorSpan);
  const second = -Math.round(secondFrac * opts.floorSpan);

  return [
    { x: edge,   act: "walk",  prop: null, ms: walkMsFor(from, edge) },
    { x: edge,   act: "peer",  prop: null, ms: PEER_MS },
    { x: edge,   act: "fall",  prop: null, ms: fall,  place: "floor" },
    { x: edge,   act: "land",  prop: null, ms: LAND_MS, place: "floor" },
    { x: first,  act: "walk",  prop: null, ms: walkMsFor(edge, first),   place: "floor",
      floorFrac: firstFrac },
    { x: second, act: "walk",  prop: null, ms: walkMsFor(first, second), place: "floor",
      floorFrac: secondFrac },
    { x: edge,   act: "walk",  prop: null, ms: walkMsFor(second, edge),  place: "floor" },
    { x: edge,   act: "lasso", prop: null, ms: LASSO_MS, place: "floor" },
    { x: edge,   act: "rope-throw", prop: null, ms: ROPE_THROW_MS, place: "floor" },
    { x: edge,   act: "rope-catch", prop: null, ms: ROPE_CATCH_MS, place: "floor" },
    { x: edge,   act: "climb", prop: null, ms: climb },
    { x: edge,   act: "pull-up", prop: null, ms: 480 },
  ];
}

/** The whole decision, in one place: what it does next and where. */
/** What the page has to tell the model before it can plan a trip: how far there
 *  is to fall, and how much floor there is once it lands. Neither is knowable
 *  here — the minimap is a fixed size but the canvas is whatever the window is
 *  today, and both change on a resize. */
export interface Ground {
  ledgeH: number;
  floorSpan: number;
  ledgeSpan?: number;
}

export function nextActivity(from: number, rand: () => number, ground?: Ground): Step[] {
  const span = ground?.ledgeSpan ?? WALK_SPAN_PX;
  const kind = pickActivity(rand);
  switch (kind) {
    case "tidy": return tidySteps(from, propSpot(from, rand, span));
    case "kick": return kickSteps(from, propSpot(from, rand, span));
    case "sit":   return sitSteps(from, propSpot(from, rand, span), rand);
    case "watch": return watchSteps(from, propSpot(from, rand, span), rand);
    case "fish": return fishSteps(from, propSpot(from, rand, span), rand);
    case "skip": return skipSteps(from, propSpot(from, rand, span), rand);
    case "leave": {
      // WITHOUT THE GROUND IT DOES NOT GO. A trip planned against a guessed
      // height would drop the character through the floor or leave it hanging
      // in the air, and there is no sensible default for "how tall is the thing
      // I am standing on" — so it strolls instead and tries again later.
      if (!ground || !(ground.ledgeH > 0) || !(ground.floorSpan > 0)) break;
      return leaveLedgeSteps(from, ground, rand);
    }
  }
  const trip = nextWalk(from, rand, span);
  return [{ x: trip.to, prop: null, act: "walk", ms: trip.ms }];
}

// ── things standing on the floor ────────────────────────────────────────────

/** Something in the way, in the character's own coordinates. `left` and `right`
 *  are both negative distances from the scene's right edge, with `left` the
 *  smaller of the two. */
export interface Obstacle { left: number; right: number; height: number }

/** How far a kicked ball travels before it is gone. The sign is the facing's;
 *  this is only the distance. */
export const BALL_ROLL_PX = 420;

export function ballRollTo(at: number, facing: Facing, viewportWidth: number): number {
  const room = facing === "right" ? viewportWidth - at - 18 : at - 18;
  return (facing === "right" ? 1 : -1) * Math.min(BALL_ROLL_PX, Math.max(0, room));
}

/** How long it takes to get up onto something, and down off it again. Short:
 *  these are a step, not a climb — the thing being stepped onto is ankle high
 *  next to the ledge it throws a rope at. */
export const MOUNT_MS = 260;
export const DISMOUNT_MS = 200;

/**
 * A walk from `from` to `to`, going OVER anything in the way rather than
 * through it.
 *
 * The deck's controls sit on the canvas floor and the character walks along it,
 * so without this it strolls straight through the Auto-fit chip as though the
 * chip were a picture of a chip. Going over it is the only reading that makes
 * the two objects share a world.
 *
 * Nothing is assumed about the obstacle being there: it is measured from the
 * page at the moment a walk is planned, and a walk that does not reach it — or
 * a page where it does not exist — is a plain walk with no extra steps at all.
 */
export function crossSteps(from: number, to: number, over: Obstacle | null): Step[] {
  const plain = (x: number, ms = walkMsFor(from, x)): Step =>
    ({ x, prop: null, act: "walk", ms, place: "floor" });

  if (!over || over.height <= 0) return [plain(to)];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  // Entirely one side of it, or entirely past it: nothing to climb.
  if (hi <= over.left || lo >= over.right) return [plain(to)];

  const goingRight = to > from;
  const near = goingRight ? over.left : over.right;
  const far = goingRight ? over.right : over.left;
  const on = { place: "floor" as const, riser: over.height, prop: null };

  return [
    plain(near, walkMsFor(from, near)),
    { ...on, x: near, act: "mount", ms: MOUNT_MS },
    { ...on, x: far, act: "walk", ms: walkMsFor(near, far) },
    { x: far, prop: null, act: "dismount", ms: DISMOUNT_MS, place: "floor" },
    { x: to, prop: null, act: "walk", ms: walkMsFor(far, to), place: "floor" },
  ];
}
