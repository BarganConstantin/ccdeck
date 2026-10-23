// The JS terminal backend's session bridge: a tmux control-mode client on a
// ticket's pane, and the protocol between it and the panel.
//
// NOT ON THE PRODUCT'S PATH. The deck serves the Command Panel only through
// the optional local engine (pro-engine-terminal.mjs relays its streams), and
// nothing the deck runs imports this file: terminal-js-routes.mjs, the JS
// backend a test hands startServer as `terminal.jsBackend`, is its one
// caller. It stays, with tmux.mjs, tmux-control.mjs, terminal-target.mjs and
// terminal-sessions.mjs, as the parity oracle the engine is checked against;
// removing it is a separate decision. The engine's bridge speaks this same
// protocol, so the panel cannot tell the two apart
// (docs/contracts/pro-engine-host-v1.md, "Terminal streams").
//
// THE BRIDGE IS THE PROTOCOL src/web/terminal-protocol.ts SPEAKS, in order:
// `hello`; then nothing until the panel's first `size`, so the first frame is
// drawn at the panel's size and not at whatever the pane was; the pane resized
// to it when the panel owns the size; then `reset` and ONE binary frame of
// seed — the bytes that make a reset xterm show what tmux shows — and from
// then on the pane's output as it happens, as fast as the panel says (`ack`)
// its terminal is parsing it. tmux-control.mjs owns the hard part
// (the seed boundary, %pause, the pane dying); this file only keeps the order
// on the wire and never lets two seeds cross.
//
// NOTHING THROWS OUT OF HERE, for the reason terminal-socket.mjs gives: a
// socket callback has nothing above it to catch it.
import { clampSize } from "./terminal-sessions.mjs";
import { openControl } from "./tmux-control.mjs";

/** How many bytes may sit unsent on one socket before the pane's output stops
 *  being forwarded. A tab in the background, or a slow link, otherwise makes
 *  the deck hold every byte a busy TUI writes. Above this the stream is let go
 *  and the panel is re-seeded once the socket drains — it then shows what the
 *  pane shows, which is all the skipped bytes were ever going to amount to. */
export const HIGH_WATER_BYTES = 4 << 20;

/** How many bytes of output may be on their way to a panel that acknowledges
 *  what its terminal has parsed (`ack`) before the stream is let go. The
 *  socket's own high-water mark only sees bytes the kernel has not taken, and
 *  a browser takes them as fast as they come and queues them for xterm, which
 *  parses a few megabytes a second: measured on a long-line `cat` loop, 7–8 MB
 *  were still in the browser when Ctrl+C reached the pane, and the flood kept
 *  scrolling for a second and a half after it had stopped. With a window, what
 *  is in flight is bounded by it, and a panel that falls behind is re-seeded
 *  with the screen as it is now — what a native terminal shows when it draws
 *  only the latest frame. A page that never acknowledges is never held to it. */
export const ACK_WINDOW_BYTES = 512 * 1024;

/** The panel sends a size on every frame of a drag. tmux redraws the pane for
 *  each one, so they are settled for this long and only the last is applied. */
export const RESIZE_DEBOUNCE_MS = 50;

/** The least time between two colour reports to tmux. A theme switch is one
 *  message; a page that sends a stream of them gets the latest, this often. */
export const COLOURS_INTERVAL_MS = 250;

/** A colour as the panel may send it: six lowercase hex digits after a #. */
const HEX_COLOUR = /^#[0-9a-f]{6}$/;

/** Lines of scrollback a seed carries above the screen. */
export const SEED_HISTORY = 2000;

/** What tmux-control's exit reasons are called on the wire. `closed` is this
 *  bridge's own close() and is never said to the panel. */
const EXIT_REASONS = Object.freeze({ ended: "ended", detached: "detached", error: "error" });

/** The one sentence an `error` exit carries. tmux's own words are not sent:
 *  they name socket paths, and the panel has no use for them. */
const ERROR_SENTENCE = "The deck lost its connection to tmux.";

/**
 * The session bridge for one admitted socket: a tmux control-mode client on
 * the ticket's pane, and the protocol between it and the panel. Answers `{
 * message(m), closed(code, reason), shutdown(reason) }` for the upgrade to
 * call. See the header for the conversation.
 *
 *   conn       the wsConnection
 *   socket     the raw socket, for its 'drain' (see HIGH_WATER_BYTES)
 *   binding    what the ticket was minted for: { kind, tmux, socket, target,
 *              pane, ignoreSize, readOnly? }
 *   open       openControl, or a stand-in
 *   history, debounceMs, highWater   SEED_HISTORY, RESIZE_DEBOUNCE_MS,
 *              HIGH_WATER_BYTES
 *
 * The pane owns the size when the binding says ignoreSize (the user's own
 * tmux, case B): the panel is then told the pane's size whenever it changes,
 * and its own sizes after the first are ignored. Otherwise the panel owns it,
 * and its sizes resize the pane.
 */
