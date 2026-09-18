// Claude FM: the arithmetic, the player conversation, and the three ways the
// control is allowed to be absent.
//
// The feature is a toy and the tests are not, because the failures a toy can
// have are the ones nobody investigates: a control that presses and does
// nothing, a page that makes noise on load, a probe that quietly reports a live
// channel as silent. Each of those has a case here.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FM_CHANNEL, CACHE_MS, MISS_CACHE_MS, READ_LIMIT,
  fetchClaudeFm, forgetClaudeFm, FORCE_POLL_MS, isChannelId, liveUrl,
  mayAskYouTube, readLiveMarks, readUntilMarks,
} from "../../server/claude-fm.mjs";
import {
  command, duckMsFor, DUCK_TAIL_MS, DUCK_VOLUME, embedSrc, FATAL_ERRORS, FULL_VOLUME, STOPPED_STATES,
  listenCommand, nextIdleMs, nextWalk, PLAYER_ORIGIN, PLAYING_STATES, readSignal,
  SPRITE, SPRITE_H, SPRITE_W, spriteRects,
  ACTIVITIES, BALL_ROLL_PX, BALL_FLIGHT_MS, BIN_X, climbMsFor, crossSteps, HAT, HAT_X, HAT_Y, FALL_G, fallMsFor, KICK_MS, kickSteps, leaveLedgeSteps,
  nextActivity, pickActivity, propSpot, sitSteps, fishSteps, skipSteps, SKIP_BEAT_MS, ballRollTo,
  STOOP_MS, TOSS_MS,
  tidySteps, TOSS_WINDUP_MS, walkMsFor, watchSteps, PROP_ART,
  BEAT_DRIFT, BEAT_MS, DANCE_MAX_MS, DANCE_MIN_MS, DANCES, FOCUS_ACTS,
  facingFor, isFocused, LEG_TOP_ROW, MOVING_ACTS, nextDance, nextDanceMs,
  type Act, type Step,
  WALK_IDLE_MAX_MS, WALK_IDLE_MIN_MS, WALK_MIN_STEP_PX, WALK_MS_PER_PX, WALK_SPAN_PX,
} from "../claude-fm";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Source read as CODE, with its prose taken out.
 *
 *  Every assertion below is about what this deck DOES, and a file that explains
 *  at length why it does not load `iframe_api` contains the string `iframe_api`.
 *  The comment that names a thing to rule it out would otherwise fail the test
 *  that rules it out — the trap card-focus-ring-869 already strips the sheet
 *  for, here for TypeScript as well. */
const code = (rel: string) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const css = code("../styles.css");
const component = code("../components/ClaudeFm.tsx");
const probeSrc = code("../../server/claude-fm.mjs");
const server = code("../../server/index.mjs");
const app = code("../App.tsx");

/** A page shaped like the one YouTube serves for `/channel/<id>/live`. */
const livePage = (video = "tRsQsTMvPNg", pad = 0) =>
  `<html><head>${"x".repeat(pad)}` +
  `<link rel="canonical" href="https://www.youtube.com/watch?v=${video}">` +
  `</head><body>{"isLive":true}</body></html>`;

