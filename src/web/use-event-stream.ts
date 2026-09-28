// The stream of hook events from the server, and what it says about the
// connection.
//
// Lifted out of App.tsx's `Inner`, where the subscription was one effect and
// the four things it reports were four state variables declared in three
// places, three hundred lines apart — `live` near the top because three hooks
// key off it, `everConnected` beside the Claude FM settings, `liveSince` just
// above the effect. Every write to them was inside this effect already. Here,
// nothing else can make one: App.tsx reads whether the stream is up, whether it
// has ever been, whether the browser is holding it behind other tabs, and when
// the last replay landed.
//
// The graph itself is not this hook's: every envelope is applied to
// `stateRef`, through the pause gate, and the render is asked for through
// `rerender`, both of which belong to the canvas.
import { useEffect, useRef, useState, type MutableRefObject } from "react";

import { createRenderCoalescer } from "./coalesce";
import type { PauseGate } from "./pause";
import { applyEvent, type GraphState } from "./reducer";
import type { createChimePlayer } from "./chime-player";
import { chimeFor } from "./sound";
import { CENSUS_CHANNEL, joinCensus, tooManyTabs } from "./tab-census";
import type { HookEnvelope } from "./types";

type ChimePlayer = ReturnType<typeof createChimePlayer>;

export function useEventStream({ stateRef, rerender, pauseGate, chimesRef, desktopUpdateRef }: {
  stateRef: MutableRefObject<GraphState>;
  rerender: () => void;
  /** Every envelope passes through it; a pause holds them for the resume. */
  pauseGate: PauseGate<HookEnvelope>;
  /** Plays the finish and needs-input tones, for live traffic only. */
  chimesRef: MutableRefObject<ChimePlayer | null>;
  /** The desktop app's update frames, which arrive on this stream too. */
  desktopUpdateRef: MutableRefObject<(data: string) => void>;
}) {
  // Whether the stream is connected. A restart ends with it reconnecting,
  // which is what the version check, the desktop updater and the scope re-ask on.
  const [live, setLive] = useState(false);
  /** This tab's stream is queued behind other deck tabs' streams (#830), which
   *  is a full browser and not a dead server: see the effect below and
   *  tab-census.ts. */
  const [tabCapped, setTabCapped] = useState(false);
  const [everConnected, setEverConnected] = useState(false);

  // SSE subscription.
  //
  // Replay handling: on connect the server drains its ring buffer over the
  // same SSE channel before live events. Each replayed envelope is tagged
  // `replay: true`; a `replay-end` sentinel marks the boundary. We do two
  // things differently for replay traffic:
  //   1) the SSE handler coalesces renders during replay — one render at
  //      replay-end;
  //   2) `chimeFor` stays quiet for it, so a reconnect does not play every
  //      Stop in the ring.
  //
  // The reducer never reads the flag: its turn cleanup keys on event time,
  // which comes out right for replayed and live events alike. See
  // HookEnvelope.replay in types.ts.
  //
  // Live traffic is coalesced too, but leading-edge (see coalesce.ts): the
  // first event of a quiet stream still renders in its own task, while a tool
  // storm — eight subagents each firing PreToolUse/PostToolUse arrives as
  // dozens of separate macrotasks that React cannot batch — collapses into one
  // render per window instead of one full canvas rebuild per event. Every
  // envelope is still applied to the reducer the instant it lands, in order,
  // so coalescing costs redraws and never state.
  //
  // Fallback heuristic (`Date.now() - receivedAt > 30s`) covers older
  // servers without the replay flag.
  const replayActiveRef = useRef<boolean>(true);
  /** When the latest replay landed, by the wall clock: the moment this page's
   *  board stops being history arriving and starts being spend happening. Null
   *  before the first replay-end and after the stream drops, because a
   *  reconnect replays the ring again. The usage header's $/min counts from
   *  here (#821) — counted from mount, the board total climbing from $0 to
   *  itself during the replay read as hundreds of dollars a minute. */
  const [liveSince, setLiveSince] = useState<number | null>(null);
  useEffect(() => {
    const es = new EventSource("/events");
    const coalescer = createRenderCoalescer(rerender, {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id),
    });
    // TOO MANY TABS IS NOT A DEAD SERVER (#830). A browser keeps at most six
    // live HTTP/1.1 connections to one address and every deck tab holds one
    // here, so a seventh tab's stream waits in the browser's own queue: no
    // `open`, no `error`, and every fetch from this tab queued behind it, so it
    // cannot ask the server either. The tabs can still hear one another, so a
    // tab whose stream has not opened asks which of the others are streaming,
    // and the hero says so when enough are to explain the wait.
    let streaming = false;
    const census = typeof BroadcastChannel === "function"
      ? joinCensus(new BroadcastChannel(CENSUS_CHANNEL), Math.random().toString(36).slice(2), () => streaming)
      : null;
    const probe = window.setInterval(() => {
      if (streaming || !census) return;
      void census.ask(600).then(peers => { if (!streaming) setTabCapped(tooManyTabs(peers)); });
    }, 3_000);
    es.addEventListener("open", () => { setLive(true); setEverConnected(true); });
    es.addEventListener("error", () => { setLive(false); setLiveSince(null); });
    // What this tab answers a census with, kept beside the stream it describes.
    es.addEventListener("open", () => { streaming = true; setTabCapped(false); });
    es.addEventListener("error", () => { streaming = false; });
    es.addEventListener("replay-end", () => {
      replayActiveRef.current = false;
      coalescer.flush();
      setLiveSince(Date.now());
    });
    es.addEventListener("desktop-update", (e) => desktopUpdateRef.current((e as MessageEvent).data));
    es.addEventListener("hook", (e) => {
      try {
        const env: HookEnvelope = JSON.parse((e as MessageEvent).data);
        if (!pauseGate.accept(env)) return; // paused: held for the resume
        stateRef.current = applyEvent(stateRef.current, env);
        const isReplay = env.replay === true
          || replayActiveRef.current
          || Date.now() - env.receivedAt > 30_000;
        if (isReplay) coalescer.replay();
        else coalescer.live();
        // After the coalescer, and reusing its `isReplay`: a reconnect is sent
        // the whole ring, and every Stop in a day's work is in it.
        // Over Claude FM, never under it: the chime is short and the music
        // keeps its level. Turning the track down for each one was heard as
        // the stream cutting out.
        const chime = chimeFor(env, isReplay);
        if (chime) chimesRef.current?.play(chime);
      } catch { /* ignore */ }
    });
    return () => {
      es.close();
      coalescer.cancel();
      window.clearInterval(probe);
      census?.leave();
    };
    // Deliberately not keyed on `paused`: a pause must not tear this stream
    // down, because the reconnect carries no Last-Event-ID and the server
    // answers with a full replay of its ring buffer. The gate handles pausing.
  }, [rerender]);

  return { live, tabCapped, everConnected, liveSince };
}
