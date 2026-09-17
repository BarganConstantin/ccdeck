// Claude FM: the embed, the player conversation, and the sprite's geometry.
//
// Everything here is pure and runs under node, because the parts of this
// feature worth getting wrong are all arithmetic and string-building — what URL
// the iframe gets, what a player message means, how long to duck for — and none
// of them need a DOM to be checked. The component next door (components/
// ClaudeFm.tsx) is the part that cannot be, and it is deliberately thin.
//
// WHAT PLAYS is decided by the server (src/server/claude-fm.mjs): it asks
// whether the Claude channel is broadcasting and hands back the channel id. No
// video id crosses this file. See that module's header for why a channel id is
// the only durable handle a stream has.

/** The player's origin. `youtube-nocookie.com` rather than `youtube.com`: it is
 *  the same player and the same stream, and it sets no tracking cookie until
 *  something is actually played. A local tool that reaches Google at all should
 *  reach the quieter of the two doors. */
export const PLAYER_ORIGIN = "https://www.youtube-nocookie.com";

/**
 * The iframe's src.
 *
 * `/embed/live_stream?channel=…` is YouTube's own answer to "play whatever this
 * channel is broadcasting right now" — it resolves the current broadcast each
 * time it loads, so a stream that ends and restarts under a new video id keeps
 * working with nothing shipped. It is the oldest corner of the embed API and
 * not in the current docs, which is a real risk and the reason the component
 * treats a player error as "this cannot play here" and removes itself.
 *
 * `autoplay=1` is honest rather than sneaky: this iframe is only ever created
 * inside the click that asked for music, so the document already carries user
 * activation and the browser allows the sound it was asked for. Nothing mounts
 * on page load — see the component.
 *
 * `origin` is the page's, which is what the JS API asks for so the player can
 * check who is talking to it.
 */
export function embedSrc(channel: string, origin: string): string {
  const q = new URLSearchParams({
    channel,
    enablejsapi: "1",
    autoplay: "1",
    playsinline: "1",
    // No related-video rail and no branding on a player nobody can see anyway;
    // both only matter if the frame is ever made visible.
    rel: "0",
    modestbranding: "1",
    origin,
  });
  return `${PLAYER_ORIGIN}/embed/live_stream?${q.toString()}`;
}

/** One command for the player's postMessage API. */
export function command(func: string, args: readonly unknown[] = []): string {
  return JSON.stringify({ event: "command", func, args });
}

/** The handshake that makes the player talk back. Without this it accepts
 *  commands and reports nothing, so there is no way to learn that it failed —
 *  which is the one thing this feature has to learn. */
export function listenCommand(id = "claude-fm"): string {
  return JSON.stringify({ event: "listening", id, channel: "widget" });
}

/** What the player says back. Everything else it sends is ignored. */
export type FmSignal =
  | { kind: "ready" }
  | { kind: "playing"; playing: boolean }
  | { kind: "error"; code: number };

/** The player's own state numbers. 1 is playing and 3 is buffering; both are
 *  "the user asked for sound and sound is coming", which is what the sprite
 *  dances to. -1, 0, 2 and 5 are not. */
export const PLAYING_STATES: readonly number[] = [1, 3];

/**
 * Every error the player can raise means the same thing here.
 *
 * 2 is a malformed parameter, 5 an HTML5 playback failure, 100 a video that is
 * gone, and 101 and 150 are the two spellings of "the owner does not allow this
 * to be embedded". A music toy has nothing useful to say about any of them and
 * no second thing to try, so the component's answer to all five is to take the
 * control off the canvas. A control that presses and does nothing is worse than
 * no control.
 */
export const FATAL_ERRORS: readonly number[] = [2, 5, 100, 101, 150];

/**
 * Reads one `message` payload.
 *
 * The player posts JSON as a string, and the page receives messages from
 * everything else on it too, so this returns null for anything it does not
 * recognise rather than throwing. The caller checks the origin; this checks the
 * shape.
 */
