// What a device may be: a name to show, and either an SSH host alias that the
// user's own ssh configuration resolves, or a host with a user name and an
// optional port. Nothing else is accepted, and nothing else is kept.
//
// EVERY VALUE HERE BECOMES AN ARGUMENT TO `ssh`. They are passed as separate
// entries of an argument vector, never through a shell, and the destination
// always comes after `--` — but ssh reads an argument that starts with `-` as
// an option wherever getopt still looks for one, and `-oProxyCommand=…` is a
// command line of the caller's choosing run on this machine. So each field is
// held to a shape that cannot start with `-`, cannot carry whitespace, `=`,
// `%` (ssh expands `%` tokens in several options), quotes, `@` or `:` (ssh's
// own destination grammar), and cannot be empty. Anything unusual about a
// machine — a jump host, a certificate, a user name with a space in it —
// belongs in ~/.ssh/config under an alias, where ssh's own parser reads it.
//
// NO SECRET HAS A FIELD. There is no password, no key, no key path and no
// command here, and a body that carries one has it dropped: the SSH agent and
// the user's ssh configuration are the only places a credential comes from.
//
// Pure: no I/O, so the store, the routes and the tests share one spelling.
import { isIP } from "node:net";

/** The longest name a device is shown under. */
export const MAX_NAME = 64;

// An alias as ~/.ssh/config's `Host` names one: a concrete name, not a
// pattern, so no `*`, `?` or `!`.
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
// A login name. Starts with a letter, digit or underscore; never `-`.
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
// One DNS label. Underscores are not legal in a hostname but turn up in local
// names, and ssh resolves them; a leading `-` is the one shape that matters.
const LABEL = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;
// Characters no name is shown with: C0 and C1 controls, the line and paragraph
// separators, and the bidirectional overrides that make a name read as another.
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const isText = (v) => typeof v === "string";
const blank = (v) => v === undefined || v === null || (isText(v) && v.trim() === "");

/** A host alias as typed, or null. */
export function validAlias(raw) {
  if (!isText(raw)) return null;
  const alias = raw.trim();
  return ALIAS.test(alias) ? alias : null;
}

/** A user name as typed, or null. */
export function validUser(raw) {
  if (!isText(raw)) return null;
  const user = raw.trim();
  return USER.test(user) ? user : null;
}

/**
 * A host name or address, lower-cased, or null.
 *
 * An IPv6 address may be typed in brackets, the way a URL writes it; the
 * brackets are dropped, since ssh takes the bare address after `--`. A zone id
 * (`fe80::1%eth0`) is refused: Node calls it an address, and `%` is the one
 * character ssh treats as a token anywhere it can.
 */
export function validHost(raw) {
  if (!isText(raw)) return null;
  let host = raw.trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "" || host.length > 253 || /[%\s]/.test(host)) return null;
  if (isIP(host)) return host.toLowerCase();
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  if (name === "" || !name.split(".").every(label => LABEL.test(label))) return null;
  return host.toLowerCase();
}

/** A TCP port, from a number or a string of digits, or null. */
export function validPort(raw) {
  let n = null;
  if (typeof raw === "number") n = raw;
  else if (isText(raw) && /^[0-9]{1,5}$/.test(raw.trim())) n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/** A name to show, trimmed, or null. */
export function validName(raw) {
  if (!isText(raw)) return null;
  const name = raw.trim();
  if (name === "" || [...name].length > MAX_NAME || UNSHOWABLE.test(name)) return null;
  return name;
}

/**
 * What a request or a saved record describes, reduced to the fields a device
 * has: `{ ok: true, value }`, or `{ ok: false, field, code }` naming the first
 * field that is wrong and why (`missing`, `invalid`, `both`).
 *
 *   { name?, alias }                → { name, alias }
 *   { name?, host, user, port? }    → { name, host, user, port }   (port null = ssh decides)
 *
 * A name left out is the alias or the host, cut to MAX_NAME.
 */
export function parseDeviceInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, field: "device", code: "invalid" };
  const hasAlias = !blank(input.alias);
  const hasHost = !blank(input.host);
  if (hasAlias && hasHost) return { ok: false, field: "alias", code: "both" };
  if (!hasAlias && !hasHost) return { ok: false, field: "host", code: "missing" };

  let value;
  if (hasAlias) {
    const alias = validAlias(input.alias);
    if (!alias) return { ok: false, field: "alias", code: "invalid" };
    value = { alias };
  } else {
    const host = validHost(input.host);
    if (!host) return { ok: false, field: "host", code: "invalid" };
    if (blank(input.user)) return { ok: false, field: "user", code: "missing" };
    const user = validUser(input.user);
    if (!user) return { ok: false, field: "user", code: "invalid" };
    let port = null;
    if (!blank(input.port)) {
      port = validPort(input.port);
      if (port === null) return { ok: false, field: "port", code: "invalid" };
    }
    value = { host, user, port };
  }

  let name;
  if (blank(input.name)) {
    name = [...(value.alias ?? value.host)].slice(0, MAX_NAME).join("");
  } else {
    name = validName(input.name);
    if (!name) return { ok: false, field: "name", code: "invalid" };
  }
  return { ok: true, value: { name, ...value } };
}

/**
 * The connection a device names, as one string: two devices with the same one
 * are the same machine as far as ssh is concerned, so a second is refused, and
 * a connection kept open for one is the connection for the other. A missing
 * port is its own value — ssh's configuration decides it — rather than 22.
 */
export function destinationKey(device) {
  if (device?.alias) return `alias:${device.alias}`;
  return `host:${device?.user ?? ""}@${device?.host ?? ""}:${device?.port ?? ""}`;
}
