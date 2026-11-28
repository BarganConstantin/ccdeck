// /api/devices: the machines this deck reaches over SSH, and what is running
// on them.
//
//   GET  /api/devices             every saved device, with its connection state
//   POST /api/devices/add         save one: { name?, alias } or { name?, host, user, port? }
//   POST /api/devices/remove      { id } — forget it and close its connection
//   POST /api/devices/test        { id } or { draft: {…} } — connect and read, without saving
//   POST /api/devices/trust       { confirm } — trust the host key a test showed, and test again
//   POST /api/devices/disconnect  { id } — close the connection; nothing on the device changes
//   GET  /api/devices/sessions?id=   that device's live sessions, each tied to it
//
// BEHIND THE GATES EVERY OTHER ROUTE IS. The two reads are in GUARDED_READS
// (request-gates.mjs): which machines the user reaches, as whom, and what runs
// there is the user's own, and the deck's page is the only caller. The POSTs
// are mutations, so only that page or a client holding the deck's token gets
// past isAuthorizedMutation. None of this is offered to paired decks: the LAN
// listener is its own socket with its own protocol and never reaches here.
//
// A test or a read ANSWERS 200 WITH A TYPE, whatever happened on the far side:
// `{ ok, type, … }` where `type` is one of ok, host_key_unknown,
// host_key_changed, auth_failed, unreachable, no_remote_ccdeck,
// version_too_old, ssh_missing, trust_expired or failed (device-link.mjs and
// device-ssh.mjs say what each carries). A 4xx is a request this deck will not
// act on: a body it cannot read, a device it does not have, input it refuses.
// No sentence for a person is written here; the page words each type.
import { deviceStore } from "./device-store.mjs";
import { createDeviceLinks } from "./device-link.mjs";
import { parseDeviceInput } from "./device-input.mjs";
import { REMOTE_MIN_VERSION } from "./device-remote.mjs";
import { readBody, send } from "./http-io.mjs";

/** The largest body a device route reads: a few short fields. */
export const DEVICE_BODY_LIMIT = 4096;

let shared = null;
/** The deck's own store and connections, made the first time a route needs them. */
function deckDeps() {
  shared ??= { store: deviceStore, links: createDeviceLinks({ store: deviceStore }) };
  return shared;
}

async function readJson(req, res) {
  const raw = await readBody(req, res, DEVICE_BODY_LIMIT).catch(() => null);
  if (raw !== null) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* answered below */ }
  }
  // A no-op when readBody has already answered 413.
  send(res, 400, { ok: false, error: "bad_body" });
  return null;
}

/** A device as the page sees it: the record, without what only the deck
 *  needs, and how its connection stands. */
function forPage(device, links) {
  const where = device.alias ? { alias: device.alias } : { host: device.host, user: device.user, port: device.port };
  return { id: device.id, name: device.name, ...where, addedAt: device.addedAt, link: links.status(device) };
}

const typed = (res, result) => send(res, 200, { ...result, ok: result.type === "ok" });
const notFound = (res) => send(res, 404, { ok: false, error: "not_found" });
const idOf = (value) => (typeof value === "string" && value.length <= 64 ? value : "");

export async function handleDeviceList(req, res, deps = deckDeps()) {
  const devices = await deps.store.list();
  return send(res, 200, { ok: true, minimumVersion: REMOTE_MIN_VERSION, devices: devices.map(d => forPage(d, deps.links)) });
}

export async function handleDeviceAdd(req, res, deps = deckDeps()) {
  const body = await readJson(req, res);
  if (!body) return;
  const saved = await deps.store.add(body);
  if (!saved.ok) {
    const status = saved.code === "duplicate" || saved.code === "full" ? 409 : 400;
    return send(res, status, { ok: false, error: saved.code, field: saved.field });
  }
  return send(res, 200, { ok: true, device: forPage(saved.device, deps.links) });
}

export async function handleDeviceRemove(req, res, deps = deckDeps()) {
  const body = await readJson(req, res);
  if (!body) return;
  const removed = await deps.store.remove(idOf(body.id));
  if (!removed) return notFound(res);
  deps.links.forget(removed);
  return send(res, 200, { ok: true });
}

export async function handleDeviceTest(req, res, deps = deckDeps()) {
  const body = await readJson(req, res);
  if (!body) return;
  let device;
  if (body.draft !== undefined) {
    // Not saved yet: the same rules as a save, and no id, so nothing is
    // remembered about it but the connection itself.
    const parsed = parseDeviceInput(body.draft);
    if (!parsed.ok) return send(res, 400, { ok: false, error: parsed.code, field: parsed.field });
    device = { ...parsed.value, launcher: null };
  } else {
    device = await deps.store.get(idOf(body.id));
    if (!device) return notFound(res);
  }
  return typed(res, await deps.links.check(device));
}

export async function handleDeviceTrust(req, res, deps = deckDeps()) {
  const body = await readJson(req, res);
  if (!body) return;
  return typed(res, await deps.links.trust(typeof body.confirm === "string" ? body.confirm : ""));
}

export async function handleDeviceDisconnect(req, res, deps = deckDeps()) {
  const body = await readJson(req, res);
  if (!body) return;
  const device = await deps.store.get(idOf(body.id));
  if (!device) return notFound(res);
  deps.links.disconnect(device);
  return send(res, 200, { ok: true, link: deps.links.status(device) });
}

export async function handleDeviceSessions(req, res, url, deps = deckDeps()) {
  const device = await deps.store.get(idOf(url.searchParams.get("id")));
  if (!device) return notFound(res);
  return typed(res, await deps.links.sessions(device));
}
