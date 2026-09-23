// The app's connection to a deck (#1160): find one, read its event stream as
// the tray, and talk to it with its token.
//
// The deck is found the way `ccdeck --status` finds one — the discovery files
// each deck writes to `<Claude config dir>/agent-dag/<pid>.json`, each
// challenged to prove it holds the token in it (src/server/running-deck.mjs),
// so a file left by a deck that died never gets the token sent to whatever now
// owns its port. The stream is `/events?role=tray` with that token, which the
// deck subscribes like any client and counts as no page — so the app can read
// the board without silencing the notifications it exists to deliver.
import { request } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Parse a chunk of an SSE stream. Returns the complete frames and the
 *  unfinished tail to carry into the next chunk. */
export function parseSse(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    const end = rest.indexOf("\n\n");
    if (end === -1) break;
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let event = "message", data = "", id = null;
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment — the deck's ping
      const at = line.indexOf(":");
      const field = at === -1 ? line : line.slice(0, at);
      const value = at === -1 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data += (data ? "\n" : "") + value;
      else if (field === "id") id = value;
    }
    if (data || event !== "message") frames.push({ event, data, id });
  }
  return { frames, rest };
}

/** Every live, challenged deck on this machine, the default port first. */
export async function findDecks(deckRoot, { preferPort = 4317 } = {}) {
  const { liveDecks } = await import(pathToFileURL(join(deckRoot, "src", "server", "running-deck.mjs")).href);
  const decks = await liveDecks();
  return decks.sort((a, b) => (a.port === preferPort ? -1 : b.port === preferPort ? 1 : a.port - b.port));
}

/** One JSON call to the deck, with its token. */
export function deckJson(deck, path, { method = "GET", body = null, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "x-ccdeck-token": deck.token };
    const payload = body == null ? null : JSON.stringify(body);
    if (payload) headers["content-type"] = "application/json";
    const req = request({ host: "127.0.0.1", port: deck.port, path, method, headers, timeout: timeoutMs }, res => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", c => { out += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: out ? JSON.parse(out) : null }); }
        catch (err) { reject(err); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * Keep a tray connection to one deck open, reconnecting after it drops.
 *
 * `on.connected()` fires when the stream opens — the deck then replays its ring
 * from the start, so the caller resets its model there — `on.hook(envelope)`
 * for every event, `on.notify({title, body})` for a closed-deck notification,
 * and `on.lost()` when it ends. Returns a handle whose `close()` stops it.
 */
export function openTrayStream(deck, on, { retryMs = 1500 } = {}) {
  let req = null;
  let stopped = false;
  let timer = null;

  const connect = () => {
    if (stopped) return;
    req = request({
      host: "127.0.0.1", port: deck.port, path: "/events?role=tray", method: "GET",
      headers: { "x-ccdeck-token": deck.token, accept: "text/event-stream" },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return retry(); }
      on.connected?.();
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", chunk => {
        const { frames, rest } = parseSse(buffer + chunk);
        buffer = rest;
        for (const f of frames) {
          if (f.event === "hook") {
            try { on.hook?.(JSON.parse(f.data)); } catch { /* one bad frame is not the stream */ }
          } else if (f.event === "notify") {
            try { on.notify?.(JSON.parse(f.data)); } catch { /* ignore */ }
          } else if (f.event === "replay-end") {
            on.live?.();
          }
        }
      });
      res.on("end", retry);
      res.on("error", retry);
    });
    req.on("error", retry);
    req.end();
  };

  const retry = () => {
    if (stopped || timer) return;
    on.lost?.();
    timer = setTimeout(() => { timer = null; connect(); }, retryMs);
  };

  connect();
  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      req?.destroy();
    },
  };
}
