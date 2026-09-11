// What a paired deck says about itself: the version it runs and the machine it
// runs on.
//
// ONLY TO A DECK THAT IS PAIRED, AND SEALED. The beacon is shouted at the whole
// network and the hello is sent before anybody has proved anything, so neither
// carries this: which build of which operating system a machine runs is the
// first thing somebody hunting for a known-broken version would want, and
// nobody on the network is owed it. It rides the manifest exchange, which only
// happens between two decks that have each accepted the other — and it is
// sealed with that connection's key, because the frames around it are JSON in
// the clear on the wire.
//
// BOTH WAYS. The deck that dials sends its own card with the question, and the
// deck that answers sends its own with the answer. A deck that only calls in —
// paired, with no address this one can reach — is never asked anything, so the
// card it sends when it calls is the only way this deck ever learns what it is.
//
// OLDER DECKS SAY NOTHING, AND NOTHING BREAKS. The field is extra on a frame
// both versions already send: a deck from before this reads the accounts and
// never looks at the rest, and a card that is absent is drawn as absent.
import { readFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { open, seal } from "./lan-sync.mjs";

/**
 * The operating system, in the words its owner would use.
 *
 * Node reports the KERNEL — `darwin 25.5.0`, `win32 10.0.26100` — and nobody
 * calls their laptop Darwin 25. So the numbers are translated on the machine
 * they describe, where the translation is certain, rather than on the one
 * reading them. Every input is a parameter, so all three platforms are tested
 * on any one of them.
 */
export function osLabel({ platform, release = "", prettyName = "" } = {}) {
  const [major, minor, build] = String(release).split(".").map(n => Number.parseInt(n, 10));
  const dot = Number.isInteger(minor) ? `.${minor}` : "";
  if (platform === "darwin") {
    if (!Number.isInteger(major)) return "macOS";
    // Darwin 20 was macOS 11 and every major after it was one more — until 25,
    // which Apple shipped as macOS 26 to match the year.
    if (major >= 25) return `macOS ${major + 1}${dot}`;
    if (major >= 20) return `macOS ${major - 9}${dot}`;
    // The 10.x years, where the kernel's major minus four is the second number.
    return major >= 5 ? `macOS 10.${major - 4}` : "macOS";
  }
  if (platform === "win32") {
    // Windows 11 kept the version 10.0 and moved only the build, and 22000 is
    // the first one. From here it is the only way to tell the two apart.
    if (major === 10 && Number.isInteger(build)) return build >= 22_000 ? "Windows 11" : "Windows 10";
    return "Windows";
  }
  if (platform === "linux") return prettyName || "Linux";
  return typeof platform === "string" && platform ? platform : "unknown";
}

/** The distribution's own name for itself, from the file every systemd-era
 *  distribution ships, with the fallback path the same spec names. Only ever
 *  read on Linux: the paths are Linux's and mean nothing anywhere else. */
export function linuxPrettyName(read = readFileSync) {
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    try {
      const line = /^PRETTY_NAME=(.*)$/m.exec(String(read(file, "utf8")))?.[1];
      const name = line?.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
      if (name) return name;
    } catch { /* not this one */ }
  }
  return "";
}

/** This deck's own card. Built once, at start: nothing in it changes while the
 *  process lives, and an upgrade is a restart. */
export function aboutThisDeck({
  version = null, platform = process.platform, release = osRelease(), arch = process.arch, read = readFileSync,
} = {}) {
  return readAbout({
    version,
    os: osLabel({ platform, release, prettyName: platform === "linux" ? linuxPrettyName(read) : "" }),
    arch,
  });
}

/** One field of a card, or null. It came off the network, so it is a string of
 *  bounded length with no control characters — the rule cleanName applies to a
 *  deck's name, for the same reason: it reaches a terminal as well as a page.
 *  `\p{Cc}` is the Unicode class for exactly those, C0 and C1 both. */
function field(v, max, shape = null) {
  if (typeof v !== "string") return null;
  const flat = v.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
  const s = [...flat].slice(0, max).join("").trim();
  return s && (!shape || shape.test(s)) ? s : null;
}

/** A card, or null when there is nothing in it worth drawing. */
export function readAbout(raw) {
  if (!raw || typeof raw !== "object") return null;
  const version = field(raw.version, 32, /^[0-9A-Za-z][0-9A-Za-z.+-]*$/);
  const os = field(raw.os, 48);
  const arch = field(raw.arch, 16, /^[0-9A-Za-z_]+$/);
  return version || os || arch ? { version, os, arch } : null;
}

/** Bound to one connection AND one direction, so a card cannot be replayed
 *  back at the deck that sent it as if it were the other deck's. */
const aboutAad = (fromFp, toFp) => `${fromFp}->${toFp}|about`;

/** This deck's card, sealed for the deck on the other end of `key`. */
export function sealAbout(key, about, fromFp, toFp) {
  if (!key || !about) return null;
  return seal(key, JSON.stringify(about), aboutAad(fromFp, toFp));
}

/** The other deck's card, or null — for a deck that sent none, and for one
 *  whose seal does not open, which mean the same thing to the panel. */
export function openAbout(key, sealed, fromFp, toFp) {
  if (!key || !sealed || typeof sealed !== "object") return null;
  const text = open(key, sealed, aboutAad(fromFp, toFp));
  if (text == null) return null;
  try { return readAbout(JSON.parse(text)); } catch { return null; }
}
