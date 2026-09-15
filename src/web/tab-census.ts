// Too many deck tabs is not a dead server (#830).
//
// Every deck tab holds one `/events` stream, and a browser keeps at most six
// live HTTP/1.1 connections to one host. A seventh deck tab's stream waits in
// the browser's own queue: it fires neither `open` nor `error`, DevTools shows
// it "pending", and every fetch that tab makes queues behind it too, so it
// cannot ask the server whether it is there. That tab used to show the offline
// hero and send its reader to check that ccdeck was running, while every tab
// beside it was streaming.
//
// The tabs can still hear one another: a BroadcastChannel is not a connection.
// So a tab whose stream has not opened asks the others which of them are
// streaming, and when enough are to explain the wait, it says so. The answers
// arrive as message events, which a background tab still handles promptly —
// only its timers are throttled — so a tab hidden for an hour answers as fast
// as the one beside it.

/** The per-host connection cap Chrome and Firefox both ship with. */
export const BROWSER_STREAM_CAP = 6;

/** One channel name for every deck tab on this origin. */
export const CENSUS_CHANNEL = "ccdeck-tabs";

export type CensusMessage =
  | { kind: "who"; from: string }
  | { kind: "here"; from: string; to: string; streaming: boolean };

/** Enough other tabs are holding a stream that this one's is queued behind them. */
export function tooManyTabs(streamingPeers: number): boolean {
  return streamingPeers >= BROWSER_STREAM_CAP;
}

type Listener = (e: { data: unknown }) => void;

/** The part of a BroadcastChannel this needs, so a test can hand it a fake. */
export interface CensusChannel {
  postMessage(msg: CensusMessage): void;
  addEventListener(type: "message", fn: Listener): void;
  removeEventListener(type: "message", fn: Listener): void;
  close?(): void;
}

/**
 * Answer every census on `channel`, and ask one on demand.
 *
 * `streaming` is read when the question arrives, so each answer is about that
 * moment rather than about when this tab joined.
 */
export function joinCensus(channel: CensusChannel, id: string, streaming: () => boolean) {
  const answer: Listener = e => {
    const m = e.data as CensusMessage | null;
    if (m?.kind === "who" && m.from !== id) {
      channel.postMessage({ kind: "here", from: id, to: m.from, streaming: streaming() });
    }
  };
  channel.addEventListener("message", answer);
  return {
    /** How many other tabs said they are streaming within `windowMs`. */
    ask(windowMs: number, wait: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms)): Promise<number> {
      return new Promise(resolve => {
        const streamingPeers = new Set<string>();
        const hear: Listener = e => {
          const m = e.data as CensusMessage | null;
          if (m?.kind === "here" && m.to === id && m.streaming) streamingPeers.add(m.from);
        };
        channel.addEventListener("message", hear);
        channel.postMessage({ kind: "who", from: id });
        wait(() => {
          channel.removeEventListener("message", hear);
          resolve(streamingPeers.size);
        }, windowMs);
      });
    },
    leave() {
      channel.removeEventListener("message", answer);
      channel.close?.();
    },
  };
}