export function readSignal(raw: unknown): FmSignal | null {
  let msg: unknown = raw;
  if (typeof raw === "string") {
    try { msg = JSON.parse(raw); } catch { return null; }
  }
  if (!msg || typeof msg !== "object") return null;
  const { event, info } = msg as { event?: unknown; info?: unknown };
  if (event === "onReady") return { kind: "ready" };
  if (event === "onError") {
    const code = typeof info === "number" ? info : Number((info as { errorCode?: unknown })?.errorCode);
    return Number.isFinite(code) ? { kind: "error", code } : null;
  }
  // TWO SPELLINGS, AND THE DOCUMENTED ONE IS NOT THE ONE THAT ARRIVES. The API
  // reference describes `onStateChange` with the state as a bare number, and
  // that is what the first build read. Watching the actual wire on a real deck:
  // seven messages from the player and not one `onStateChange` — the live
  // player reports state inside `infoDelivery`, as `info.playerState`, mixed in
  // with volume, quality and timing. Reading only the documented spelling meant
  // the component never learned anything the player said about playback and
  // could only ever show what it had optimistically assumed.
  if (event === "onStateChange" || event === "infoDelivery") {
    const state = typeof info === "number" ? info : (info as { playerState?: unknown })?.playerState;
    // `infoDelivery` carries plenty of messages with no state in them at all —
    // a volume change, a quality change — and those are not a report that the
    // music stopped.
    if (typeof state !== "number" || !Number.isFinite(state)) return null;
    return { kind: "playing", playing: PLAYING_STATES.includes(state) };
  }
  return null;
}

/** Full volume, and the volume the music drops to while the deck is making a
 *  sound of its own. Not mute: the music going silent and coming back is more
 *  noticeable than the music getting quieter, and the point of ducking is to
 *  make the chime audible, not to interrupt the track. */
export const FULL_VOLUME = 100;
export const DUCK_VOLUME = 18;

/** The tail added to a chime's own length before the music comes back up.
 *  A chime ends on a 12ms release into a room, and restoring the instant the
 *  last oscillator stops steps on it. */
export const DUCK_TAIL_MS = 260;

/**
 * How long to hold the music down for one chime.
 *
 * Derived from the figure that is about to play rather than a constant, because
 * the sound menu lets a user pick figures of quite different lengths and a
 * fixed number would either clip the long ones or leave the music quiet after
 * the short ones. Takes the notes' own schedule — `at` is an offset in seconds
 * from the start and `ms` the note's length — and finds the last moment any of
 * them is still sounding.
 */
export function duckMsFor(notes: readonly { at: number; ms: number }[]): number {
  const end = notes.reduce((last, n) => Math.max(last, n.at * 1000 + n.ms), 0);
  return Math.round(end) + DUCK_TAIL_MS;
}

/**
 * The character.
 *
 * An original creature, drawn as a grid here rather than shipped as an image: a
 * PNG would be a binary asset in a repo that has none, would need a second one
 * for the light theme, and would be a fixed size on a canvas that zooms.
 * Eighteen columns of text cost nothing, recolour with the palette and stay
 * crisp at any scale — and if this ever becomes the mark on the tin, the mark
 * is eighteen lines of text that anyone can edit.
 *
 * The proportions are the second pass. The first put the headphones a column
 * clear of the head, which at 44px read as three separate objects floating
 * near each other rather than as one character wearing something. The cups
 * touch the head now, the band arcs down to meet them over three rows instead
 * of two, and the whole thing is drawn on 18 columns rather than 16 so the legs
 * have somewhere to be.
 *
 * The arms are the fourth pass, and they cost two rows rather than two
 * columns: the ear cups run down both sides of the head, so there is nowhere
 * for an arm to come out until below them. The cups end a row earlier than they
 * did and the two rows under them are wide — which also gives the silhouette a
 * waist it did not have, since the body narrows again below the arms.
 *
 * The detail is the third pass, and all of it is one column wide. A flat fill
 * reads as a shape rather than as a body, so the right-hand column of every
 * body row is a shade — one light source, from the left, consistently — and
 * each cup has a lighter pad inside it so it reads as something worn rather
 * than as a grey block. Two cells of extra vocabulary; the silhouette is
 * unchanged.
 *
 *   `.` nothing   `b` body   `s` body in shadow   `e` eye
 *   `c` headphone cup   `p` ear pad   `a` headband
 */
