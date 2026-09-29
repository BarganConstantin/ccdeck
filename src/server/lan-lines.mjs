// The line both ends of a connection speak, whichever dialled: newline-
// delimited JSON, read without being made to allocate and written with the
// newline the reader waits for — and the two bounds on it, the most one line
// may be and how long the handshake over it may take. Lifted out of
// lan-socket.mjs, which re-exports all of it: it is the one part of that file
// the answering half and the calling half both use.
import { MAX_MANIFEST_BYTES } from "./lan-sync.mjs";

/** How long a connection has to finish the handshake before it is dropped. A
 *  handshake is two round trips on a local network — single-digit
 *  milliseconds — so five seconds is generous for a slow machine and short
 *  enough that holding sockets open costs an attacker something. */
export const HANDSHAKE_MS = 5_000;

/** The most one frame may be, and the most a peer may hold open.
 *
 *  Frames are JSON lines. The largest legitimate one is a manifest; the cap is
 *  an order of magnitude over the biggest real store, and the buffer is
 *  ABANDONED rather than grown past it — a socket that keeps sending without a
 *  newline is trying to make this allocate, and the answer is to stop reading
 *  rather than to read faster. */
export const MAX_FRAME_BYTES = MAX_MANIFEST_BYTES;

/**
 * Read newline-delimited JSON off a socket, refusing to be made to allocate.
 *
 * The cap is on the UNTERMINATED buffer rather than on a frame that arrived,
 * which is the distinction that matters: a peer that sends a megabyte with no
 * newline in it is not sending a large frame, it is sending nothing at all,
 * expensively. Past the cap this stops reading and hands the caller a refusal
 * — it does not keep buffering in the hope a newline turns up.
 */
export function frameReader(onFrame, onRefuse, max = MAX_FRAME_BYTES) {
  let buf = "";
  let dead = false;
  return chunk => {
    if (dead) return;
    buf += chunk;
    if (buf.length > max) { dead = true; buf = ""; onRefuse("frame too large"); return; }
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { dead = true; buf = ""; onRefuse("not json"); return; }
      // `typeof [] === "object"`, so an array walks straight past the obvious
      // check and reaches a handler that reads `msg.t` off it — undefined, and
      // then whatever that handler does with a frame that has no type. A frame
      // is a record; anything else is refused.
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        dead = true; buf = ""; onRefuse("not an object"); return;
      }
      // A HANDLER THAT THROWS ENDS ITS CONNECTION, NOT THE PROCESS. This runs
      // inside the socket's `data` event, where nothing above catches, so a
      // throw from a frame handler took the whole deck down — and every frame
      // read here has come off the network before anybody is trusted. The
      // handlers are meant never to throw; this is what holds when one does.
      // The error goes on with the refusal, so the next one that hides here is
      // logged with its stack rather than as two words.
      try { onFrame(msg); }
      catch (err) { dead = true; buf = ""; onRefuse("bad frame", err); return; }
      if (dead) return;
    }
  };
}

/** One line out. Kept in one place so nothing forgets the newline the reader
 *  above is waiting for. */
export function sendFrame(sock, obj) {
  try { sock.write(`${JSON.stringify(obj)}\n`); } catch { /* peer went away */ }
}