export function terminalBridge({
  conn, socket, binding,
  open = openControl, history = SEED_HISTORY, debounceMs = RESIZE_DEBOUNCE_MS, highWater = HIGH_WATER_BYTES,
  coloursMs = COLOURS_INTERVAL_MS, ackWindow = ACK_WINDOW_BYTES,
}) {
  const paneOwned = binding?.ignoreSize === true;
  const readOnly = binding?.readOnly === true;
  // `ended` once an exit has been said or the socket has gone; nothing is
  // sent after it. `started` once the panel's first size has arrived, which
  // is what the first seed waits for. `seeded` once a reset and its seed have
  // gone out, so an `ended` exit knows whether there is a frame on screen.
  let ended = false;
  let started = false;
  let seeded = false;
  let congested = false;
  // Flow control by acknowledgement (ACK_WINDOW_BYTES). `sentBytes`: every
  // binary byte this bridge has put on the wire, seeds included. `ackedBytes`:
  // the most the panel has said its terminal parsed, -1 until it first says —
  // a page that predates acks is never held to the window. `behind`: output
  // is being let go because the window is full; the next ack that brings it
  // back under half asks for a seed.
  let sentBytes = 0;
  let ackedBytes = -1;
  let behind = false;
  // Where the last seed ended. The window is counted from there: a seed is a
  // one-off, and one larger than the window (2000 lines of coloured history
  // can be) would otherwise let go of the output after it, and the reseed its
  // ack asks for would do the same again, for as long as the pane writes.
  let seedMark = 0;
  const inFlight = () => sentBytes - Math.max(ackedBytes, seedMark);
  // Reseeds asked for, and the latest of those a delivered seed answered. A
  // %pause during a seed asks for another, and the one in flight is then
  // stale: comparing the two is how it knows not to send itself.
  let asks = 0;
  let queued = false;
  let resizeTimer = null;
  let pendingSize = null;
  // Sizes, for a pane the panel sizes (case A, D). `asked`: the last size this
  // panel gave tmux. `shown`: the size its xterm is at, as far as this side
  // knows — every reset, every size it sends and every size the panel says it
  // took. `lost`: the pane went to a size this panel did not ask for, because
  // another view of the same session sized it — a second tab, a `claude
  // attach` wrapper two panels share, `tmux attach` by hand. tmux sizes a
  // shared window for the latest client only, so the two would otherwise draw
  // one pane at two sizes, and the one that lost would garble everything.
  // Instead the loser is told the pane's real size, and takes the pane back
  // the moment it is typed in: the view in use is the one the pane fits.
  let asked = null;
  let shown = null;
  let lost = false;
  // The panel's theme colours, for a pane the deck owns (case A, D): tmux
  // answers a program's OSC 10/11 question itself, from what its control
  // client said, and says black when nobody did — which Claude Code's auto
  // theme reads as a dark terminal on every deck theme. `told` is what tmux
  // has, `wanted` the latest the panel sent, `coloursTimer` the cooldown.
  let told = "";
  let wanted = "";
  let coloursTimer = null;
  // Every seed and the exit go through this one chain, so two seeds never
  // cross on the wire and an exit is never said ahead of the seed before it.
  let chain = Promise.resolve();
  const later = (fn) => {
    chain = chain.then(fn).catch(() => {});
    return chain;
  };

  const handle = { message, closed, shutdown };

  conn.sendText(JSON.stringify({ t: "hello", kind: String(binding?.kind ?? ""), sizeOwner: paneOwned ? "pane" : "dock", readOnly }));

  let control = null;
  try {
    control = open({
      tmux: binding?.tmux,
      socket: binding?.socket,
      target: binding?.target,
      pane: binding?.pane,
      ignoreSize: paneOwned,
      readOnly,
    });
  } catch {
    end("error", ERROR_SENTENCE);
    return handle;
  }
  control.on("output", onOutput);
  control.on("reseed", askReseed);
  control.on("size", onPaneSize);
  control.on("exit", onExit);

  // The tmux server's version, for the panel to know which of the pane's
  // questions that tmux answers itself (terminal-replies.ts) — first in the
  // chain, so it is on the wire before the first reset. Asked now, before the
  // panel's size has arrived, and queued behind tmux's attach, so its answer
  // comes back ahead of the resize and the seed it might otherwise delay.
  const version = typeof control.serverVersion === "function" ? control.serverVersion() : Promise.resolve(null);
  later(async () => {
    const v = await version;
    if (ended || !Array.isArray(v)) return;
    conn.sendText(JSON.stringify({ t: "tmux", version: `${v[0]}.${v[1]}` }));
  });

  /** Capture and send one seed. Nothing is awaited between the capture and
   *  the two writes: tmux-control starts the stream the moment seed()
   *  resolves, and output must follow the seed on the wire, not precede it. */
  async function deliverSeed() {
    if (ended) return;
    const at = asks;
    let seed;
    try {
      seed = await control.seed({ history });
    } catch {
      // The pane could not be captured: it has gone, and the control client's
      // 'exit' says how.
      return;
    }
    if (ended) return;
    // A reseed was asked for while this one was being captured, and is queued
    // behind it: this frame is already out of date and the stream is shut.
    if (asks !== at && queued) return;
    conn.sendText(JSON.stringify({ t: "reset", cols: seed.cols, rows: seed.rows }));
    sendBinary(seed.bytes);
    seedMark = sentBytes;
    shown = { cols: seed.cols, rows: seed.rows };
    seeded = true;
  }

  /** A binary frame, counted for the window. */
  function sendBinary(bytes) {
    sentBytes += bytes.length;
    return conn.sendBinary(bytes);
  }

  /** The panel's terminal has parsed `n` of the bytes sent so far. A count
   *  past what was sent, or going backwards, is not believed. */
  function onAck(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > sentBytes || n <= ackedBytes) return;
    ackedBytes = n;
    if (behind && inFlight() <= ackWindow / 2) {
      behind = false;
      askReseed();
    }
  }

  function askReseed() {
    asks += 1;
    // Before the first size there is nothing on screen to replace; the first
    // seed, when it comes, is newer than whatever asked.
    if (ended || !started || queued) return;
    queued = true;
    later(async () => {
      queued = false;
      await deliverSeed();
    });
  }

  function onOutput(data) {
    if (ended || congested || behind) return;
    if (ackedBytes >= 0 && inFlight() > ackWindow) {
      // The panel has more in flight than its terminal has parsed by a whole
      // window: let the stream go, as for a socket that stopped reading, and
      // seed what tmux shows once it has caught up (onAck).
      behind = true;
      return;
    }
    if (conn.bufferedAmount > highWater) {
      // Let the stream go rather than queue it: what was skipped is redrawn by
      // a seed once the socket has caught up.
      congested = true;
      const drained = () => {
        congested = false;
        askReseed();
      };
      if (typeof socket?.once === "function") socket.once("drain", drained);
      else drained();
      return;
    }
    sendBinary(data);
  }

  function onPaneSize({ cols, rows }) {
    // Only once a frame is on screen: before that, the reset that comes with
    // the first seed carries the size.
    if (ended || !seeded) return;
    if (paneOwned) return void conn.sendText(JSON.stringify({ t: "size", cols, rows }));
    // A resize of the panel's own is about to claim the pane anyway, and a
    // size seen meanwhile may be the echo of its previous one.
    if (resizeTimer) return;
    // The panel's own resize landing is not news to it; any other size is.
    if (asked && (cols !== asked.cols || rows !== asked.rows)) lost = true;
    if (shown && cols === shown.cols && rows === shown.rows) return;
    shown = { cols, rows };
    conn.sendText(JSON.stringify({ t: "size", cols, rows }));
  }

  /** Before this panel types into a pane another view has resized, give the
   *  pane back its size. Not awaited: tmux runs one client's commands in the
   *  order they were written, so the keys land after the resize. */
  function reclaim() {
    if (!lost || paneOwned || !asked) return;
    lost = false;
    control.resize(asked.cols, asked.rows);
  }

  function onExit({ reason } = {}) {
    if (ended || reason === "closed") return;
    const said = EXIT_REASONS[reason] ?? "error";
    later(async () => {
      if (ended) return;
      // A pane that died under remain-on-exit still has its last frame, and
      // the client stays attached so it can be read: a panel that never got a
      // frame is shown that one, frozen, rather than an empty box — and told
      // the ending came before it was looking (`atOpen`).
      const first = said === "ended" && !seeded;
      if (first) await deliverSeed();
      end(said, said === "error" ? ERROR_SENTENCE : undefined, first ? { atOpen: true } : undefined);
    });
  }

  /** Whether tmux said the pane was already dead when this client attached. */
  async function paneWasDead() {
    try {
      return (await control.ready)?.dead === true;
    } catch {
      return false;
    }
  }

  function message({ type, data } = {}) {
    if (ended) return;
    if (type === "binary") {
      if (!readOnly) {
        reclaim();
        control.input(data);
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(Buffer.from(data ?? "").toString("utf8")); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "size") onPanelSize(msg.cols, msg.rows);
    else if (msg.t === "paste" && typeof msg.text === "string" && !readOnly) {
      reclaim();
      control.paste(msg.text);
    } else if (msg.t === "colours") onColours(msg.fg, msg.bg);
    else if (msg.t === "ack") onAck(msg.bytes);
    // Anything else is a newer page saying something this deck has not heard
    // of. Ignored, like the page ignores what it does not know.
  }

  /** The panel's colours, told to tmux at most once per `coloursMs`, the
   *  latest winning. Never for the user's own tmux (case B): tmux keeps them
   *  per pane, so they would change what the user's own terminal programs are
   *  told about the user's own terminal. Never for a read-only view. */
  function onColours(fg, bg) {
    if (paneOwned || readOnly) return;
    if (typeof fg !== "string" || typeof bg !== "string" || !HEX_COLOUR.test(fg) || !HEX_COLOUR.test(bg)) return;
    wanted = `${fg} ${bg}`;
    if (!coloursTimer) tellColours();
  }

  function tellColours() {
    coloursTimer = null;
    if (ended || !wanted || wanted === told) return;
    told = wanted;
    const [fg, bg] = told.split(" ");
    control.colours?.(fg, bg);
    coloursTimer = setTimeout(tellColours, coloursMs);
    coloursTimer.unref?.();
  }

  function onPanelSize(cols, rows) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const size = clampSize(cols, rows);
    // What the panel's xterm is at now: it resizes itself before it says so.
    shown = { cols: Math.round(cols), rows: Math.round(rows) };
    if (!started) {
      started = true;
      later(async () => {
        if (ended) return;
        // The resize first, and its reply awaited: the seed is then captured
        // at the panel's size, and the first frame is drawn once, not twice.
        if (!paneOwned) {
          asked = size;
          await control.resize(size.cols, size.rows);
        }
        await deliverSeed();
        // A pane that was already dead when this client attached — an ended
        // session's deck pane, opened for its last frame — is said to have
        // ended now, with that frame on screen, rather than whenever tmux's
        // once-a-second dead-pane subscription gets to it: by then the panel
        // has drawn it as live, and would say it ended "just now".
        if (seeded && !ended && await paneWasDead()) end("ended", undefined, { atOpen: true });
      });
      return;
    }
    if (paneOwned) return;
    pendingSize = size;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (ended || !pendingSize) return;
      // A resize claims the pane as well (tmux-control's resize), so whatever
      // another view had done to it is undone with it.
      asked = pendingSize;
      lost = false;
      control.resize(pendingSize.cols, pendingSize.rows);
    }, debounceMs);
    resizeTimer.unref?.();
  }

  // Say why, close, and let the tmux client go. The session it was attached to
  // keeps running whatever the reason — closing a panel is never stopping an
  // agent.
  // `atOpen`: the session had ended before this panel first saw it, so the
  // panel does not say it ended "just now".
  function end(reason, text, { atOpen = false } = {}) {
    if (ended) return;
    ended = true;
    clearTimeout(resizeTimer);
    clearTimeout(coloursTimer);
    conn.sendText(JSON.stringify({ t: "exit", reason, ...(text ? { message: text } : {}), ...(atOpen ? { atOpen: true } : {}) }));
    try {
      conn.close(reason === "server-shutdown" ? 1001 : 1000, reason);
    } catch { /* already closing */ }
    release();
  }

  function release() {
    try { control?.close(); } catch { /* the client is already gone */ }
  }

  /** The socket went away, from either side. */
  function closed() {
    ended = true;
    clearTimeout(resizeTimer);
    clearTimeout(coloursTimer);
    release();
  }

  /** The deck is going away, or the switch went off: closeOpenTerminals. */
  function shutdown(reason = "server-shutdown", text) {
    end(reason, text);
  }

  return handle;
}
