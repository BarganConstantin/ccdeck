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
  memo, useCallback, useEffect, useRef, useState,
  type CSSProperties,
} from "react";
// Type only: the library itself is imported on demand, in startDirect.
import type Hls from "hls.js";
import {
  command, embedSrc, FATAL_ERRORS, GEAR_CELLS,
  listenCommand, nextActivity, nextIdleMs, PLAYER_ORIGIN, PROP_ART, readSignal,
  spriteRects, SPRITE_H, SPRITE_W,
  ballRollTo, BALL_FLIGHT_MS, BEAT_MS, crossSteps, DANCES, facingFor, HAT, HAT_X, HAT_Y, SKIP_BEAT_MS,
  BALL_ROLL_PX, LEG_SPLIT_COL, LEG_TOP_ROW, walkMsFor, WALK_MIN_MS, WALK_SPAN_PX,
  nextDance, nextDanceMs,
  type Act, type Dance, type Facing, type Ground, type Obstacle, type Place,
  type Prop, type Step,
} from "../claude-fm";
import { createSceneTimer } from "../claude-fm-runtime";
import type { FmSource } from "../appearance";
import {
  customFmId, customFmSelection, parseFmStationUrl,
  type CustomFmStation, type FmSelection,
} from "../fm-stations";

interface Probe { live: boolean; channel: string; video?: string; audio?: string; hls?: boolean }

const SOURCE_LABEL: Record<FmSource, string> = {
  "claude-fm": "Claude FM",
  "lofi-relax": "Lofi Girl relax/study",
  "lofi-game": "Lofi Girl chill/game",
  "lofi-vibe": "Lofi Girl vibe/chill",
  "lofi-sleep": "Lofi Girl sleep/chill",
  "radio-mix": "Radio Mix Live",
  "best-of-nostalgia": "Best of Nostalgia Live",
  "good-life-radio": "The Good Life Radio Live",
  "cafe-music-bgm": "Cafe Music BGM Live",
};

function sourceLabel(source: FmSelection, customStation?: CustomFmStation): string {
  if (customStation && customFmSelection(customStation.id) === source) return customStation.name;
  if (customFmId(source)) return "Custom FM";
  return SOURCE_LABEL[source as FmSource];
}

const LIVE_ENDPOINT: Record<FmSource, string | null> = {
  "claude-fm": null,
  "lofi-relax": null,
  "lofi-game": null,
  "lofi-vibe": null,
  "lofi-sleep": null,
  "radio-mix": "/api/live-radio-mix",
  "best-of-nostalgia": "/api/best-of-nostalgia",
  "good-life-radio": "/api/good-life-radio",
  "cafe-music-bgm": "/api/cafe-music-bgm",
};

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


const BODY_RECTS = spriteRects().filter(r => !GEAR_CELLS.has(r.cell));
const GEAR_RECTS = spriteRects().filter(r => GEAR_CELLS.has(r.cell));
const EYE_RECTS = BODY_RECTS.filter(r => r.cell === "e");
const HAT_RECTS = spriteRects(HAT);
const TORSO_RECTS = BODY_RECTS.filter(r => r.y < LEG_TOP_ROW && r.cell !== "e")
  .map(r => {
    if (r.y !== 8 && r.y !== 9) return r;
    const x = Math.max(6, r.x);
    return { ...r, x, w: Math.max(0, Math.min(12, r.x + r.w) - x) };
  }).filter(r => r.w > 0);
const LEG_RECTS = {
  left: BODY_RECTS.filter(r => r.y >= LEG_TOP_ROW && r.x < LEG_SPLIT_COL),
  right: BODY_RECTS.filter(r => r.y >= LEG_TOP_ROW && r.x >= LEG_SPLIT_COL),
};
const PROP_PIXELS = {
  litter: pixels(PROP_ART.litter, "litter"),
  ball: pixels(PROP_ART.ball, "ball"),
  scope: pixels(PROP_ART.scope, "scope"),
};

/** A direct stream's host, which is what the play control names as the place
 *  the sound comes from — the way it names YouTube for everything else. */
function streamHost(url: string): string {
  try { return new URL(url).host; } catch { return "the station's server"; }
}

