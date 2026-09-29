// Claude FM's side of the player conversation: the embed's URL, the commands
// the page sends the player, and what its replies mean.
//
// Lifted out of claude-fm.ts. Pure and checked under node, for the reason that
// module gives: what URL the iframe gets and what a player message means are
// string-building with no DOM in them. use-fm-player.ts is the part that
// talks; this is what it says.
//
// WHAT PLAYS is decided by the server (src/server/claude-fm.mjs): it asks
// whether the Claude channel is broadcasting and hands back the channel id, and
// for Claude FM no video id crosses this file. See that module's header for why
// a channel id is the only durable handle a stream has. The other stations are
// resolved to a video by routes of their own, which is what embedSrc's `video`
// is for.

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
export function embedSrc(channel: string, origin: string, video?: string): string {
  const q = new URLSearchParams({
    ...(video ? {} : { channel }),
    enablejsapi: "1",
    autoplay: "1",
    playsinline: "1",
    // No related-video rail and no branding on a player nobody can see anyway;
    // both only matter if the frame is ever made visible.
    rel: "0",
    modestbranding: "1",
    origin,
  });
  return `${PLAYER_ORIGIN}/embed/${video ? encodeURIComponent(video) : "live_stream"}?${q.toString()}`;
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

/** Ended, and paused. The only two states that mean playback has stopped —
 *  everything else the player reports is either playing or not yet anything. */
export const STOPPED_STATES: readonly number[] = [0, 2];

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
    if (PLAYING_STATES.includes(state)) return { kind: "playing", playing: true };
    // UNSTARTED IS NOT STOPPED, and reading it as stopped is what made the hat
    // flash back on between the press and the first note. A freshly built
    // player announces -1 before it has done anything at all, and 5 means a
    // video is cued and waiting — neither is a report that playback ended, they
    // are the absence of any report. Treated as "stopped" they overrode the
    // press that had just been made, so the observed sequence -1, 3, 1 put the
    // headphones on, the hat back, and the headphones on again.
    if (!STOPPED_STATES.includes(state)) return null;
    return { kind: "playing", playing: false };
  }
  return null;
}