export const SPRITE: readonly string[] = [
  "......aaaaaa......",
  "....aa......aa....",
  "...a..bbbbbs..a...",
  "...cpcbbbbbscpc...",
  "...cpcbebbescpc...",
  "...cpcbbbbbscpc...",
  "...cpcbbbbbscpc...",
  "....ccbbbbbscc....",
  "....bbbbbbbbbs....",
  "....bbbbbbbbbs....",
  "......bbbbbs......",
  "......bb..bs......",
  "......bb..bs......",
];

export const SPRITE_W = 18;
export const SPRITE_H = SPRITE.length;

/** Which grid cells are holes rather than body. */
export const EYE_CELLS: ReadonlySet<string> = new Set(["e"]);
/** Which belong to the headphones, which follow the body rather than moving
 *  with it. The pad travels with the cup it is inside. */
export const GEAR_CELLS: ReadonlySet<string> = new Set(["a", "c", "p"]);

export interface SpriteRect { x: number; y: number; w: number; cell: string }

/**
 * The grid as rectangles, one per horizontal run.
 *
 * A rect per filled square would be over a hundred elements for this sprite and
 * every one of them a node the browser lays out; merging runs brings it to
 * about a third of that with identical pixels. The merge stops at a change of
 * cell, so a run never spans two colours.
 */
export function spriteRects(grid: readonly string[] = SPRITE): SpriteRect[] {
  const out: SpriteRect[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x];
      if (cell === ".") { x += 1; continue; }
      let w = 1;
      while (x + w < row.length && row[x + w] === cell) w += 1;
      out.push({ x, y, w, cell });
      x += w;
    }
  });
  return out;
}

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

/** How far along the edge it can get: the minimap's width less its own, so it
 *  is standing on the edge at both ends rather than hanging off one. */
export const WALK_SPAN_PX = 148;

/** How long it stands before it thinks about moving again. A range rather than
 *  a number, so two decks open side by side do not step in time. */
export const WALK_IDLE_MIN_MS = 18_000;
export const WALK_IDLE_MAX_MS = 40_000;

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
export function nextWalk(from: number, rand: () => number): { to: number; ms: number } {
  const span = WALK_SPAN_PX;
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
// something rather than always doing the same thing. Rarely, slowly, and never
// while the music is on — it has somewhere to be then.

export type Act = "walk" | "stoop" | "carry" | "windup" | "toss" | "kick" | "sit" | "watch";

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
  /** Where the character should be by the end of this step. */
  x: number;
  /** The prop, or null when there is not one. */
  prop: Prop | null;
  act: Act;
  ms: number;
}

/** What it might do, and how often. Walking is still most of it: the others are
 *  what make walking worth noticing, and they stop being that if they are the
 *  usual thing. */