export default memo(
  function ClaudeFm({
    fetchImpl, volume, muted = false, source = "claude-fm", playRequest = 0, customStation, onAvailabilityChange,
  }: {
    fetchImpl?: typeof fetch;
    volume: number;
    muted?: boolean;
    source?: FmSelection;
    /** Bumped by App each time somebody PICKS a station. A change of `source`
     *  alone is not a request for sound — see the probe effect. */
    playRequest?: number;
    customStation?: CustomFmStation;
    onAvailabilityChange?: (source: FmSelection, unavailable: boolean) => void;
  }) {
    const [probe, setProbe] = useState<Probe | null>(null);
    /** Set once and never unset: the player told us it cannot play here. */
    const [dead, setDead] = useState(false);
    /** Buffering keeps the iframe mounted; an explicit stop releases it. */
    const [armed, setArmed] = useState(false);
    const [playing, setPlaying] = useState(false);
    const playRequestRef = useRef(playRequest);
    const audio = useRef<HTMLAudioElement | null>(null);
    const hls = useRef<Hls | null>(null);

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

    const frame = useRef<HTMLIFrameElement | null>(null);

    const stopDirect = useCallback(() => {
      hls.current?.destroy();
      hls.current = null;
      const player = audio.current;
      if (!player) return;
      player.pause();
      player.removeAttribute("src");
      player.load();
      audio.current = null;
    }, []);

    /** One place that talks to the player, so every send is origin-targeted
     *  rather than `"*"` — a wildcard target posts the message to whatever
     *  document happens to be in the frame, which is not a thing to be relaxed
     *  about even for a volume change. */
    const say = useCallback((json: string) => {
      frame.current?.contentWindow?.postMessage(json, PLAYER_ORIGIN);
    }, []);

    /** The slider's level, readable at SEND time. The "ready" handler below
     *  lives behind an [armed, say] effect, so a prop read straight would be
     *  the volume as it was when the listener attached — a drag finished
     *  before the player answered would be silently reverted on ready. */
    const volumeRef = useRef(volume);
    volumeRef.current = volume;
    const mutedRef = useRef(muted);
    mutedRef.current = muted;

    /**
     * A direct stream (#1208), started. Reached from the press on the character
     * and from a station pick, and both are the gesture that asked for sound.
     *
     * EVERY CALLBACK ASKS WHETHER ITS PLAYER IS STILL THE CURRENT ONE FIRST.
     * Stopping a stream, or switching station, while it is still connecting
     * rejects its pending play() with an AbortError. That is the person's own
     * press, not the stream failing, and the first version answered it as a
     * failure: the station it stopped was marked unavailable, and `dead` landed
     * on whichever station had just replaced it, so the character vanished.
     */
    const startDirect = useCallback((url: string, isHls: boolean, selection: FmSelection) => {
      stopDirect();
      const player = new Audio();
      player.preload = "none";
      player.volume = volumeRef.current / 100;
      player.muted = mutedRef.current;
      audio.current = player;
      setArmed(true);
      setPlaying(true);

      const current = () => audio.current === player;
      const released = () => {
        stopDirect();
        setArmed(false);
        setPlaying(false);
      };
      const failed = () => {
        if (!current()) return;
        released();
        setDead(true);
        onAvailabilityChange?.(selection, true);
      };
      // A refused autoplay is the browser wanting a press of its own, not a
      // broken station: the control stays, idle, and pressing it plays.
      const refused = (error: unknown) => {
        if (!current()) return;
        if (error instanceof DOMException && error.name === "NotAllowedError") { released(); return; }
        failed();
      };
      player.addEventListener("playing", () => {
        if (!current()) return;
        setPlaying(true);
        onAvailabilityChange?.(selection, false);
      });
      player.addEventListener("ended", () => { if (current()) released(); });
      player.addEventListener("error", failed, { once: true });

      if (isHls && !player.canPlayType("application/vnd.apple.mpegurl")) {
        // hls.js is fetched here and nowhere else. It is a third of the size of
        // the whole deck again, and only somebody playing an HLS station in a
        // browser without native HLS ever needs it, so it is its own chunk
        // rather than part of every page load.
        import("hls.js").then(({ default: HlsPlayer }) => {
          if (!current()) return;
          if (!HlsPlayer.isSupported()) { failed(); return; }
          const stream = new HlsPlayer();
          hls.current = stream;
          stream.on(HlsPlayer.Events.ERROR, (_event, data) => { if (data.fatal) failed(); });
          stream.on(HlsPlayer.Events.MEDIA_ATTACHED, () => stream.loadSource(url));
          stream.on(HlsPlayer.Events.MANIFEST_PARSED, () => { void player.play().catch(refused); });
          stream.attachMedia(player);
        }, failed);
      } else {
        player.src = url;
        void player.play().catch(refused);
      }
    }, [onAvailabilityChange, stopDirect]);

    // HOW LOUD, WHILE IT PLAYS. `setVolume` is a plain command: the player
    // accepts it and reports nothing, so there is nothing to listen for here —
    // the volume changes infoDelivery carries are exactly the payloads
    // readSignal already ignores, and reading the level BACK would only
    // re-introduce the optimistic-state flapping that handler spent a comment
    // ruling out. A prop in the deps rather than the ref, because a ref cannot
    // ask for the re-run a slider drag needs. The send this makes the moment
    // `armed` flips is allowed to be dropped — the player is not ready yet —
    // because the ready handshake below repeats it.
    useEffect(() => {
      if (!armed) return;
      say(command("setVolume", [volume]));
      say(command(muted ? "mute" : "unMute"));
      if (audio.current) {
        audio.current.volume = volume / 100;
        audio.current.muted = muted;
      }
    }, [volume, muted, armed, say]);

    // WHETHER THERE IS ANYTHING TO PLAY. One request, on mount, and the answer
    // is cached by the server for everyone else. A failure is indistinguishable
    // from "not live" on purpose: both mean nothing renders.
    //
    // AND WHETHER TO START IT. Picking a station plays it — the pick is the
    // click that asked for sound, which is what "start the newly selected
    // stream immediately" meant when the station list first shipped. It is the
    // PICK that counts, not the source changing: the source also changes when
    // a reload restores it and when removing the active custom station falls
    // back to Claude FM, and neither of those is anybody asking for music. So
    // this compares App's pick counter, which only a pick moves, and a mount
    // takes the counter as it finds it.
    useEffect(() => {
      let alive = true;
      const get = fetchImpl ?? fetch;
      const asked = playRequestRef.current !== playRequest;
      playRequestRef.current = playRequest;
      setProbe(null);
      setDead(false);
      setArmed(asked);
      setPlaying(asked);
      stopDirect();

      const custom = customStation && customFmSelection(customStation.id) === source
        ? parseFmStationUrl(customStation.url)
        : null;
      if (custom) {
        if (custom.kind === "direct-audio") {
          setProbe({ live: true, channel: "", audio: custom.url, hls: custom.format === "hls" });
          onAvailabilityChange?.(source, false);
          if (asked) startDirect(custom.url, custom.format === "hls", source);
          return () => { alive = false; };
        }
        if (custom.kind === "youtube-channel") {
          setProbe({ live: true, channel: custom.channel });
          onAvailabilityChange?.(source, false);
          return () => { alive = false; };
        }
        get(`/api/fm-station?url=${encodeURIComponent(custom.url)}`)
          .then(r => r.ok ? r.json() : null)
          .then(a => {
            if (!alive) return;
            if (a?.channel || a?.video) {
              setProbe({ live: true, channel: a.channel ?? "", video: a.video ?? undefined });
              onAvailabilityChange?.(source, false);
            } else {
              setDead(true);
              onAvailabilityChange?.(source, true);
            }
          })
          .catch(() => {
            if (!alive) return;
            setDead(true);
            onAvailabilityChange?.(source, true);
          });
        return () => { alive = false; };
      }

      if (customFmId(source)) {
        setDead(true);
        onAvailabilityChange?.(source, true);
        return () => { alive = false; };
      }

      const builtIn = source as FmSource;
      const liveEndpoint = LIVE_ENDPOINT[builtIn];
      if (liveEndpoint) {
        get(liveEndpoint)
          .then(r => r.ok ? r.json() : null)
          .then(a => {
            if (alive && a?.video) setProbe({ live: true, channel: "", video: a.video });
          })
          .catch(() => { /* no music today */ });
      } else if (builtIn !== "claude-fm") {
        const station = builtIn.replace("lofi-", "");
        get(`/api/lofi-girl?station=${encodeURIComponent(station)}`)
          .then(r => r.ok ? r.json() : null)
          .then(a => {
            if (alive && a?.video) setProbe({ live: true, channel: "", video: a.video });
          })
          .catch(() => { /* no music today */ });
      } else {
        get("/api/claude-fm")
          .then(r => r.ok ? r.json() : null)
          .then(a => { if (alive && a?.live && a?.channel) setProbe({ live: true, channel: a.channel }); })
          .catch(() => { /* no music today */ });
      }
      return () => { alive = false; };
    }, [customStation?.id, customStation?.url, fetchImpl, onAvailabilityChange, playRequest, source, startDirect, stopDirect]);

    useEffect(() => () => stopDirect(), [stopDirect]);

    // WHAT THE PLAYER SAYS BACK, once the iframe's onLoad below has opened the
    // conversation. The origin check is the whole security of this listener:
    // `message` fires for anything on the page that posts one, and this reads
    // JSON out of it.
    useEffect(() => {
      if (!armed) return;
      const onMessage = (e: MessageEvent) => {
        if (e.origin !== PLAYER_ORIGIN) return;
        if (e.source !== frame.current?.contentWindow) return;
        const signal = readSignal(e.data);
        if (!signal) return;
        // AUTOPLAY IS ASKED FOR TWICE, because once is not reliable. The src
        // carries `autoplay=1` and the frame is built inside the click that
        // asked for music, which is everything the autoplay policy wants — and
        // the player still came up at state -1 (unstarted) on a real deck. A
        // `playVideo` the moment it is ready costs nothing when the stream is
        // already running and is the difference between a press that works and
        // a press that silently does not.
        if (signal.kind === "ready") {
          // The volume goes FIRST: the stream's first audible moment is at the
          // level the menu says, not at whatever the player remembers from its
          // own store — there is no window at the wrong loudness to notice.
          say(command("setVolume", [volumeRef.current]));
          say(command(muted ? "mute" : "unMute"));
          say(command("playVideo"));
          return;
        }
        if (signal.kind === "playing") { setPlaying(signal.playing); return; }
        if (FATAL_ERRORS.includes(signal.code)) {
          // The stream is gone, or this channel does not allow embedding. There
          // is nothing to offer and nothing to say about it.
          setArmed(false);
          setPlaying(false);
          setDead(true);
          onAvailabilityChange?.(source, true);
        }
      };
      window.addEventListener("message", onMessage);
      return () => window.removeEventListener("message", onMessage);
    }, [armed, muted, onAvailabilityChange, say, source]);

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

    if (!probe || dead) return null;

    const press = () => {
      if (probe.audio) {
        if (armed) {
          stopDirect();
          setArmed(false);
          setPlaying(false);
          return;
        }
        startDirect(probe.audio, probe.hls === true, source);
        return;
      }

      if (!armed) { setArmed(true); setPlaying(true); return; }
      // Optimistic: the player confirms with onStateChange a moment later, and
      // a control that waits for a round trip before it looks pressed feels
      // broken on a stream that takes a second to buffer.
      const next = !playing;
      setPlaying(next);
      say(command(next ? "playVideo" : "pauseVideo"));
      if (!next) setArmed(false);
    };

    const label = sourceLabel(source, customStation);
    const from = probe.audio ? streamHost(probe.audio) : "YouTube";

    return (
      <div
        ref={scene}
        className="fm"
        data-suspended={suspended ? "" : undefined}
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
            {PROP_PIXELS[prop.kind]}
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
            {PROP_PIXELS[prop.kind]}
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
          /* The name says the state, so there is no aria-pressed beside it.
             The two together were read as "Stop Claude FM, pressed" — a verb
             for the next press and a state for the last one, and nothing to
             say which "pressed" meant. The verb flips with `playing`, the way
             the title does, and is the whole of what a reader needs. */
          onClick={press}
          title={playing ? `Stop ${label}` : `Play ${label} — streams from ${from}`}
          aria-label={playing ? `Stop ${label}` : `Play ${label}`}
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
                {GEAR_RECTS.map(r => (
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
              {EYE_RECTS.map(r => (
                <rect key={`eye-bed-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill="var(--accent)" />
              ))}
              {TORSO_RECTS.map(r => (
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
              {EYE_RECTS.map(r => (
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
              {HAT_RECTS.map(r => (
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
                {LEG_RECTS[side].map(r => (
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
        {armed && !probe.audio && (probe.channel || probe.video) && (
          <iframe
            ref={frame}
            className="fm-frame"
            title={label}
            src={embedSrc(probe.channel, window.location.origin, probe.video)}
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
