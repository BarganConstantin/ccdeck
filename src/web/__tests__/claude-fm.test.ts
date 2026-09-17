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
  command, duckMsFor, DUCK_TAIL_MS, DUCK_VOLUME, embedSrc, FATAL_ERRORS, FULL_VOLUME,
  listenCommand, nextIdleMs, nextWalk, PLAYER_ORIGIN, PLAYING_STATES, readSignal,
  SPRITE, SPRITE_H, SPRITE_W, spriteRects,
  BIN_X, choreSteps, CHORE_CHANCE, litterSpot, TOSS_WINDUP_MS, walkMsFor,
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
    for (const idle of [-1, 0, 2, 5]) {
      expect(readSignal({ event: "onStateChange", info: idle })).toEqual({ kind: "playing", playing: false });
    }
  });

  it("reads the spelling the player actually uses, not the documented one", () => {
    // Measured on a real deck: seven messages from the player and not one
    // `onStateChange`. The live player reports state inside `infoDelivery`,
    // mixed in with volume, quality and timing — so a build that read only the
    // documented event learned nothing the player ever said about playback.
    expect(readSignal({ event: "infoDelivery", info: { playerState: 1, currentTime: 12 } }))
      .toEqual({ kind: "playing", playing: true });
    expect(readSignal({ event: "infoDelivery", info: { playerState: -1 } }))
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
    expect(decl(".fm", "bottom")).toBe("calc(var(--flow-gutter) + var(--minimap-h))");
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

  it("keeps its weight in both themes, which is not the same number twice", () => {
    // 0.55 is a dark-theme number: there the accent is a bright ink on
    // near-black and survives being halved. In light it is a dark ink on a
    // light ground, where dimming does not make it quieter, it makes it grey —
    // the light sprite read as a smudge on the minimap next to a dark one that
    // read as a character.
    expect(decl(".fm-sprite", "opacity")).toBe("0.55");
    expect(decl(':root[data-theme="light"] .fm-sprite', "opacity")).toBe("0.72");
    // Both themes drive the same three tokens, so nothing is hard-coded to one
    // of them: the canvas shows through the eyes on either.
    expect(decl(".fm-body", "fill")).toBe("var(--accent)");
    expect(decl(".fm-gear", "fill")).toBe("var(--muted)");
    expect(decl(".fm-eye", "fill")).toBe("var(--bg)");
    expect(css).not.toMatch(/\.fm[\w-]*[^}]*#[0-9a-f]{3,6}/i);
  });

  it("dances only while the music is on", () => {
    expect(css).toMatch(/\.fm-sprite\[data-playing\] \.fm-body \{ animation: fm-bob/);
    expect(css).toMatch(/\.fm-sprite\[data-playing\] \.fm-gear \{ animation: fm-nod/);
    expect(css).toMatch(/@keyframes fm-bob/);
    expect(css).toMatch(/@keyframes fm-nod/);
    // No animation on the resting sprite at all.
    expect(decl(".fm-sprite", "animation")).toBeNull();
  });

  it("walks the edge in two frames, not on a curve", () => {
    // A pixel character that eases between poses looks like a picture being
    // tweened; one that snaps between two looks like it is taking steps. So the
    // keyframes hold each pose for half the cycle and the timing is linear.
    expect(css).toContain('.fm-walker[data-act="walk"]');
    // Carrying something is still walking.
    expect(css).toContain('.fm-walker[data-act="carry"]');
    expect(css).toMatch(/animation: fm-step 440ms linear infinite/);
    expect(css).toMatch(/@keyframes fm-step \{\s*0%, 49\.99%/);
    // The curve is a compromise: pure linear starts and stops dead, a full ease
    // makes the middle race and the feet stop matching the ground. This is the
    // gentlest symmetric curve that keeps most of the trip near constant speed.
    expect(decl(".fm-walker", "transition")).toBe("transform var(--fm-walk-ms, 0ms) cubic-bezier(0.32, 0, 0.68, 1)");
    expect(decl(".fm-walker", "transform")).toBe("translateX(var(--fm-x, 0px))");
  });

  it("never wanders off the ledge, and never while the music is on", () => {
    // It has somewhere to be. A character that walks away mid-track reads as a
    // bug rather than as life.
    expect(component).toContain("if (!probe || dead || playing) return;");
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
    expect(decl(".fm-walker, .fm-litter", "position")).toBe("absolute");
    // 21px is what centres a 12px object under a 54px one when both are
    // right-aligned: without it the stoop reaches for nothing.
    expect(decl(".fm-litter", "transform")).toBe("translateX(calc(var(--fm-litter-x, 0px) - 21px))");
    expect((54 - 12) / 2).toBe(21);
  });

  it("does the errand in steps that can be read without a clock", () => {
    const steps = choreSteps(-100, -20);
    expect(steps.map(s2 => s2.act)).toEqual(["walk", "stoop", "carry", "windup", "toss"]);
    // It walks to the litter, not past it.
    expect(steps[0].x).toBe(-20);
    expect(steps[0].ms).toBe(walkMsFor(-100, -20));
    // The litter leaves the ledge when it is picked up — the END of the stoop,
    // not the start of it.
    expect(steps[1].litter).toBe(-20);
    expect(steps[2].litter).toBeNull();
    // And it is carried to the one spot on the ledge nothing else stands on.
    expect(steps[2].x).toBe(BIN_X);
    expect(steps.at(-1)?.x).toBe(BIN_X);
    // The throw is a beat after arriving: a character that arrives and tosses
    // in one motion reads as dropping something.
    expect(steps[3].act).toBe("windup");
    expect(steps[3].ms).toBe(TOSS_WINDUP_MS);
  });

  it("picks litter up somewhere worth walking to, always on the ledge", () => {
    let at = 0;
    for (let i = 0; i < 400; i++) {
      const spot = litterSpot(at, () => (i * 0.023) % 1);
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
    expect(component).toContain("setLitter(null);");
    expect(component).toMatch(/return \(\) => \{[\s\S]*?setHeld\(false\);[\s\S]*?setLitter\(null\);/);
  });

  it("keeps the errand rarer than the stroll", () => {
    // The ordinary thing stays the ordinary thing, so finding it mid-chore is a
    // small surprise rather than the expected state.
    expect(CHORE_CHANCE).toBeLessThan(0.5);
    expect(CHORE_CHANCE).toBeGreaterThan(0);
  });

  it("stands still far longer than it walks", () => {
    // The restraint IS the design: this is a monitoring tool, and something
    // moving continuously in the corner is what people turn off first.
    const longestTrip = WALK_SPAN_PX * WALK_MS_PER_PX;
    expect(WALK_IDLE_MIN_MS).toBeGreaterThan(longestTrip * 2);
    expect(nextIdleMs(() => 0)).toBe(WALK_IDLE_MIN_MS);
    expect(nextIdleMs(() => 1)).toBe(WALK_IDLE_MAX_MS);
    // A range rather than a number, so two decks side by side do not step in time.
    expect(WALK_IDLE_MAX_MS).toBeGreaterThan(WALK_IDLE_MIN_MS * 1.5);
  });

  it("holds still for somebody who asked for no motion", () => {
    // A character dancing in the corner of a monitoring tool is exactly the
    // motion this setting is turned on to stop.
    const reduce = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g;
    const blocks = [...css.matchAll(reduce)].map(m => m[1]).join("\n");
    // All of it: the dance, the walk and the press.
    for (const gone of [
      ".fm-sprite[data-playing] .fm-body",
      ".fm-sprite[data-playing] .fm-gear",
      ':is(.fm-walker[data-act="walk"], .fm-walker[data-act="carry"]) .fm-body',
      ':is(.fm-walker[data-act="walk"], .fm-walker[data-act="carry"]) .fm-gear',
      '.fm-walker[data-act="stoop"] .fm-sprite',
      ".fm-held[data-toss]",
      ".fm-eye",
    ]) expect(blocks).toContain(gone);
    expect(blocks).toMatch(/animation: none/);
    expect(blocks).toMatch(/\.fm-walker \{ transition: none; \}/);
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

function decl(selector: string, prop: string): string | null {
  const re = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const body = re.exec(css)?.[1];
  if (body == null) return null;
  const m = new RegExp(`(?:^|[;{\\s])${prop.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+)`, "m").exec(body);
  return m ? m[1].trim() : null;
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
