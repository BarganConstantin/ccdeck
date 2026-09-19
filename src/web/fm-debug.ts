// TEMPORARY DEBUG BUILD — branch debug/fm-player-log, never for development.
//
// Reports what the Claude FM player says to the local sound-dip-watch logger
// (127.0.0.1:4390), so a silent gap in the music can be read against the
// player's own account of it: buffering, paused, an ad, a video change, a stall,
// or nothing at all. Every report is a short line; the logger stamps the time.

const ENDPOINT = "http://127.0.0.1:4390/player";
const STATE: Record<number, string> = {
  [-1]: "unstarted", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "cued",
};

export function fmReport(m: string) {
  try {
    const body = JSON.stringify({ m });
    if (!navigator.sendBeacon?.(ENDPOINT, body)) {
      void fetch(ENDPOINT, { method: "POST", body, mode: "no-cors", keepalive: true }).catch(() => {});
    }
  } catch { /* the logger is not running; the page must not care */ }
}

let last: Record<string, string> = {};
let position = { t: -1, at: 0 };
let stuckReported = false;
let beatAt = 0;
let heardAt = 0;

/** When the player last said anything, for the watchdog. */
export const fmLastHeard = () => heardAt;

/**
 * Every message from the player, reduced to what changed. `infoDelivery` comes
 * several times a second, so only a change of state, volume, mute, quality,
 * rate, video or any ad-looking field is reported — plus a beat every 10 s with
 * the position and the buffered fraction, and one line when the position stops
 * moving while the player still says it is playing.
 */
export function fmObserve(raw: unknown) {
  heardAt = Date.now();
  let msg: any = raw;
  if (typeof raw === "string") {
    try { msg = JSON.parse(raw); } catch { fmReport(`raw ${String(raw).slice(0, 120)}`); return; }
  }
  if (!msg || typeof msg !== "object") return;
  const { event, info } = msg;
  if (event !== "infoDelivery" || !info || typeof info !== "object") {
    fmReport(`${event ?? "?"} ${JSON.stringify(info ?? null).slice(0, 200)}`);
    return;
  }
  const pick: Record<string, string> = {};
  if ("playerState" in info) pick.state = `${info.playerState}(${STATE[info.playerState] ?? "?"})`;
  if ("volume" in info) pick.volume = String(info.volume);
  if ("muted" in info) pick.muted = String(info.muted);
  if ("playbackQuality" in info) pick.quality = String(info.playbackQuality);
  if ("playbackRate" in info) pick.rate = String(info.playbackRate);
  const vd = info.videoData;
  if (vd && typeof vd === "object") {
    pick.video = `${vd.video_id ?? "?"} ${JSON.stringify(vd.title ?? "").slice(0, 60)}${vd.isLive === false ? " (not live)" : ""}`;
  }
  for (const k of Object.keys(info)) {
    if (/ad/i.test(k) && !/load/i.test(k)) pick[k] = JSON.stringify(info[k]).slice(0, 80);
  }
  const changed = Object.entries(pick).filter(([k, v]) => last[k] !== v);
  if (changed.length) {
    fmReport(changed.map(([k, v]) => `${k}=${v}`).join(" "));
    last = { ...last, ...pick };
  }

  const now = Date.now();
  if (typeof info.currentTime === "number") {
    if (Math.abs(info.currentTime - position.t) >= 0.25) {
      if (stuckReported) fmReport(`position moving again at t=${info.currentTime.toFixed(1)}`);
      position = { t: info.currentTime, at: now };
      stuckReported = false;
    } else if (!stuckReported && last.state?.startsWith("1(") && now - position.at > 3000) {
      fmReport(`position stuck at t=${info.currentTime.toFixed(1)} for ${((now - position.at) / 1000).toFixed(0)}s while the player says playing`);
      stuckReported = true;
    }
  }
  if (now - beatAt > 10_000) {
    beatAt = now;
    const t = typeof info.currentTime === "number" ? info.currentTime.toFixed(1) : String(position.t);
    const loaded = typeof info.videoLoadedFraction === "number" ? info.videoLoadedFraction.toFixed(4) : "?";
    fmReport(`beat t=${t} loaded=${loaded} state=${last.state ?? "?"} vol=${last.volume ?? "?"} muted=${last.muted ?? "?"}`);
  }
}
