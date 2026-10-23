// GET and POST /api/claude-settings: Settings › Claude Code's reading of the
// short list of Claude Code settings, and the press that changes one of them
// (claude-settings.mjs).
//
// THIS MACHINE ONLY, past the deck's own gates (index.mjs). The read is in
// GUARDED_READS, since it says what the user's settings.json holds, and the
// write is a mutation like any other; on top of both, a request that did not
// come from this computer is refused here, as Radar's are, so a paired device
// can never change how the Claude Code on this machine behaves.
import { readClaudeSettings, SettingsRefusal, updateClaudeSetting } from "./claude-settings.mjs";

export const CLAUDE_SETTINGS_ROUTE = "/api/claude-settings";

const loopback = req => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error("Request too large."); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export async function handleClaudeSettings(req, res, settings = { read: readClaudeSettings, update: updateClaudeSetting }) {
  if (!loopback(req)) return reply(res, 403, { ok: false, error: "Claude Code settings can be changed on this computer only." });
  if (req.method === "GET") {
    try { return reply(res, 200, await settings.read()); }
    catch { return reply(res, 500, { ok: false, error: "Could not read Claude Code settings. Try again." }); }
  }
  if (req.method !== "POST") return reply(res, 405, { ok: false, error: "Use GET or POST." });
  let data;
  try { data = JSON.parse((await body(req, 4096)).toString()); }
  catch { return reply(res, 400, { ok: false, error: "Invalid settings request." }); }
  // An id and a value, and nothing else: a body that names more is not this
  // press and is refused whole.
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).sort().join() !== "id,value")
    return reply(res, 400, { ok: false, error: "Invalid settings request." });
  try { return reply(res, 200, await settings.update(data.id, data.value)); }
  catch (error) {
    if (error instanceof SettingsRefusal) return reply(res, 400, { ok: false, error: error.message });
    return reply(res, 500, { ok: false, error: "Could not save the change. Your settings.json was not modified." });
  }
}
