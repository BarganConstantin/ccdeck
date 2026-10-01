// Claude FM's player: whether there is anything to play, the stream that plays
// it, and the press that starts and stops it.
//
// Lifted out of components/ClaudeFm.tsx unchanged. Two players sit behind one
// press: YouTube's embed, spoken to over postMessage (see the component's
// header for why no iframe_api script), and an <audio> element for a direct
// stream (#1208). The component draws the character and hands the iframe the
// `frame` ref and `say`; everything that decides what is playing lives here.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
// Type only: the library itself is imported on demand, in startDirect.
import type Hls from "hls.js";
import { command, FATAL_ERRORS, PLAYER_ORIGIN, readSignal } from "./claude-fm-player";
import type { FmSource } from "./appearance";
import {
  customFmId, customFmSelection, parseFmStationUrl,
  type CustomFmStation, type FmSelection,
} from "./fm-stations";
import { useFeatureUse } from "./feature-use";

export interface Probe { live: boolean; channel: string; video?: string; audio?: string; hls?: boolean }

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

export interface FmPlayerOptions {
  fetchImpl?: typeof fetch;
  volume: number;
  muted: boolean;
  source: FmSelection;
  /** Bumped by App each time somebody PICKS a station — see the probe effect. */
  playRequest: number;
  customStation?: CustomFmStation;
  onAvailabilityChange?: (source: FmSelection, unavailable: boolean) => void;
}

export interface FmPlayer {
  /** What the server said there is to play, or null: nothing to draw. */
  probe: Probe | null;
  /** Set once and never unset: the player told us it cannot play here. */
  dead: boolean;
  /** The embed is wanted: the iframe is mounted while this is on. */
  armed: boolean;
  playing: boolean;
  /** The embed's frame, which the component renders and this talks to. */
  frame: MutableRefObject<HTMLIFrameElement | null>;
  /** Post one command to the player, at its origin. */
  say: (json: string) => void;
  /** The press on the character: start what is not playing, stop what is. */
  press: () => void;
}

export function useFmPlayer({
  fetchImpl, volume, muted, source, playRequest, customStation, onAvailabilityChange,
}: FmPlayerOptions): FmPlayer {
  const [probe, setProbe] = useState<Probe | null>(null);
  /** Set once and never unset: the player told us it cannot play here. */
  const [dead, setDead] = useState(false);
  /** Buffering keeps the iframe mounted; an explicit stop releases it. */
  const [armed, setArmed] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Playing is one of the features the usage reports name (feature-use.ts).
  useFeatureUse("claude-fm", playing);
  const playRequestRef = useRef(playRequest);
  const audio = useRef<HTMLAudioElement | null>(null);
  const hls = useRef<Hls | null>(null);

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
      // Every YouTube link goes by the server, a channel link included:
      // it answers one without a request of its own, and it is where
      // AGENTS_DECK_NO_MUSIC is kept.
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
          if (!alive) return;
          if (a?.video) setProbe({ live: true, channel: "", video: a.video });
          onAvailabilityChange?.(source, !a?.video);
        })
        .catch(() => { if (alive) onAvailabilityChange?.(source, true); });
    } else if (builtIn !== "claude-fm") {
      const station = builtIn.replace("lofi-", "");
      get(`/api/lofi-girl?station=${encodeURIComponent(station)}`)
        .then(r => r.ok ? r.json() : null)
        .then(a => {
          if (!alive) return;
          if (a?.video) setProbe({ live: true, channel: "", video: a.video });
          onAvailabilityChange?.(source, !a?.video);
        })
        .catch(() => { if (alive) onAvailabilityChange?.(source, true); });
    } else {
      get("/api/claude-fm")
        .then(r => r.ok ? r.json() : null)
        .then(a => {
          if (!alive) return;
          const live = !!(a?.live && a?.channel);
          if (live) setProbe({ live: true, channel: a.channel });
          onAvailabilityChange?.(source, !live);
        })
        .catch(() => { if (alive) onAvailabilityChange?.(source, true); });
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

  const press = () => {
    // Only drawn, and so only pressed, while there is a probe; this tells the types.
    if (!probe) return;
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

  return { probe, dead, armed, playing, frame, say, press };
}