describe("what plays is a channel, never a video", () => {
  it("holds a channel id and no video id anywhere", () => {
    expect(isChannelId(CLAUDE_FM_CHANNEL)).toBe(true);
    // The one thing that must never appear in either module: an 11-character
    // video id. A stream ends and restarts under a new one, and a deck that
    // named it would need a release to keep working.
    expect(embedSrc(CLAUDE_FM_CHANNEL, "http://x")).toContain("live_stream");
    expect(probeSrc).not.toMatch(/["'][\w-]{11}["']\s*[,;)]/);
  });

  it("asks the channel's own /live, not a watch URL", () => {
    expect(liveUrl()).toBe(`https://www.youtube.com/channel/${CLAUDE_FM_CHANNEL}/live`);
    expect(liveUrl()).not.toContain("watch?v=");
  });

  it("refuses a channel id that is not one, rather than fetching it", () => {
    for (const bad of ["", "UC", "../../etc", "UC" + "x".repeat(21), null, 7, "UC!!!!!!!!!!!!!!!!!!!!!!"]) {
      expect(isChannelId(bad as string)).toBe(false);
    }
    expect(isChannelId("UC" + "A".repeat(22))).toBe(true);
  });
});

describe("reading whether the channel is on air", () => {
  it("needs both marks, because either alone is a guess", () => {
    expect(readLiveMarks(livePage())).toEqual({ live: true, video: "tRsQsTMvPNg" });
    // A canonical that is the channel page: not live.
    expect(readLiveMarks(`<link rel="canonical" href="https://www.youtube.com/channel/${CLAUDE_FM_CHANNEL}">`))
      .toEqual({ live: false, video: null });
    // `"isLive":true` on its own is a recommendation rail talking about
    // somebody else's stream.
    expect(readLiveMarks('<body>{"isLive":true}</body>')).toEqual({ live: false, video: null });
    // A watch canonical with nothing live on it is an ordinary video.
    expect(readLiveMarks('<link rel="canonical" href="https://www.youtube.com/watch?v=tRsQsTMvPNg">'))
      .toEqual({ live: false, video: null });
  });

  it("survives a page with nothing in it", () => {
    for (const junk of ["", "<html></html>", null as unknown as string]) {
      expect(readLiveMarks(junk)).toEqual({ live: false, video: null });
    }
  });
});

describe("the read stops on content, not on a byte count", () => {
  // THE REGRESSION. The first build capped the read at 600,000 bytes on the
  // reasoning that a canonical link lives in <head> and <head> is at the top of
  // a document. On youtube.com it is not: the player payload is inlined ahead
  // of it, and on the day this was written the canonical sat at byte 711,238 of
  // a 1.15MB page. The cap cut both marks off and the probe reported a live
  // channel as silent.
  it("finds marks that sit well past where a <head> is supposed to end", async () => {
    const html = livePage("tRsQsTMvPNg", 800_000);
    expect(html.length).toBeGreaterThan(800_000);
    expect(readLiveMarks(await readUntilMarks(bodyOf(html)))).toEqual({ live: true, video: "tRsQsTMvPNg" });
  });

  it("leaves as soon as both marks are in hand", async () => {
    const chunks = [
      `<link rel="canonical" href="https://www.youtube.com/watch?v=tRsQsTMvPNg">`,
      `{"isLive":true}`,
      "MUST NOT BE READ".repeat(1000),
    ];
    const { res, delivered } = countingBody(chunks);
    const out = await readUntilMarks(res);
    expect(out).not.toContain("MUST NOT BE READ");
    expect(delivered()).toBe(2);
  });

  it("finds a mark that straddles two chunks", async () => {
    const whole = livePage();
    const { res } = countingBody([whole.slice(0, 40), whole.slice(40)]);
    expect(readLiveMarks(await readUntilMarks(res))).toEqual({ live: true, video: "tRsQsTMvPNg" });
  });

  it("still ends a page that will never carry them", async () => {
    // Nothing to stop on, so the backstop is what ends it — and it is a
    // backstop rather than a budget: far above any page YouTube serves.
    expect(READ_LIMIT).toBeGreaterThan(1_500_000);
    const { res } = countingBody(["not youtube".repeat(10)]);
    expect(await readUntilMarks(res, 50)).toHaveLength(50);
  });
});

describe("the probe asks once and answers everyone", () => {
  beforeEach(() => forgetClaudeFm());

  it("makes one request for concurrent callers", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return okWith(livePage()); };
    const [a, b, c] = await Promise.all([
      fetchClaudeFm({ fetchImpl }), fetchClaudeFm({ fetchImpl }), fetchClaudeFm({ fetchImpl }),
    ]);
    expect(calls).toBe(1);
    expect(a.live && b.live && c.live).toBe(true);
    expect(a.channel).toBe(CLAUDE_FM_CHANNEL);
  });

  it("caches a live answer far longer than a miss", async () => {
    // A live stream does not start and stop often; a laptop that has just
    // joined a network should not wait out the full window to notice.
    expect(CACHE_MS).toBeGreaterThan(MISS_CACHE_MS * 5);
  });

  it("serves the next caller from the cache", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return okWith(livePage()); };
    await fetchClaudeFm({ fetchImpl });
    await fetchClaudeFm({ fetchImpl });
    expect(calls).toBe(1);
  });

  it("will not let ?refresh=1 spend youtube.com a request at a time", async () => {
    // `?refresh=1` is a GET, so any page the user has open can send one in a
    // loop. The cache above bounds what this deck costs on its own and bounds
    // nothing against a caller asking to skip it — which is the whole reason
    // codex-usage-forced-read-guard.test.ts counts the forcible routes.
    let calls = 0;
    const fetchImpl = async () => { calls += 1; return okWith(livePage()); };
    await fetchClaudeFm({ fetchImpl });
    for (let i = 0; i < 20; i++) await fetchClaudeFm({ fetchImpl, force: true });
    expect(calls).toBe(1);
  });

  it("applies that floor in a rule that can be read without making a request", () => {
    const at = Date.now();
    expect(mayAskYouTube(false, 0, at)).toBe(false);          // not forced at all
    expect(mayAskYouTube(true, 0, at)).toBe(true);            // nothing read yet
    expect(mayAskYouTube(true, at - 1_000, at)).toBe(false);  // inside the floor
    expect(mayAskYouTube(true, at - FORCE_POLL_MS, at)).toBe(true);
    // The number five other modules already agreed on, reused rather than
    // re-argued.
    expect(FORCE_POLL_MS).toBe(60_000);
  });

  it("answers a thrown request the same way it answers an off-air channel", async () => {
    const answer = await fetchClaudeFm({ fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND"); } });
    // ok:false and live:false. The canvas reads `live` alone, so offline, DNS,
    // a timeout and a blocked host all come out as "draw nothing" with no
    // second code path to keep working.
    expect(answer.live).toBe(false);
    expect(answer.ok).toBe(false);
    expect(answer.why).toContain("ENOTFOUND");
  });

  it("answers a non-200 without reading it", async () => {
    const answer = await fetchClaudeFm({
      fetchImpl: async () => ({ ok: false, status: 429, body: null, text: async () => "" }) as unknown as Response,
    });
    expect(answer.live).toBe(false);
    expect(answer.why).toContain("429");
  });

  it("ignores a malformed channel rather than putting it in a URL", async () => {
    let asked = "";
    const fetchImpl = async (u: string) => { asked = String(u); return okWith(livePage()); };
    await fetchClaudeFm({ channel: "../../evil", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(asked).toBe(liveUrl(CLAUDE_FM_CHANNEL));
  });
});

describe("the embed", () => {
  const src = embedSrc(CLAUDE_FM_CHANNEL, "http://127.0.0.1:4317");

  it("goes to the no-cookie player", () => {
    expect(PLAYER_ORIGIN).toBe("https://www.youtube-nocookie.com");
    expect(src.startsWith(`${PLAYER_ORIGIN}/embed/live_stream?`)).toBe(true);
  });

  it("carries the channel, the JS API and the page's origin", () => {
    const q = new URL(src).searchParams;
    expect(q.get("channel")).toBe(CLAUDE_FM_CHANNEL);
    expect(q.get("enablejsapi")).toBe("1");
    expect(q.get("origin")).toBe("http://127.0.0.1:4317");
    // autoplay is honest rather than sneaky: the frame is only ever built
    // inside the click that asked for music.
    expect(q.get("autoplay")).toBe("1");
  });

  it("loads no third-party script to do it", () => {
    for (const src2 of [component, code("../claude-fm.ts")]) {
      expect(src2).not.toContain("iframe_api");
      expect(src2).not.toContain("<script");
    }
  });
});

describe("talking to the player", () => {
  it("builds commands the widget API understands", () => {
    expect(JSON.parse(command("pauseVideo"))).toEqual({ event: "command", func: "pauseVideo", args: [] });
    expect(JSON.parse(command("setVolume", [18]))).toEqual({ event: "command", func: "setVolume", args: [18] });
    expect(JSON.parse(listenCommand())).toEqual({ event: "listening", id: "claude-fm", channel: "widget" });
  });

  it("reads the states that mean sound is coming", () => {
    expect(PLAYING_STATES).toEqual([1, 3]);           // playing, buffering
    expect(readSignal('{"event":"onStateChange","info":1}')).toEqual({ kind: "playing", playing: true });
    expect(readSignal('{"event":"onStateChange","info":3}')).toEqual({ kind: "playing", playing: true });
    // ENDED AND PAUSED ARE STOPPED. Those two, and only those two.
    for (const stopped of STOPPED_STATES) {
      expect(readSignal({ event: "onStateChange", info: stopped })).toEqual({ kind: "playing", playing: false });
    }
    // UNSTARTED IS NOT STOPPED, and reading it as stopped is what made the hat
    // flash back on between the press and the first note. A freshly built
    // player announces -1 before it has done anything at all, and 5 means a
    // video is cued and waiting — neither is a report that playback ended. Read
    // as "stopped" they overrode the press just made, so the player's own
    // sequence of -1, 3, 1 put the headphones on, the hat back, and the
    // headphones on again.
    for (const notYet of [-1, 5]) {
      expect(readSignal({ event: "onStateChange", info: notYet })).toBeNull();
    }
    expect(STOPPED_STATES).not.toContain(-1);
    expect(PLAYING_STATES).not.toContain(-1);
  });

  it("reads the spelling the player actually uses, not the documented one", () => {
    // Measured on a real deck: seven messages from the player and not one
    // `onStateChange`. The live player reports state inside `infoDelivery`,
    // mixed in with volume, quality and timing — so a build that read only the
    // documented event learned nothing the player ever said about playback.
    expect(readSignal({ event: "infoDelivery", info: { playerState: 1, currentTime: 12 } }))
      .toEqual({ kind: "playing", playing: true });
    expect(readSignal({ event: "infoDelivery", info: { playerState: 2 } }))
      .toEqual({ kind: "playing", playing: false });
    // And most of them carry no state at all. A volume change is not a report
    // that the music stopped.
    expect(readSignal({ event: "infoDelivery", info: { muted: false, volume: 100 } })).toBeNull();
    expect(readSignal({ event: "infoDelivery", info: { playbackQuality: "medium" } })).toBeNull();
  });

  it("reads ready and error", () => {
    expect(readSignal('{"event":"onReady"}')).toEqual({ kind: "ready" });
    // `initialDelivery` is the player listing its own API and is not a ready.
    expect(readSignal({ event: "initialDelivery", info: { apiInterface: ["playVideo"] } })).toBeNull();
    expect(readSignal({ event: "onError", info: 150 })).toEqual({ kind: "error", code: 150 });
    expect(readSignal({ event: "onError", info: { errorCode: 101 } })).toEqual({ kind: "error", code: 101 });
  });

  it("ignores everything else on the page", () => {
    for (const junk of ["", "not json", "{}", null, 7, { event: "resize" }, { hello: "world" }]) {
      expect(readSignal(junk)).toBeNull();
    }
  });

  it("treats every player error as final", () => {
    // 100 is gone, 101 and 150 are "the owner does not allow embedding", 2 is a
    // bad parameter and 5 an HTML5 failure. A music toy has nothing useful to
    // say about any of them and no second thing to try.
    expect(FATAL_ERRORS).toEqual([2, 5, 100, 101, 150]);
    expect(component).toContain("setDead(true)");
    expect(component).toMatch(/if \(!probe \|\| dead\) return null;/);
  });

  it("opens the conversation on the frame's load, not on a reply to it", () => {
    // The first build waited for `onReady` and answered it with `listening`.
    // `onReady` is the REPLY to `listening`, not something the player
    // volunteers, so nothing was sent and nothing came back — and an embed that
    // could not play at all looked exactly like one that was playing fine,
    // because the button's own state is optimistic. Measured on a real deck:
    // zero messages from the player.
    expect(component).toContain("onLoad={() => say(listenCommand())}");
    // And asks for play once the player answers: `autoplay=1` inside the click
    // that built the frame is everything the autoplay policy asks for, and the
    // player still came up unstarted on a real deck.
    expect(component).toContain('if (signal.kind === "ready") { say(command("playVideo")); return; }');
    expect(component).not.toMatch(/kind === "ready"\) \{ say\(listenCommand\(\)\)/);
  });

  it("posts to the player's origin and never to a wildcard", () => {
    expect(component).toContain("postMessage(json, PLAYER_ORIGIN)");
    expect(component).not.toContain('postMessage(json, "*")');
    // And reads nothing from a message that did not come from it.
    expect(component).toContain("if (e.origin !== PLAYER_ORIGIN) return;");
  });
});

describe("getting out of the way of the deck's own sound", () => {
  it("ducks rather than mutes", () => {
    // The music going silent and coming back is more noticeable than the music
    // getting quieter, and the point is to make the chime audible, not to
    // interrupt the track.
    expect(DUCK_VOLUME).toBeGreaterThan(0);
    expect(DUCK_VOLUME).toBeLessThan(FULL_VOLUME / 3);
  });

  it("holds the music down for the figure's own length", () => {
    // A fixed number would clip the long figures and leave the music quiet
    // after the short ones — and the sound menu lets a user pick either.
    const short = duckMsFor([{ at: 0, ms: 90 }]);
    const long = duckMsFor([{ at: 0, ms: 90 }, { at: 0.42, ms: 220 }]);
    expect(short).toBe(90 + DUCK_TAIL_MS);
    expect(long).toBe(640 + DUCK_TAIL_MS);
    expect(long).toBeGreaterThan(short);
    expect(duckMsFor([])).toBe(DUCK_TAIL_MS);
  });

  it("is wired to every chime the deck plays, and only when one sounded", () => {
    // `play` returns false when the switch is off or the page has not been
    // touched yet; ducking then would drop the music for nothing.
    expect(app).toContain("if (chime && chimesRef.current?.play(chime)) duckForChime(chime);");
    expect(app).toContain("if (chimesRef.current?.play(chime, true)) duckForChime(chime);");
    expect(app).toContain("figureFor(chime, tonePrefsRef.current[chime]?.figure)");
  });
});

describe("absent, not broken", () => {
  it("renders nothing until the server says the channel is on air", () => {
    expect(component).toMatch(/const \[probe, setProbe\] = useState<Probe \| null>\(null\)/);
    expect(component).toContain("a?.live && a?.channel");
    // No error state, no "music unavailable" chip, no retry.
    expect(component).not.toMatch(/unavailable|try again|retry/i);
  });

  it("builds no iframe until somebody presses play", () => {
    // A page that starts making noise on load is a bug, and an iframe that
    // exists has already called Google whether or not anybody asked.
    expect(component).toContain("{armed && probe.channel && (");
    expect(component).toMatch(/if \(!armed\) \{ setArmed\(true\); setPlaying\(true\); return; \}/);
    expect(component).not.toMatch(/useEffect\([^)]*setArmed\(true\)/);
  });

  it("never restores a playing state from storage", () => {
    expect(component).not.toContain("localStorage");
    expect(component).not.toContain("sessionStorage");
  });

  it("releases the player on explicit stop and rejects messages from old frames", () => {
    expect(component).toContain('if (e.source !== frame.current?.contentWindow) return;');
    expect(component).toMatch(/if \(!next\) \{\s*setArmed\(false\);/);
    expect(component).toContain('duckTimer.current = null;');
  });

  it("caches pixel geometry outside the memoized component", () => {
    const start = component.indexOf('export default memo(forwardRef');
    expect(start).toBeGreaterThan(0);
    expect(component.indexOf('const TORSO_RECTS')).toBeLessThan(start);
    expect(component.indexOf('const PROP_PIXELS')).toBeLessThan(start);
    expect(component.slice(start)).not.toContain('spriteRects(');
  });

  it("pauses scene timers and visual animations without stopping music", () => {
    expect(component).toContain('createSceneTimer(document)');
    expect(component).toContain('timer.dispose()');
    expect(component).toContain('data-suspended={suspended ? "" : undefined}');
    expect(component).toContain('animation.pause()');
    expect(component).toContain('animation.play()');
    expect(css).toMatch(/\.fm\.fm\[data-suspended\][\s\S]*?animation-play-state:\s*paused/);
  });

  it("lets a deck refuse to contact YouTube at all", () => {
    expect(server).toContain('process.env.AGENTS_DECK_NO_MUSIC === "1"');
    // The off switch answers the same shape an off-air channel does, so it
    // needs no second code path on the canvas.
    expect(server).toContain("{ ok: true, live: false, off: true }");
  });

  it("can be pointed at another channel without a release", () => {
    expect(server).toContain("process.env.AGENTS_DECK_FM_CHANNEL");
  });

  it("makes no request of its own accord", () => {
    // No boot probe and no timer: a deck nobody has opened calls youtube.com
    // zero times. The route is the only caller.
    expect(server.match(/fetchClaudeFm\(/g) ?? []).toHaveLength(1);
    expect(probeSrc).not.toMatch(/setInterval|setTimeout\(/);
  });

  it("is behind the same guard as every other read", () => {
    expect(server).toContain('url.pathname === "/api/claude-fm")   return guard(handleClaudeFm(req, res), res);');
  });
});

describe("the character", () => {
  it("is a grid, not a binary asset", () => {
    expect(SPRITE_W).toBe(18);
    expect(SPRITE_H).toBe(SPRITE.length);
    for (const row of SPRITE) expect(row).toHaveLength(SPRITE_W);
    for (const row of SPRITE) expect(row).toMatch(/^[.bseca p]+$/);
    // It has what it is for: headphones with pads, eyes, a body and a shaded
    // side away from the light.
    const cells = new Set(SPRITE.join("").split(""));
    for (const c of ["a", "c", "p", "b", "s", "e"]) expect(cells.has(c)).toBe(true);
    // One light source, from the left: the shade is the rightmost ink on every
    // row that has any, never the leftmost.
    for (const row of SPRITE) {
      if (!row.includes("s")) continue;
      expect(row.lastIndexOf("s")).toBeGreaterThan(row.indexOf("b"));
    }
  });

  it("merges each row into runs rather than a rect per square", () => {
    expect(spriteRects(["..bbb..."])).toEqual([{ x: 2, y: 0, w: 3, cell: "b" }]);
    // A run never spans two colours.
    expect(spriteRects(["bbcc"])).toEqual([
      { x: 0, y: 0, w: 2, cell: "b" },
      { x: 2, y: 0, w: 2, cell: "c" },
    ]);
    expect(spriteRects(["...."])).toEqual([]);
    // Merging is the point, not a particular ratio: the shading deliberately
    // breaks runs, so what this pins is that every run really is maximal.
    const filled = SPRITE.join("").replace(/\./g, "").length;
    expect(spriteRects().length).toBeLessThan(filled);
    for (const r of spriteRects()) {
      const row = SPRITE[r.y];
      expect(row[r.x - 1]).not.toBe(r.cell);
      expect(row[r.x + r.w]).not.toBe(r.cell);
    }
  });

  it("stands ON the minimap's edge, on numbers that are named", () => {
    // Its feet land exactly on the border, which is the difference between a
    // character and a sticker. No gap term: a character hovering a few pixels
    // over the ledge it is standing on is the thing that reads as wrong.
    // THE SCENE SITS ON THE CANVAS FLOOR AND THE LEDGE IS A HEIGHT WITHIN IT.
    // It used to be pinned to the minimap's top border, which made that border
    // the only place in the world — there was no way to express "further down"
    // at all, so the character could not leave it. Nothing moved on screen for
    // the change: --fm-y defaults to exactly the ledge's height above the floor.
    expect(decl(".fm", "bottom")).toBe("var(--flow-gutter)");
    expect(decl(".fm", "--fm-y")).toBe("calc(-1 * var(--minimap-h))");
    expect(decl(".fm", "right")).toBe("var(--flow-gutter)");
    expect(decl(".fm", "--flow-gutter")).toBe("15px");
    // 54px is 18 columns at exactly 3px. A width that does not divide by the
    // grid puts every cell boundary on a fraction of a pixel, and a pixel
    // character with soft edges is the one thing it cannot be.
    expect(decl(".fm-sprite", "width")).toBe("54px");
    expect(54 % SPRITE_W).toBe(0);
    expect(decl(".fm", "--minimap-h")).toBe("152px");
  });

  it("does not eat a press meant for the canvas", () => {
    expect(decl(".fm", "pointer-events")).toBe("none");
    expect(decl(".fm-sprite", "pointer-events")).toBe("auto");
    // And no `nopan`, which the first build carried as cargo: React Flow
    // renders a panel's children as siblings of `.react-flow__pane`, so a press
    // on this character never reaches the pan handler to be opted out of.
    expect(component).toContain('className="fm"');
    expect(component).not.toContain("nopan");
  });

  it("wears a hat when there is nothing to listen to", () => {
    // The headphones leaving used to leave a bare head, and a bare head is not
    // a state — it is the absence of one. Swapping one thing for another makes
    // the change legible, and reads as putting something on rather than having
    // something taken away.
    for (const row of HAT) expect(row).toMatch(/^[.hk]+$/);
    for (const row of HAT) expect(row).toHaveLength(HAT[0].length);
    // A brim wider than the crown is the least that reads as a hat.
    const width = (row: string) => row.replace(/\./g, "").length;
    expect(width(HAT.at(-1)!)).toBeGreaterThan(width(HAT[0]));

    // CENTRED ON THE HEAD, checked against the sprite rather than eyeballed.
    const headCols = [...SPRITE[4]].flatMap((c, i) => ("bes".includes(c) ? [i] : []));
    const headMid = (Math.min(...headCols) + Math.max(...headCols) + 1) / 2;
    expect(HAT_X + HAT[0].length / 2).toBe(headMid);
    // And the brim lands on the head's own top row, so it covers the forehead
    // rather than floating above it.
    const headTop = SPRITE.findIndex(r => r.includes("b"));
    expect(HAT_Y + HAT.length - 1).toBe(headTop);

    // DRAWN AFTER THE BODY, which is the opposite of the headphones and the
    // whole reason it is a separate group: they hide BEHIND the head, a brim
    // sits over the forehead.
    expect(component.indexOf('className="fm-hat"'))
      .toBeGreaterThan(component.indexOf('className="fm-body"'));
    expect(component.indexOf('className="fm-gear"'))
      .toBeLessThan(component.indexOf('className="fm-body"'));

    // THE TWO SWAP: the hat goes up as the headphones come down, which is what
    // makes it one exchange rather than two fades.
    expect(decl(".fm-hat", "opacity")).toBe("1");
    expect(decl(".fm-sprite[data-playing] .fm-hat", "opacity")).toBe("0");
    expect(decl(".fm-sprite[data-playing] .fm-hat", "transform")).toBe("translateY(-4px)");
    // The travel still overlaps — one rises as the other falls. It was only the
    // two FADES that had to be put in order.
    for (const sel of [".fm-hat", ".fm-sprite[data-playing] .fm-hat", ".fm-gear"]) {
      expect(decl(sel, "transition")).toContain("transform 460ms");
    }
    expect(decl(".fm-gear", "transform")).toContain("translateY(9px)");
    expect(decl(".fm-sprite[data-playing] .fm-gear", "opacity")).toBe("1");
    // Same grey as the headphones, because they are never both on — they are
    // told apart by shape, which is what a silhouette is for.
    expect(decl(".fm-hat", "fill")).toBe("var(--muted)");
    // NOT THE BODY'S COLOUR. A band in the same blue as the head reads as the
    // head showing THROUGH the hat rather than as a band on it, which is the
    // one thing a hat must never look like.
    expect(decl(".fm-hatband", "fill")).toBe("color-mix(in srgb, var(--muted) 40%, var(--fm-ink))");
    expect(decl(".fm-hatband", "fill")).not.toContain("var(--accent)");
    // And the crown sits flush on the band rather than leaving it poking out
    // either side like a second little brim.
    const solid = (row: string) => row.replace(/\./g, "").length;
    expect(solid(HAT[0])).toBe(solid(HAT[2]));
  });

  it("takes the headphones off when there is nothing to listen to", () => {
    // The one thing about this character that says whether anything is playing,
    // without a word or a colour. On its head with the music on, gone without.
    expect(decl(".fm-gear", "transform")).toBe("translateY(9px) rotate(-10deg)");
    expect(decl(".fm-gear", "opacity")).toBe("0");
    expect(decl(".fm-sprite[data-playing] .fm-gear", "transform")).toBe("translateY(0) rotate(0deg)");
    expect(decl(".fm-sprite[data-playing] .fm-gear", "opacity")).toBe("1");

    // GONE, NOT PARKED — and a drop alone could never do it. The body is drawn
    // over the headphones, so sliding them down hides whatever the body covers;
    // the arms reach out to columns 4-5 and 12-13 and cover most of each cup.
    // They do not reach column 3 or column 14, which is the OUTER edge of each
    // cup, so however far the headphones drop, a column of each one stays
    // visible at the side. That is what they used to do, and why the fade is
    // the part that finishes the job rather than a nicety on top of it.
    const bodyCols = new Set(
      SPRITE.flatMap(row => row.split("").flatMap((c, i) => (c === "b" || c === "e" || c === "s" ? [i] : []))));
    expect(bodyCols.has(3)).toBe(false);
    expect(bodyCols.has(14)).toBe(false);
    // The inner columns are covered, which is why a drop looked ALMOST right.
    expect(bodyCols.has(4)).toBe(true);
    expect(bodyCols.has(13)).toBe(true);

    // BUT IT STILL TAKES THEM OFF: the fade waits until the slide is underway,
    // so what is seen is a removal rather than a disappearance.
    const off = decl(".fm-gear", "transition") ?? "";
    expect(off).toContain("transform 460ms cubic-bezier(0.23, 1, 0.32, 1)");

    // THE ORDER OF THE EXCHANGE, which the first build had backwards on both
    // sides. Whatever is LEAVING goes at once; whatever is ARRIVING waits for
    // the other to clear. With the delays the wrong way round the character
    // wore a hat and a pair of headphones at the same time for a quarter of a
    // second, and what that looks like is the headphones appearing on top of
    // the hat in a single frame.
    //
    // A transition applies when moving TO a state, so the rule that carries the
    // delay is the one being moved to.
    const delayOf = (sel: string) =>
      Number(/opacity \d+ms linear (\d+)ms/.exec(decl(sel, "transition") ?? "")?.[1] ?? 0);
    const leaving = [".fm-gear", ".fm-sprite[data-playing] .fm-hat"];
    const arriving = [".fm-sprite[data-playing] .fm-gear", ".fm-hat"];
    for (const sel of leaving) expect(delayOf(sel), `${sel} is leaving`).toBe(0);
    for (const sel of arriving) expect(delayOf(sel), `${sel} is arriving`).toBeGreaterThan(0);
    // And the arriving one must not start before the leaving one has finished.
    const goneBy = (sel: string) =>
      Number(/opacity (\d+)ms linear/.exec(decl(sel, "transition") ?? "")?.[1] ?? 0);
    expect(delayOf(".fm-sprite[data-playing] .fm-gear")).toBeGreaterThanOrEqual(goneBy(".fm-sprite[data-playing] .fm-hat"));
    expect(delayOf(".fm-hat")).toBeGreaterThanOrEqual(goneBy(".fm-gear"));
    // On the sheet's own ease-out, not the back-out this wanted: #860 settled
    // that for the whole sheet after every tool bubble sprang past its size.
    expect(off).not.toMatch(/cubic-bezier\([^)]*,\s*1\.\d/);
    expect(css).not.toMatch(/\.fm-gear[^{]*\{[^}]*(display: none|visibility: hidden)/);

    // Which needs two groups: a transition and an animation on one transform do
    // not compose — the animation wins and the headphones would snap.
    expect(component).toContain('<g className="fm-gear">');
    expect(component).toContain('<g className="fm-gear-motion">');
    expect(component.indexOf('className="fm-gear"')).toBeLessThan(component.indexOf('className="fm-body"'));
  });

  it("draws the parts of itself that move outside its own box", () => {
    // The viewBox is the character's exact bounds with nothing spare, and an
    // SVG clips to its viewport by default — so the moment a dance lifted the
    // sprite, the top row went outside the box and was cut. What that looked
    // like was the headband vanishing at the top of every bounce.
    expect(decl(".fm-sprite svg", "overflow")).toBe("visible");
    // It is needed because the motion really does leave the box: the lift alone
    // is most of a row, and rotation swings the top of the sprite sideways too.
    const LIFT_UNITS = 0.85, ROT_DEG = 5.5;
    expect(LIFT_UNITS).toBeGreaterThan(0);
    const swing = SPRITE_H * Math.sin((ROT_DEG * Math.PI) / 180);
    expect(swing).toBeGreaterThan(1);
    // And the viewBox really is flush — no padding was added to absorb it.
    expect(component).toContain("`0 0 ${SPRITE_W} ${SPRITE_H}`");
  });

  it("pivots both groups about the same point, or they cannot stay together", () => {
    // THE SEAM. The gear and the body carry identical transforms, which is only
    // enough if they turn about the same centre. On `fill-box` each resolved
    // "50% 100%" against its OWN bounding box — the gear's ends at row 8, the
    // body's at row 13 — so the same rotate and the same scale were applied
    // about two points five rows apart, and the headband opened a seam along
    // the head as the character moved. It looked like a timing fault and was
    // not; two passes went looking in the wrong place.
    const pivot = ":is(.fm-gear, .fm-gear-motion, .fm-body, .fm-leg, .fm-hat)";
    expect(decl(pivot, "transform-box")).toBe("view-box");
    expect(decl(pivot, "transform-origin")).toBe("50% 100%");
    // EVERY GROUP THAT MOVES HAS TO BE IN THAT LIST. The legs were left out
    // once and it cost the same bug twice: they scale with the torso when it
    // dances, and on the default origin a leg scales about the middle of the
    // sprite while the torso scales about its feet — so the hip opens.
    const moving = [...new Set([...component.matchAll(/className="(fm-(?:body|leg|gear|gear-motion|hat))"/g)]
      .map(m => m[1]))];
    for (const g of moving) expect(pivot).toContain(`.${g}`);
    // Scoped to the groups that have to AGREE with each other. `fill-box` is
    // right for a lone shape turning about its own middle with nothing to stay
    // aligned to — `.fm-eye` narrowing is exactly that, and is the one rule
    // here allowed to use it.
    const fmRules = [...css.matchAll(/^([^{@}]*\.fm[\w-]*[^{}]*)\{([^}]*)\}/gm)]
      .filter(m => /(^|[\s,])\.fm[\w-]*/.test(m[1]))
      .filter(m => !/\.fm-eye\s*\{/.test(m[0]));
    expect(fmRules.length).toBeGreaterThan(5);
    for (const rule of fmRules) expect(rule[2]).not.toContain("fill-box");
    expect(decl(".fm-eye", "transform-box")).toBe("fill-box");
    expect(decl(".fm-eye", "transform-origin")).toBe("center");

    // And the boxes really are different, which is why fill-box could never
    // have worked here — this is the fact the rule above is protecting.
    const rowsWith = (cells: string) =>
      SPRITE.flatMap((row, y) => (row.split("").some(c => cells.includes(c)) ? [y] : []));
    const gearRows = rowsWith("acp");
    const bodyRows = rowsWith("bes");
    expect(Math.max(...gearRows)).not.toBe(Math.max(...bodyRows));
  });

  it("narrows its eyes only while it is looking at something", () => {
    // Worth far more as a moment than as a resting state — and an earlier build
    // also shifted them a column to say which way it was travelling, which was
    // on at every single moment, so the eyes were never simply open.
    // TWO DIFFERENT THINGS HAPPEN TO THESE EYES and they were briefly confused
    // for each other. Narrowing says it is looking at an object; shifting says
    // which way it is travelling. Removing the second left a symmetric sprite
    // where walking left and walking right are the same picture, and what that
    // reads as is the character reversing.
    // NOTHING ELSE HAPPENS TO THEM. Two earlier passes also shifted them a
    // column to say which way it was travelling, and both were wrong for the
    // same reason: the eyes were doing something at every moment, so they were
    // never simply open. Direction is carried by which side it holds things on.
    expect(decl(".fm-eye", "transform")).toBe("scaleY(var(--fm-eye-h, 1))");
    expect(css).not.toContain("--fm-eye-x");
    expect(MOVING_ACTS).toEqual(["walk", "carry"]);
    // Each is the character attending to an OBJECT: the litter it is bending
    // for, the ball it is about to send down the ledge, and whatever it is
    // aiming the scope at.
    expect([...FOCUS_ACTS].sort()).toEqual(["kick", "stoop", "watch", "windup"]);
    for (const act of FOCUS_ACTS) expect(isFocused(act)).toBe(true);
    // Walking is not among them: it walks with its eyes open.
    for (const act of ["walk", "carry", "sit", "toss", "fall", "peer"] as Act[]) {
      expect(isFocused(act)).toBe(false);
    }
    expect(isFocused(null)).toBe(false);

    // THE SHEET AND THE MODEL MUST NAME THE SAME ACTS. They are two lists of
    // the same fact in two languages, and the first thing adding `peer` to one
    // of them did was leave the other behind — so this reads the selector and
    // compares it to the model rather than restating either.
    const rule = /:is\(([^)]*)\) \.fm-eye \{\s*--fm-eye-h/.exec(css)?.[1] ?? "";
    const inSheet = [...rule.matchAll(/data-act="(\w+)"/g)].map(m => m[1]).sort();
    expect(inSheet).toEqual([...FOCUS_ACTS].sort());
    // Standing about is not concentrating, so the sheet must not narrow them
    // for it.
    const narrowing = [...css.matchAll(/:is\(([^)]*)\) \.fm-eye \{\s*--fm-eye-h/g)][0]?.[1] ?? "";
    expect(narrowing).toContain('data-act="watch"');
    expect(narrowing).not.toContain('data-act="sit"');
    expect(narrowing).not.toContain('data-act="walk"');
    // And it is a narrowing, not a shrink: the eye keeps its width.
    const h = /--fm-eye-h:\s*([\d.]+)/.exec(css)?.[1];
    expect(Number(h)).toBeGreaterThan(0);
    expect(Number(h)).toBeLessThan(1);
    expect(css).not.toMatch(/--fm-eye-w/);
    // Walking is never one of them, which is the whole of the rule now.
    expect(FOCUS_ACTS).not.toContain("walk");
    expect(FOCUS_ACTS).not.toContain("carry");
  });

  it("does not dance the same way twice in a row", () => {
    // One cycle repeated forever reads as a GIF. Picking uniformly would repeat
    // about a third of the time, and a repeat is indistinguishable from the loop
    // this exists to break.
    expect(DANCES.length).toBeGreaterThan(2);
    for (const current of DANCES) {
      for (let i = 0; i <= 20; i++) {
        const next = nextDance(current, () => i / 20);
        expect(next.dance).not.toBe(current);
        expect(DANCES).toContain(next.dance);
      }
    }
    // Null is where it starts, and anything is allowed then.
    expect(DANCES).toContain(nextDance(null, () => 0).dance);
  });

  it("drifts the tempo without leaving the band it belongs in", () => {
    for (let i = 0; i <= 20; i++) {
      const { beatMs } = nextDance("bob", () => i / 20);
      expect(beatMs).toBeGreaterThanOrEqual(Math.round(BEAT_MS * (1 - BEAT_DRIFT)));
      expect(beatMs).toBeLessThanOrEqual(Math.round(BEAT_MS * (1 + BEAT_DRIFT)));
    }
    // 1000ms is 60bpm, and the thing it is dancing to is calm.
    // 60bpm. At 75 it bobbed along ahead of the music: the character was
    // busier than anything it could have been listening to.
    expect(BEAT_MS).toBe(1000);
    expect(BEAT_DRIFT).toBeLessThan(0.15);
    expect(nextDanceMs(() => 0)).toBe(DANCE_MIN_MS);
    expect(nextDanceMs(() => 1)).toBe(DANCE_MAX_MS);
  });

  it("changes its mind only while something is playing", () => {
    // A timer running for a character standing still is a timer running for
    // nothing.
    expect(component).toContain("if (!playing || reducedMotion) { setDance(null); return; }");
  });

  it("listens to no audio, because it cannot", () => {
    // The player is a cross-origin iframe: the page cannot reach its audio
    // element, and a tainted source hands an analyser silence. Anything here
    // claiming to react to sound would be a lie told with a timer.
    for (const src2 of [component, code("../claude-fm.ts")]) {
      expect(src2).not.toMatch(/AnalyserNode|createMediaElementSource|getByteFrequency|getDisplayMedia/);
    }
  });

  it("settles a prop onto the ledge instead of blinking it into being", () => {
    expect(decl(".fm-prop", "animation")).toMatch(/^fm-settle 320ms/);
    expect(css).toMatch(/@keyframes fm-settle/);
    // The settle has to carry the position too, or the animation would snap the
    // litter back to the right-hand end for its duration.
    expect(css).toMatch(/@keyframes fm-settle \{[\s\S]*?translate\(calc\(var\(--fm-prop-x/);
    // Every keyframe that positions a prop has to carry the height too, or the
    // animation would drag it back to the floor for its duration.
    for (const frames of ["fm-settle", "fm-roll"]) {
      const block = new RegExp(`@keyframes ${frames} \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "";
      expect(block, frames).toContain("var(--fm-y)");
    }
  });

  it("stays fully visible with music off in either theme", () => {
    expect(decl(".fm-sprite", "opacity")).toBe("1");
    expect(decl(':root[data-theme="light"] .fm-sprite', "opacity")).toBeNull();
    // Both themes drive the same three tokens, so nothing is hard-coded to one
    // of them: the canvas shows through the eyes on either.
    expect(decl(".fm-body, .fm-leg", "fill")).toBe("var(--accent)");

    // EVERY GROUP THE SPRITE DRAWS HAS TO BE GIVEN A FILL. SVG's default is
    // black, so a group with no rule is not a group with a subtle colour — it
    // is a black hole in the character, which is exactly what splitting the
    // legs out of the body produced until this line existed.
    const groups = [...component.matchAll(/className="(fm-(?:body|leg|gear|gear-motion|hat))"/g)]
      .map(m => m[1]);
    expect(groups.length).toBeGreaterThan(2);
    for (const g of new Set(groups)) {
      if (g === "fm-gear-motion") continue;   // inside fm-gear, inherits it
      const painted = new RegExp(`(^|[\\s,])\\.${g}(,|\\s)[^{]*\\{[^}]*fill:`, "m").test(css)
        || decl(`.${g}`, "fill") != null;
      expect(painted, `.${g} is never given a fill`).toBe(true);
    }
    expect(decl(".fm-gear", "fill")).toBe("var(--muted)");
    // AN EYE IS A DARK MARK, NOT A HOLE. It used to be filled with --bg, the
    // canvas showing through — near-black in dark and near-WHITE in light, so
    // the light theme gave the character two blank sockets on a blue face. The
    // darkest ink is not the same token in both themes, because both flip.
    expect(decl(".fm-eye", "fill")).toBe("var(--fm-ink)");
    // ONE DARK INK, DECLARED ONCE ON THE SPRITE, because the eyes and the hat
    // band are the two marks on this character that both have to be darker than
    // everything around them, and two copies of that fact would drift.
    expect(decl(".fm-sprite", "--fm-ink")).toBe("var(--bg)");
    expect(decl(':root[data-theme="light"] .fm-sprite', "--fm-ink")).toBe("var(--text)");
    expect(decl(':root[data-theme="light"] .fm-sprite', "--accent")).toBe("var(--pixel-character-body)");
    // Blinking leaves a dark eyelid instead of erasing the face.
    const blink = /@keyframes fm-blink \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(blink).toContain("scaleY(0.35)");
    expect(blink).not.toContain("fill:");
    expect(blink).not.toContain("var(--bg)");
    expect(css).not.toMatch(/\.fm[\w-]*[^}]*#[0-9a-f]{3,6}/i);
  });

  it("dances only while the music is on", () => {
    // One rule per part, with WHICH dance carried as a custom property — so
    // adding a fourth costs a @keyframes block and nothing else, and the
    // reduced-motion block below keeps naming the same two selectors.
    // The sheet names every set it runs, in full. Driving `animation-name`
    // through a custom property was one rule instead of three and hid all three
    // from bubble-motion.test.ts — which exists to catch a @keyframes set
    // nothing runs, and an animation naming a set that is not there.
    // THE HEADPHONES RUN THE BODY'S OWN DANCE, 50ms behind. They used to run a
    // separate small nod — 1.2 degrees against a body swinging up to 5.5 — and
    // worn ON a head that does not read as two speeds, it reads as the head
    // sliding out of the headphones, which is what it did.
    for (const d of DANCES) {
      expect(css).toContain(`@keyframes fm-${d}`);
      const idle = `.fm-walker:not([data-act]) .fm-sprite[data-playing][data-dance="${d}"]`;
      // THE LEGS DANCE WITH THE TORSO, in phase. Walking they step
      // independently — that is what a stride is — but dancing happens on the
      // spot, so any difference between them is just the hip coming apart.
      expect(decl(`${idle} :is(.fm-body, .fm-leg)`, "animation"))
        .toBe(`fm-${d} var(--fm-beat, 800ms) ease-in-out infinite`);
      // EXACTLY the body's, with no offset. See below for why the lag went.
      expect(decl(`${idle} .fm-gear-motion`, "animation"))
        .toBe(decl(`${idle} :is(.fm-body, .fm-leg)`, "animation"));
    }
    // And the separate nod is gone rather than left lying around.
    expect(css).not.toContain("fm-nod");
    // No animation on the resting sprite at all.
    expect(decl(".fm-sprite", "animation")).toBeNull();
  });

  it("raises only the arms on hover or keyboard focus", () => {
    expect(component).toContain('className="fm-arms"');
    expect(decl('.fm-arms', 'transition')).toBe('transform 160ms steps(2, end)');
    expect(decl('.fm-sprite:is(:hover, :focus-visible) .fm-arms', 'transform')).toBe('translateY(-2px)');
  });

  it("bends to pick up objects without splaying or moving the feet", () => {
    expect(component).toContain('(act === "land" || act === "dismount")');
    expect(decl('.fm-walker[data-act="stoop"] .fm-sprite', 'animation')).toBeNull();
    expect(decl('.fm-walker[data-act="stoop"] :is(.fm-body, .fm-hat, .fm-gear-motion)', 'animation')).toBe('fm-stoop 720ms steps(2, end)');
    expect(decl('.fm-walker[data-act="stoop"] .fm-arms', 'animation')).toBe('fm-reach 720ms steps(2, end)');
    expect(component).not.toContain('H15V13');
  });

  it("uses the original development walking animation", () => {
    expect(css).toContain('.fm-walker[data-act="walk"]');
    // Carrying something is still walking.
    expect(css).toContain('.fm-walker[data-act="carry"]');
    expect(decl(':is(.fm-walker[data-act="walk"], .fm-walker[data-act="carry"]) .fm-leg[data-side="left"]', 'animation')).toBe('fm-stride-a 440ms linear infinite');
    expect(decl(':is(.fm-walker[data-act="walk"], .fm-walker[data-act="carry"]) .fm-leg[data-side="right"]', 'animation')).toBe('fm-stride-b 440ms linear infinite');
    expect(component).not.toContain('fm-walk-frames');

    // The curve is a compromise: pure linear starts and stops dead, a full ease
    // makes the middle race and the feet stop matching the ground. This is the
    // gentlest symmetric curve that keeps most of the trip near constant speed.
    expect(decl(".fm-walker", "transition")).toBe("transform var(--fm-walk-ms, 0ms) cubic-bezier(0.32, 0, 0.68, 1)");
    expect(decl(".fm-walker", "transform")).toBe("translate(var(--fm-x, 0px), var(--fm-y))");
  });

  it("goes about its business whether or not the music is on", () => {
    // Holding the errands back while something played made the character least
    // alive exactly when it was most looked at: it stood on one spot and danced
    // for as long as the track ran. It wears the headphones and gets on with it.
    expect(component).toContain("if (!probe || dead) return;");
    expect(component).not.toContain("dead || playing");
    // And the dance fills the gaps rather than replacing the errands, which is
    // what `:not([data-act])` on every dance rule is for.
    for (const d of DANCES) {
      expect(css).toContain(`.fm-walker:not([data-act]) .fm-sprite[data-playing][data-dance="${d}"]`);
    }
    // And it asks about reduced motion where the answer lives, rather than
    // hiding the movement behind a media query that leaves timers running for
    // a journey nobody sees.
    expect(component).toContain('window.matchMedia?.("(prefers-reduced-motion: reduce)").matches');
    // Every trip lands on the ledge: the span is the minimap's width less the
    // character's own, so it is standing on the edge at both ends.
    let at = 0;
    for (let i = 0; i < 400; i++) {
      const trip = nextWalk(at, () => (i * 0.017) % 1);
      expect(trip.to).toBeLessThanOrEqual(0);
      expect(trip.to).toBeGreaterThanOrEqual(-WALK_SPAN_PX);
      expect(trip.ms).toBe(Math.round(Math.abs(trip.to - at) * WALK_MS_PER_PX));
      at = trip.to;
    }
  });

  it("takes a trip worth taking, or none", () => {
    // Without a floor the random walk spends most of its time shuffling a few
    // pixels, which reads as a twitch rather than as a stroll.
    expect(nextWalk(-40, () => 0.27).to).not.toBe(-40);
    expect(Math.abs(nextWalk(-40, () => 0.27).to + 40)).toBeGreaterThanOrEqual(WALK_MIN_STEP_PX);
    // At the far end it has to turn round rather than push past the edge.
    expect(nextWalk(-WALK_SPAN_PX, () => 1).to).toBeGreaterThan(-WALK_SPAN_PX);
    expect(nextWalk(0, () => 0).to).toBeLessThan(0);
  });

  it("puts the ledge and the things on it in one place that does not move", () => {
    // A thing lying on the floor does not travel with whoever is about to pick
    // it up. When the walk lived on the scene itself, everything standing on
    // the ledge moved with the character — which is one way to find out that a
    // floor is not a vehicle.
    expect(decl(".fm", "width")).toBe("var(--minimap-w)");
    expect(decl(".fm", "--minimap-w")).toBe("202px");
    expect(decl(".fm", "transform")).toBeNull();
    expect(decl(".fm-walker, .fm-prop", "position")).toBe("absolute");
    // 21px is what centres a 12px object under a 54px one when both are
    // right-aligned: without it the stoop reaches for nothing.
    expect(decl(".fm-prop", "transform")).toBe("translate(calc(var(--fm-prop-x, 0px) - 21px), var(--fm-y))");
    expect((54 - 12) / 2).toBe(21);
  });

  it("falls under gravity rather than for a chosen number of milliseconds", () => {
    // t = sqrt(2h/g), which is what makes it read as a fall at ANY height
    // rather than only at the one it was tuned on. A taller ledge falls for
    // longer on its own.
    for (const h of [80, 152, 240]) {
      expect(fallMsFor(h)).toBe(Math.round(1000 * Math.sqrt((2 * h) / FALL_G)));
    }
    expect(fallMsFor(240)).toBeGreaterThan(fallMsFor(152));
    // Doubling the height does NOT double the time — that is the whole
    // difference between falling and sliding.
    expect(fallMsFor(304) / fallMsFor(152)).toBeCloseTo(Math.SQRT2, 1);
    // And over this deck's ledge it lands somewhere with weight in it.
    expect(fallMsFor(152)).toBeGreaterThan(300);
    expect(fallMsFor(152)).toBeLessThan(700);
  });

  it("accelerates downward and climbs at a steady rate", () => {
    // Everything else on this canvas eases OUT, because everything else is a
    // thing settling into place. A falling body does the opposite, and a fall
    // that eases out reads as being lowered on a wire.
    const fall = decl('.fm-walker[data-act="fall"]', "transition") ?? "";
    expect(fall).toContain("cubic-bezier(0.11, 0, 0.5, 0)");
    const [, y1, , y2] = /cubic-bezier\(([^)]*)\)/.exec(fall)![1].split(",").map(Number);
    expect(y1).toBe(0);           // starts at rest
    expect(y2).toBeLessThan(0.5); // and is still gaining when it lands
    // Going up is work at a steady rate, not the fall run backwards.
    expect(decl('.fm-walker[data-act="climb"]', "transition")).toContain("linear");
    expect(climbMsFor(152)).toBeGreaterThan(fallMsFor(152) * 2);
  });

  it("looks before it steps off, and absorbs when it arrives", () => {
    // Nothing sensible jumps from a height it has not looked at.
    expect(decl('.fm-walker[data-act="peer"] .fm-sprite', "transform")).toBe("translateX(-3px)");
    // A body that arrives at speed and stops dead did not land, it was placed.
    // This is the deepest squash in the block because it is the only impact.
    const land = decl('.fm-walker[data-act="land"] .fm-sprite', "transform") ?? "";
    expect(land).toBe("translateY(3px)");
    expect(component).toContain('className="fm-crouch-legs"');
  });

  it("always comes home, and never plans a trip it cannot measure", () => {
    const ground = { ledgeH: 152, floorSpan: 900 };
    const steps = leaveLedgeSteps(-20, ground, () => 0.5);
    expect(steps.map(s2 => s2.act)).toEqual(
      ["walk", "peer", "fall", "land", "walk", "walk", "walk", "lasso", "rope-throw", "rope-catch", "climb", "pull-up"]);
    // The character stays grounded until the hook has landed and taken weight.
    const throwAt = steps.findIndex(step => step.act === "rope-throw");
    expect(steps[throwAt].place).toBe("floor");
    expect(steps[throwAt + 1].act).toBe("rope-catch");
    expect(steps[throwAt + 1].place).toBe("floor");
    expect(steps[throwAt + 1].ms).toBeGreaterThanOrEqual(200);
    // It ends ON THE LEDGE. Anything else strands the character on the canvas
    // floor with nothing scheduled to bring it back.
    expect(steps.at(-1)?.place).toBeUndefined();
    expect(steps.filter(s2 => s2.place === "floor").length).toBeGreaterThan(0);
    // It goes down and comes up at the same corner: a rope thrown at the ledge
    // has to catch something, and that corner is the only part it just left.
    expect(steps[2].x).toBe(steps.at(-1)!.x);
    // The fall and the climb are the measured height, not a guess.
    expect(steps[2].ms).toBe(fallMsFor(152));
    expect(steps.find(step => step.act === "climb")!.ms).toBe(climbMsFor(152));
    expect(steps.at(-1)!.act).toBe("pull-up");

    // WITHOUT THE GROUND IT DOES NOT GO. A trip planned against a guessed
    // height would drop the character through the floor or leave it hanging.
    for (const bad of [undefined, { ledgeH: 0, floorSpan: 900 }, { ledgeH: 152, floorSpan: 0 }]) {
      for (let i = 0; i <= 30; i++) {
        const acts = nextActivity(0, () => i / 30, bad).map(s2 => s2.act);
        expect(acts).not.toContain("fall");
      }
    }
  });

  it("stays inside the canvas when the window shrinks mid-trip", () => {
    // A trip is planned in one go against the floor it measured at the time,
    // and then takes the better part of ten seconds to walk. Narrow the window
    // in the middle of one and those targets are off the left edge of a canvas
    // that no longer reaches them — the character would walk out of the deck
    // and come back from nowhere.
    expect(component).toContain("const reachable = (step: Step): number =>");
    expect(component).toContain("Math.max(-room, Math.min(0, step.x))");
    // Applied to every step, not only the floor ones.
    expect(component).toContain("const to = reachable(step);");
    expect(component).not.toMatch(/setX\(step\.x\)/);
    // The ledge keeps its own fixed span; only the floor is measured.
    expect(component).toMatch(/\(step\.place \?\? "ledge"\) === "floor"/);

    // Clamping per step rather than re-planning keeps the trip's shape: it
    // still goes down and comes back up at the same corner, and that corner is
    // inside any canvas wide enough to have shown the minimap at all.
    const steps = leaveLedgeSteps(0, { ledgeH: 152, floorSpan: 900 }, () => 0.9);
    const corner = steps.find(s2 => s2.act === "fall")!.x;
    expect(corner).toBe(-WALK_SPAN_PX);
    expect(Math.abs(corner)).toBeLessThanOrEqual(WALK_SPAN_PX);
  });

  it("hangs the rope from the ledge, not from the character", () => {
    // A rope that travelled with whoever was climbing it would be a rope
    // climbing itself.
    expect(component).toMatch(/\{\(act === "lasso" \|\| act === "rope-throw" \|\| act === "rope-catch" \|\| act === "climb" \|\| act === "pull-up"\) && \(/);
    const ropeAt = component.indexOf('className="fm-rope"');
    const walkerAt = component.indexOf('className="fm-walker"');
    expect(ropeAt).toBeGreaterThan(-1);
    expect(ropeAt).toBeLessThan(walkerAt);
    // It reaches exactly the height being climbed.
    expect(decl('.fm-rope[data-act="climb"]', "height")).toBe("var(--minimap-h)");
    // 25.5px is the sprite's middle: 54px wide, right-aligned, rope 3px.
    expect(decl(".fm-rope", "transform")).toBe("translateX(calc(var(--fm-rope-x, 0px) - 25.5px))");
    expect(54 / 2 - 3 / 2).toBe(25.5);
  });

  it("does the errand in steps that can be read without a clock", () => {
    const steps = tidySteps(-100, -20);
    expect(steps.map(s2 => s2.act)).toEqual(["walk", "stoop", "carry", "windup", "toss"]);
    // It walks to the litter, not past it.
    expect(steps[0].x).toBe(-20);
    expect(steps[0].ms).toBe(walkMsFor(-100, -20));
    // The litter leaves the ledge when it is picked up — the END of the stoop,
    // not the start of it.
    expect(steps[1].prop?.held).toBeFalsy();
    expect(steps[2].prop?.held).toBe(true);
    // And it is carried to the one spot on the ledge nothing else stands on.
    expect(steps[2].x).toBe(BIN_X);
    expect(steps.at(-1)?.x).toBe(BIN_X);
    // The throw is a beat after arriving: a character that arrives and tosses
    // in one motion reads as dropping something.
    expect(steps[3].act).toBe("windup");
    expect(steps[3].ms).toBe(TOSS_WINDUP_MS);
  });

  it("puts a prop somewhere worth walking to, always on the ledge", () => {
    let at = 0;
    for (let i = 0; i < 400; i++) {
      const spot = propSpot(at, () => (i * 0.023) % 1);
      expect(spot).toBeLessThanOrEqual(0);
      expect(spot).toBeGreaterThanOrEqual(-WALK_SPAN_PX);
      expect(Math.abs(spot - at)).toBeGreaterThanOrEqual(WALK_MIN_STEP_PX);
      at = spot;
    }
  });

  it("leaves nothing behind when it is interrupted", () => {
    // Music starting mid-errand tears the effect down. A piece of litter left
    // on the ledge that nothing will ever come back for is the one way this can
    // litter for real.
    expect(component).toMatch(/return \(\) => \{[\s\S]*?setAct\(null\);[\s\S]*?setProp\(null\);/);
  });

  it("keeps walking the usual thing and the rest the surprise", () => {
    // A character that only ever walks is a screensaver; one that is always
    // doing a bit is a distraction. Walking stays the largest single share, and
    // every other activity stays small enough that finding it mid-errand is a
    // surprise rather than the expected state.
    const total = ACTIVITIES.reduce((n, a) => n + a.weight, 0);
    const stroll = ACTIVITIES.find(a => a.kind === "stroll")!;
    expect(stroll.weight / total).toBeGreaterThan(0.3);
    for (const a of ACTIVITIES) {
      if (a.kind === "stroll") continue;
      expect(a.weight / total).toBeLessThan(0.25);
      expect(a.weight).toBeGreaterThan(0);
    }
  });

  it("can reach every activity, and only the ones it has", () => {
    const seen = new Set<string>();
    for (let i = 0; i <= 200; i++) seen.add(pickActivity(() => i / 200));
    expect([...seen].sort()).toEqual(ACTIVITIES.map(a => a.kind).slice().sort());
  });

  it("goes over what is standing on the floor, not through it", () => {
    // The deck's controls sit on the canvas floor and the character walks along
    // it. Without this it strolls straight through the Auto-fit chip as though
    // the chip were a picture of one.
    const bar = { left: -600, right: -400, height: 36 };

    // Walking right, into it from the left-hand side.
    const over = crossSteps(-800, -200, bar);
    expect(over.map(st => st.act)).toEqual(["walk", "mount", "walk", "dismount", "walk"]);
    expect(over[0].x).toBe(bar.left);        // up to the near edge
    expect(over[1].riser).toBe(bar.height);  // on top of it
    expect(over[2].x).toBe(bar.right);       // across
    expect(over[3].riser).toBeUndefined();   // and back down
    expect(over.at(-1)!.x).toBe(-200);
    expect(over.every(st => st.place === "floor")).toBe(true);

    // And from the other side, it meets the other edge first.
    const back = crossSteps(-200, -800, bar);
    expect(back[0].x).toBe(bar.right);
    expect(back[2].x).toBe(bar.left);
    expect(back.at(-1)!.x).toBe(-800);
  });

  it("walks straight when there is nothing in the way", () => {
    const bar = { left: -600, right: -400, height: 36 };
    // No chip on the page at all — the usual case, since it only exists while
    // auto-fit is off.
    expect(crossSteps(-800, -200, null)).toHaveLength(1);
    // A walk that never reaches it, on either side.
    expect(crossSteps(-300, -100, bar)).toHaveLength(1);
    expect(crossSteps(-900, -700, bar)).toHaveLength(1);
    // And something with no height is not an obstacle.
    expect(crossSteps(-800, -200, { ...bar, height: 0 })).toHaveLength(1);
  });

  it("steps up and drops down, which are not the same motion", () => {
    // Getting onto something is a step and it settles; stepping off is a drop
    // and it accelerates — on the very same curve as the fall from the ledge,
    // because it is the same thing over a shorter distance.
    expect(decl('.fm-walker[data-act="mount"]', "transition")).toContain("cubic-bezier(0.23, 1, 0.32, 1)");
    const down = decl('.fm-walker[data-act="dismount"]', "transition") ?? "";
    const fall = decl('.fm-walker[data-act="fall"]', "transition") ?? "";
    expect(/cubic-bezier\([^)]*\)/.exec(down)?.[0]).toBe(/cubic-bezier\([^)]*\)/.exec(fall)?.[0]);
    // The riser is what the height is carried on.
    expect(decl('.fm-walker[data-place="floor"]', "--fm-y")).toBe("calc(-1 * var(--fm-riser, 0px))");
  });


  it("takes strides rather than hopping", () => {
    // A body that rises and falls with its legs welded on is a hop. The two
    // legs run the same cycle half a beat apart, so one is always forward while
    // the other is back — which is the whole of what makes a walk a walk.
    // OPPOSITE PHASE, which is the whole point: the poses are the same two, in
    // the other order. Compared as poses rather than as lines, since the same
    // pose is written under a different percentage in each set.
    const poses = (name: string) => {
      const block = new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "";
      return [...block.matchAll(/\{\s*transform:\s*([^;]+);/g)]
        .map(m => m[1].replace(/\s+/g, " ").trim());
    };
    const a = poses("fm-stride-a"), b = poses("fm-stride-b");
    expect(a).toHaveLength(2);
    expect(a).toEqual([...b].reverse());
    expect(a[0]).not.toBe(a[1]);

    // THEY STEP, THEY DO NOT SWING. Rotating each leg about its hip is how a
    // leg works and is wrong at this size: a cell is three pixels, and fifteen
    // degrees moves the foot of a three-row leg 2.33px — between pixels, so the
    // edge is drawn half-lit and the leg reads as torn rather than angled.
    for (const pose of [...a, ...b]) {
      expect(pose).not.toContain("rotate");
      // And the step is a whole cell, so every edge lands on the grid.
      const dy = /translateY\((-?[\d.]+)px\)/.exec(pose)?.[1] ?? "0";
      expect(Number.isInteger(Number(dy))).toBe(true);
    }
    // And the legs really are the bottom rows, split down the middle.
    const below = SPRITE.slice(LEG_TOP_ROW).join("");
    expect(below).toContain("b");
    expect(SPRITE[LEG_TOP_ROW - 1]).not.toBe(SPRITE[LEG_TOP_ROW]);
  });

  it("climbs in pulls, not as a glide", () => {
    // The rise is linear because a rope is climbed at a steady rate. Nothing
    // about the body doing it is smooth: it gathers, pulls, and reaches again.
    expect(decl('.fm-walker[data-act="climb"] .fm-sprite', "animation")).toBe("fm-haul 620ms steps(2, end) infinite");
    expect(css).toMatch(/@keyframes fm-haul/);
    // Slower than the walk — hauling your own weight is not a stroll, and the
    // cadence is most of what says so.
    const stride = 440;
    const haul = /fm-haul (\d+)ms/.exec(css)?.[1];
    expect(Number(haul)).toBeGreaterThan(Number(stride));
    // The rise underneath it stays linear.
    expect(decl('.fm-walker[data-act="climb"]', "transition")).toContain("linear");
  });

  it("carries a held thing on the side it is facing", () => {
    // Held on the left while walking right, an object trails behind the
    // character — the other half of what made it look like it was going
    // backwards.
    expect(decl(".fm-held", "right")).toBe("42px");
    expect(decl('.fm-walker[data-facing="right"] .fm-held', "right")).toBe("0");
    // 54px sprite less a 12px object puts the far side at 0; the scope is 15px
    // wide, so its mirror is 5.
    expect(54 - 42 - 12).toBe(0);
    expect(decl('.fm-walker[data-facing="right"] .fm-held[data-prop="scope"]', "right")).toBe("5px");
    expect(54 - 34 - 15).toBe(5);
  });

  it("never ends a step before the animation that step started", () => {
    // THE CLASS OF BUG, not just the one instance. A step's `ms` is how long the
    // component holds that state; when it ends, the element carrying the
    // animation unmounts. `kick` ran for 480ms and started a 520ms roll, so the
    // ball was taken off the canvas forty milliseconds before it landed and
    // vanished in mid-flight. `stoop` and `toss` happened to match exactly, and
    // nothing pointed at the one that had drifted because each number looked
    // reasonable on its own.
    const animMs = (selector: string) => {
      const value = decl(selector, "animation") ?? "";
      return Number(/(\d+)ms/.exec(value)?.[1] ?? NaN);
    };
    const pairs: [string, number, string][] = [
      ['.fm-walker[data-act="stoop"] :is(.fm-body, .fm-hat, .fm-gear-motion)', STOOP_MS, "stoop"],
      [".fm-held[data-toss]", TOSS_MS, "toss"],
    ];
    for (const [selector, stepMs, name] of pairs) {
      const anim = animMs(selector);
      expect(Number.isFinite(anim), `${name} has an animation to measure`).toBe(true);
      expect(stepMs, `${name}: the step must outlast its own animation`).toBeGreaterThanOrEqual(anim);
    }
  });

  it("brings a held thing into hand rather than switching it on", () => {
    // Nothing in this scene should appear at full size in one frame — the scope
    // worst of all, because nothing precedes it: one frame the character is
    // standing there, the next it is holding a telescope.
    expect(decl(".fm-held", "animation")).toMatch(/^fm-draw 300ms/);
    expect(css).toMatch(/@keyframes fm-draw/);
    // And a prop on its way out overrides that rather than fighting it, which
    // is what the extra attribute in the selector buys.
    expect(decl(".fm-held[data-toss]", "animation")).toMatch(/^fm-toss/);
  });

  it.each([[0, -90, "left"], [-140, -30, "right"]] as const)(
    "kicks from %s toward %s with the ball in front of the foot", (from, at, direction) => {
      const steps = kickSteps(from, at);
      let x = from;
      let facing: "left" | "right" = "right";
      for (const step of steps) {
        facing = facingFor(step, x, facing);
        x = step.x;
      }
      expect(facing).toBe(direction);
      expect(Math.abs(x - at)).toBe(15);
      expect(Math.sign(at - x)).toBe(direction === "right" ? 1 : -1);
      expect(steps[0].ms).toBe(walkMsFor(from, x));
      expect(steps[2].facing).toBe(direction);
      expect(steps[3].prop).toEqual(steps[2].prop);
      expect(steps[2].ms + steps[3].ms).toBe(BALL_FLIGHT_MS);
    },
  );

  it.each([320, 768, 1500])("keeps the flying ball visible until it drops at viewport width %s", width => {
    for (let at = 18; at <= width - 18; at++) {
      for (const facing of ["left", "right"] as const) {
        const travel = ballRollTo(at, facing, width);
        expect(travel * (facing === "right" ? 1 : -1)).toBeGreaterThanOrEqual(0);
        expect(at + travel).toBeGreaterThanOrEqual(18);
        expect(at + travel).toBeLessThanOrEqual(width - 18);
        expect(Math.abs(travel)).toBeLessThanOrEqual(BALL_ROLL_PX);
      }
    }
  });

  it("packs away fishing equipment before standing and walking again", () => {
    for (const from of [-148, 0]) for (const at of [-148, -60, 0]) {
      const steps = fishSteps(from, at, () => 0.5);
      expect(steps.map(step => step.act)).toEqual([
        "walk", "sit", "cast", "fish", "reel", "stow", "stand", "walk",
      ]);
      const seated = steps.slice(1, -1);
      expect(seated.every(step => step.x === steps[0].x)).toBe(true);
      expect(seated.every(step => facingFor(step, step.x, "right") === "left")).toBe(true);
      expect(steps.every(step => step.prop === null && step.ms > 0)).toBe(true);
      expect(steps.at(-1)?.x).toBe(0);
      expect(steps[3].ms).toBeGreaterThanOrEqual(6000);
      // The rod reaches 108px left of the walker's right edge, within a 202px ledge.
      expect(steps[0].x - 108).toBeGreaterThanOrEqual(-202);
    }
  });

  it("finishes whole rope revolutions, puts the rope away, then walks", () => {
    for (const random of [0, 0.5, 0.999]) {
      const steps = skipSteps(0, -148, () => random);
      expect(steps.map(step => step.act)).toEqual([
        "walk", "skip-ready", "skip", "skip-rest", "stand", "walk",
      ]);
      expect(steps[2].ms % SKIP_BEAT_MS).toBe(0);
      expect(steps[2].ms / SKIP_BEAT_MS).toBeGreaterThanOrEqual(6);
      expect(steps[2].ms / SKIP_BEAT_MS).toBeLessThanOrEqual(10);
      expect(steps.slice(1, -1).every(step => step.x === steps[0].x)).toBe(true);
      expect(steps.at(-1)?.x).toBe(0);
    }
  });

  it("sends the ball down the ledge instead of tidying it", () => {
    // The same errand with the opposite ending — and the ball never leaves the
    // floor, which is the one structural difference and why both fit one shape.
    const steps = kickSteps(-30, -90);
    expect(steps.map(s2 => s2.act)).toEqual(["walk", "windup", "kick", "stand"]);
    expect(steps.every(s2 => !s2.prop?.held)).toBe(true);
    expect(steps.at(-1)?.prop?.leaving).toBe(true);
    // It stays where it was kicked from; the ball is what travels.
    expect(steps.every(s2 => s2.x === -75)).toBe(true);
    expect(steps.every(s2 => s2.prop?.at === -90)).toBe(true);
  });

  it("places the hips on the ledge with a separate seated silhouette", () => {
    const drop = Number(/translateY\((\d+)px\)/.exec(
      decl('.fm-walker[data-act="sit"] .fm-sprite', "transform") ?? "")?.[1]);
    // Counted off the sprite, not assumed: the legs got a row longer once
    // already and this number had to move with them.
    const legRows = SPRITE.length - LEG_TOP_ROW;
    const legHeight = legRows * (54 / SPRITE_W);
    expect(drop).toBe(legHeight);
    // A separately drawn bent-knee silhouette replaces the standing legs.
    expect(component).toContain('className="fm-seated-legs"');
    // Straight, two-cell shins and flat toes, with the near foot one row lower.
    expect(component).toContain('d="M10 10H12V11H11V14H8V13H9V11H10Z"');
    expect(component).toContain('d="M6 10H9V11H7V15H4V14H5V11H6Z"');
    expect(component).toContain('className="fm-seated-far"');
    expect(decl('.fm-walker[data-act="sit"] .fm-sprite', "transform")).not.toContain("scale");
  });

  it("walks somewhere before it sits, and sits for a while", () => {
    // Sitting down on the spot it is already standing on reads as falling over.
    const steps = sitSteps(-10, -80, () => 0.5);
    expect(steps.map(s2 => s2.act)).toEqual(["walk", "sit", "stand"]);
    expect(steps[0].ms).toBe(walkMsFor(-10, -80));
    expect(steps[1].ms).toBeGreaterThan(steps[0].ms);
    expect(steps[1].prop).toBeNull();
  });

  it("takes out a scope and looks at the board", () => {
    // The one activity that is ABOUT the canvas rather than about the ledge.
    const steps = watchSteps(0, -60, () => 0.5);
    expect(steps.map(s2 => s2.act)).toEqual(["walk", "watch", "scope-pack", "stand"]);
    expect(steps[2].prop).toEqual(steps[1].prop);
    expect(steps[3].prop).toBeNull();
    expect(steps[1].prop?.kind).toBe("scope");
    expect(steps[1].prop?.held).toBe(true);
    // Held at the eyes and pointed away from the minimap, or the pose reads as
    // carrying a stick.
    // HELD AT THE EYES, and the eyes move when the sprite grows. Derived here
    // rather than pinned, because this number is "where row four is" and the
    // last time the legs got a row longer it silently stopped being that.
    const CELL = 54 / SPRITE_W;
    const eyeRow = SPRITE.findIndex(r => r.includes("e"));
    const eyeFromFloor = (SPRITE_H - 1 - eyeRow) * CELL;
    const scopeBottom = parseFloat(decl('.fm-held[data-prop="scope"]', "bottom") ?? "");
    const scopeCell = parseFloat(decl('.fm-held[data-prop="scope"]', "width") ?? "") / PROP_ART.scope[0].length;
    const scopeH = PROP_ART.scope.length * scopeCell;
    expect(scopeBottom).toBe(0);
    // Eyepiece rows 9–10, not merely the whole image, must meet the eye.
    expect(scopeH - 11 * scopeCell).toBeLessThanOrEqual(eyeFromFloor);
    expect(scopeH - 9 * scopeCell).toBeGreaterThanOrEqual(eyeFromFloor + CELL);
    expect(scopeBottom).toBeLessThanOrEqual(eyeFromFloor);
    expect(scopeBottom + scopeH).toBeGreaterThanOrEqual(eyeFromFloor + CELL);
    expect(decl(".fm-held", "bottom")).toBe("3px");
    // AND IT HAS TO TOUCH THE FACE. At 46px it sat ten pixels clear of the head
    // and read as floating beside the character: the arms are two rows from the
    // bottom, so there is nothing at eye height for a hand to be, and the
    // overlap has to do the work the arm cannot.
    expect(decl('.fm-held[data-prop="scope"]', "right")).toBe("34px");
    const SPRITE_PX = 54;   // CELL is already in hand from the eye maths above
    const farEnd = SPRITE_PX - 34;             // the end nearest the face
    const headStartsAt = 6 * CELL;             // body columns begin at 6
    expect(farEnd).toBeGreaterThan(headStartsAt);
    expect(farEnd).toBeLessThan(7 * CELL);     // and stops short of the eye
  });

  it("gives every prop rectangular pixel art with a supported palette", () => {
    for (const kind of ["litter", "ball", "scope"] as const) {
      const art = PROP_ART[kind];
      expect(art.length).toBeGreaterThan(1);
      const w = art[0].length;
      for (const row of art) expect(row).toHaveLength(w);
      for (const row of art) expect(row).toMatch(/^[.xsla]+$/);
    }
    // A character tidying away an identifiable thing invites the question of
    // what it was, and the answer is nothing.
    expect(PROP_ART.litter).not.toEqual(PROP_ART.ball);
  });

  it("keeps the telescope silver instead of inverting its barrel with theme text", () => {
    const scope = '.fm-held[data-prop="scope"]';
    expect(decl(scope, "--fm-prop-light")).toBe("var(--pixel-metal-light)");
    expect(decl(scope, "--fm-prop-shadow")).toBe("var(--pixel-metal-shadow)");
    expect(decl(`${scope} svg`, "fill")).toBe("var(--pixel-metal-edge)");
  });

  it("moves the headphones with the body when they are not on the head", () => {
    // Secondary motion is right ON the head — a thing worn loosely follows what
    // it is worn on, which is what the dance's 90ms is. Round the neck they are
    // resting against the chest, and the same delay made them visibly trail the
    // body on every step.
    // Nothing runs on the torso or the headphones while it walks at all now.
    expect(css).not.toContain("fm-step");
    // AND NO DELAY EITHER, which a thirteen-row sprite leaves no room for.
    // groove lifts 0.85 units; at the steepest part of the bounce that is
    // 0.02px per millisecond, so even fifty milliseconds puts the body a whole
    // pixel above the headphones — and the band is one row, three pixels, so a
    // pixel of separation is a third of it. What that looks like is the head
    // sinking into the headphones. Things on a head do not lag behind it.
    const idleSel = '.fm-walker:not([data-act]) .fm-sprite[data-playing][data-dance="bob"]';
    expect(decl(`${idleSel} .fm-gear-motion`, "animation"))
      .toBe(decl(`${idleSel} :is(.fm-body, .fm-leg)`, "animation"));
    expect(css).not.toMatch(/\.fm-gear-motion \{\s*animation:[^;]*-\d+ms/);
    const LIFT_UNITS = 0.85, CELL_PX = 54 / SPRITE_W, BEAT = 800;
    const pxPerMs = (LIFT_UNITS * CELL_PX * 2 * Math.PI) / BEAT;
    expect(pxPerMs * 50).toBeGreaterThan(CELL_PX / 3);
  });

  it("rolls a kicked ball away from the end it would otherwise pile up at", () => {
    expect(decl('.fm-prop[data-prop="ball"][data-leaving]', "animation")).toBe('fm-roll var(--fm-ball-flight-ms) linear forwards');
    expect(css).toMatch(/@keyframes fm-roll/);
    // Negative: down the ledge, away from the bin corner.
    // THE SIGN IS THE FACING'S, and only the distance is fixed. This rolled a
    // hardcoded -132px, which is right exactly half the time: approach the ball
    // from the left and the kick sent it backwards, straight through the
    // character that had just kicked it.
    expect(css).toContain("var(--fm-ball-drop)");
    expect(css).not.toMatch(/- 21px - 132px/);
    expect(component).toContain('ballRollTo(ball.x, facingFor(step, from, "left"), window.innerWidth)');
    expect(BALL_ROLL_PX).toBe(420);
    const frames = /@keyframes fm-roll \{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(frames).toBeTruthy();
    expect(frames).not.toContain('opacity');
    expect(BALL_FLIGHT_MS).toBeGreaterThan(KICK_MS * 2);
  });

  it("rests between things without going quiet enough to look broken", () => {
    // This once asserted that it stands still far longer than it walks, which
    // was the right property when walking was the only thing it did: the worry
    // was a monitoring deck with something twitching in the corner of it.
    //
    // With five activities and most of them worth seeing, that same restraint
    // stopped protecting the deck and started hiding the feature — forty
    // seconds of nothing meant somebody could watch for a minute and conclude
    // it was a static image. What is worth pinning now is the band either side:
    // there is always a visible rest, and the wait is never long enough to read
    // as "this does not move".
    expect(WALK_IDLE_MIN_MS).toBeGreaterThanOrEqual(5_000);
    expect(WALK_IDLE_MAX_MS).toBeLessThanOrEqual(20_000);
    // The rest has to be a rest: longer than the quickest thing it does, or the
    // errands would run into each other with no beat between them.
    expect(WALK_IDLE_MIN_MS).toBeGreaterThan(STOOP_MS + TOSS_MS);
    // A range rather than a number, so two decks side by side do not step in time.
    expect(WALK_IDLE_MAX_MS).toBeGreaterThan(WALK_IDLE_MIN_MS * 1.5);
    expect(nextIdleMs(() => 0)).toBe(WALK_IDLE_MIN_MS);
    expect(nextIdleMs(() => 1)).toBe(WALK_IDLE_MAX_MS);
  });

  it("holds still for somebody who asked for no motion", () => {
    // A character dancing in the corner of a monitoring tool is exactly the
    // motion this setting is turned on to stop.
    const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g;
    const blocks = [...css.matchAll(reduce)].map(m => m[1]).join("\n");
    // All of it: the dance, the walk and the press.
    for (const gone of [
      '.fm-walker:not([data-act]) .fm-sprite[data-playing][data-dance="bob"] :is(.fm-body, .fm-leg)',
      '.fm-walker:not([data-act]) .fm-sprite[data-playing][data-dance="bob"] .fm-gear-motion',
      '.fm-walker:not([data-act]) .fm-sprite[data-playing][data-dance="groove"] .fm-gear-motion',
      ':is(.fm-walker[data-act="walk"], .fm-walker[data-act="carry"]) .fm-body',
      ':is(.fm-walker[data-act="walk"], .fm-walker[data-act="carry"]) .fm-gear-motion',
      '.fm-walker[data-act="stoop"] :is(.fm-body, .fm-hat, .fm-gear-motion)',
      '.fm-walker[data-act="stoop"] .fm-arms',
      ".fm-prop",
      ".fm-held[data-toss]",
      ".fm-eye",
    ]) expect(blocks).toContain(gone);
    expect(blocks).toMatch(/animation: none/);
    expect(blocks).toMatch(/\.fm-walker, \.fm-gear, \.fm-eye, \.fm-hat, \.fm-arms \{ transition: none; \}/);
    // And the state still reads, because the brightened sprite says it.
    expect(decl(".fm-sprite[data-playing]", "opacity")).toBe("1");
  });

  it("says its state to a reader who cannot see it dance", () => {
    expect(component).toContain("aria-pressed={playing}");
    expect(component).toMatch(/aria-label=\{playing \? "Stop Claude FM" : "Play Claude FM"\}/);
    // And says where the sound comes from before anybody presses it.
    expect(component).toContain("streams from YouTube");
  });
});

describe("the hidden player", () => {
  it("is off-screen at a real size, not shrunk or display:none", () => {
    // Both of the usual spellings are how a hidden YouTube player stops
    // working: a display:none iframe may be torn down or throttled, and a 1px
    // one is a player the page has told the browser nobody can see, which is
    // grounds to refuse the autoplay it was just given a gesture for.
    expect(decl(".fm-frame", "display")).toBeNull();
    expect(decl(".fm-frame", "width")).toBe("320px");
    expect(decl(".fm-frame", "height")).toBe("180px");
    expect(decl(".fm-frame", "left")).toBe("-10000px");
  });

  it("is allowed the two permissions it needs and no others", () => {
    expect(component).toContain('allow="autoplay; encrypted-media"');
    for (const no of ["camera", "microphone", "geolocation", "fullscreen", "payment"]) {
      expect(component).not.toContain(no);
    }
    expect(component).toContain('sandbox="allow-scripts allow-same-origin allow-presentation"');
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

/** A declaration, read out of the sheet.
 *
 *  Every block with this EXACT selector is searched, not just the first one:
 *  a name can legitimately own more than one rule — `.fm-gear` is given its
 *  colour where the inks are set and its position where the motion is — and a
 *  helper that stopped at the first match reported the second as absent. */
function decl(selector: string, prop: string): string | null {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "mg");
  const want = new RegExp(`(?:^|[;{\\s])${prop.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+)`, "m");
  for (const block of css.matchAll(re)) {
    const m = want.exec(block[1]);
    if (m) return m[1].trim();
  }
  return null;
}

/** A Response whose body is one chunk. */
function bodyOf(text: string): Response {
  return countingBody([text]).res;
}

/** A Response that reports how many chunks were actually pulled, so a test can
 *  prove the read stopped early rather than merely sliced afterwards. */
function countingBody(chunks: string[]) {
  let i = 0;
  const encoder = new TextEncoder();
  const res = {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: encoder.encode(chunks[i++]) }
          : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    },
  } as unknown as Response;
  return { res, delivered: () => i };
}

function okWith(html: string): Response {
  return countingBody([html]).res;
}