export const ACTIVITIES = [
  { kind: "stroll", weight: 38 },
  { kind: "tidy",   weight: 17 },
  { kind: "kick",   weight: 17 },
  { kind: "sit",    weight: 12 },
  { kind: "watch",  weight: 16 },
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
export const KICK_MS = 480;

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
export function propSpot(from: number, rand: () => number): number {
  const span = WALK_SPAN_PX;
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
  const ball = (p: Partial<Prop> = {}): Prop => ({ kind: "ball", at, ...p });
  return [
    { x: at, prop: ball(),                 act: "walk",   ms: walkMsFor(from, at) },
    { x: at, prop: ball(),                 act: "windup", ms: KICK_WINDUP_MS },
    { x: at, prop: ball({ leaving: true }), act: "kick",  ms: KICK_MS },
  ];
}

/** Sitting down on the edge for a while. It walks somewhere first, because
 *  sitting down on the spot it is already standing on reads as falling over. */
export function sitSteps(from: number, at: number, rand: () => number): Step[] {
  return [
    { x: at, prop: null, act: "walk", ms: walkMsFor(from, at) },
    { x: at, prop: null, act: "sit",  ms: Math.round(SIT_MIN_MS + rand() * (SIT_MAX_MS - SIT_MIN_MS)) },
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
  const scope = (): Prop => ({ kind: "scope", at, held: true });
  return [
    { x: at, prop: null,    act: "walk",  ms: walkMsFor(from, at) },
    { x: at, prop: scope(), act: "watch", ms: Math.round(WATCH_MIN_MS + rand() * (WATCH_MAX_MS - WATCH_MIN_MS)) },
  ];
}

/** The whole decision, in one place: what it does next and where. */
export function nextActivity(from: number, rand: () => number): Step[] {
  switch (pickActivity(rand)) {
    case "tidy": return tidySteps(from, propSpot(from, rand));
    case "kick": return kickSteps(from, propSpot(from, rand));
    case "sit":   return sitSteps(from, propSpot(from, rand), rand);
    case "watch": return watchSteps(from, propSpot(from, rand), rand);
    default: {
      const trip = nextWalk(from, rand);
      return [{ x: trip.to, prop: null, act: "walk", ms: trip.ms }];
    }
  }
}

/**
 * The props. Deliberately not recognisable objects — a character tidying away
 * an identifiable thing invites the question of what it was, and the answer is
 * nothing. One is crumpled, one is round.
 */
export const LITTER: readonly string[] = [
  ".xx.",
  "xxxx",
  ".xx.",
];
export const BALL: readonly string[] = [
  ".xx.",
  "xxxx",
  "xxxx",
  ".xx.",
];

/** The scope: narrow at the eye, wide at the far end, which is the whole of
 *  what makes five pixels read as a telescope rather than as a stick. */
export const SCOPE: readonly string[] = [
  "..xxx",
  "xxxxx",
  "..xxx",
];

export const PROP_ART: Record<Prop["kind"], readonly string[]> =
  { litter: LITTER, ball: BALL, scope: SCOPE };

// ── the dance is not one loop ───────────────────────────────────────────────
//
// One cycle repeated forever reads as a GIF rather than as a character: the eye
// learns an 800ms loop in about four seconds and then stops looking. So there
// are three of them and it changes its mind every ten seconds or so, and the
// tempo drifts a few percent each time it does.
//
// Nothing here listens to the music, and nothing can: the player is a
// cross-origin iframe, so the page cannot reach the audio element, and a
// tainted source would hand an analyser silence anyway. The only route to real
// beat detection is tab capture, which costs a permission prompt and a sharing
// banner — far too much for a character in a corner. This is the honest
// alternative: it is not dancing TO the track, it is just not dancing the same
// way twice in a row.

export const DANCES = ["bob", "sway", "groove"] as const;
export type Dance = typeof DANCES[number];

/** How long it keeps one dance before picking another. Long enough that the
 *  change is noticed rather than watched for. */
export const DANCE_MIN_MS = 9_000;
export const DANCE_MAX_MS = 16_000;

/** The tempo, and how far either side of it a dance may land. 800ms is 75bpm,
 *  which is about where the thing it is dancing to usually sits; the drift is
 *  small enough to stay in that band and large enough that two dances in a row
 *  are not the same speed. */
export const BEAT_MS = 800;
export const BEAT_DRIFT = 0.08;

/**
 * The next dance, which is never the one it is already doing.
 *
 * The names are the sheet's `data-dance` values rather than keyframe names on
 * purpose. Driving `animation-name` through a custom property was one rule
 * instead of three and hid every dance from bubble-motion.test.ts, which exists
 * to catch exactly that: a @keyframes set the sheet no longer runs, and an
 * animation naming a set that is not there. A stylesheet its own guards cannot
 * read is not a saving.
 *
 * Picking uniformly at random would repeat about a third of the time, and a
 * repeat is indistinguishable from the loop this exists to break — the change
 * has to be visible or it has not happened.
 */
export function nextDance(current: Dance | null, rand: () => number): { dance: Dance; beatMs: number } {
  const others = DANCES.filter(d => d !== current);
  const dance = others[Math.min(others.length - 1, Math.floor(rand() * others.length))];
  const drift = (rand() * 2 - 1) * BEAT_DRIFT;
  return { dance, beatMs: Math.round(BEAT_MS * (1 + drift)) };
}

/** How long to hold it. */
export function nextDanceMs(rand: () => number): number {
  return Math.round(DANCE_MIN_MS + rand() * (DANCE_MAX_MS - DANCE_MIN_MS));
}
