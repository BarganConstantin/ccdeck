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
import { memo, type CSSProperties } from "react";
import { BALL_FLIGHT_MS, SKIP_BEAT_MS, type Act } from "../claude-fm";
import { DANCES } from "../claude-fm-dance";
import { PROP_ART, spriteRects } from "../claude-fm-sprite";
import { embedSrc, listenCommand } from "../claude-fm-player";
import type { FmSource } from "../appearance";
import {
  customFmId, customFmSelection,
  type CustomFmStation, type FmSelection,
} from "../fm-stations";
import { useFmPlayer } from "../use-fm-player";
import { useFmScene } from "../use-fm-scene";
import FmSprite from "./FmSprite";

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

/** A prop's grid drawn as one SVG of merged runs: the litter, the ball and the
 *  scope, each drawn once below. The character is drawn by FmSprite.tsx from
 *  the same runs, split into the parts that move. */
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
    const { probe, dead, armed, playing, frame, say, press } = useFmPlayer({
      fetchImpl, volume, muted, source, playRequest, customStation, onAvailabilityChange,
    });

    const { scene, suspended, x, walkMs, act, prop, ballFlight, place, facing, riser, dance, beatMs } =
      useFmScene(probe, dead, playing);

    if (!probe || dead) return null;

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
          <FmSprite act={act} facing={facing} />
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
