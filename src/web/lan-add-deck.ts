// The add dialog's two ways of reaching a deck the network did not offer, as
// far as they are rules rather than drawing: an address somebody typed, and how
// long an invite has left.
//
// Lifted out of LanSyncSection.tsx unchanged. The section itself calls neither
// — LanAddDeckModal does, and the section was only where they had been
// written. None of it touches React.

/**
 * An address somebody typed, or null.
 *
 * Deliberately strict about the PORT and loose about the host: a host can be a
 * name, an IPv4, or a bracketed IPv6, and this side cannot tell a typo from a
 * hostname it has never heard of — the network will. A port is a number in a
 * known range, and getting that wrong means dialling nothing forever, which is
 * a row that reports an error every minute and can never come right.
 *
 * The last colon splits, not the first, so `[fe80::1]:5000` keeps its address.
 */
export function parseAddress(raw: string): { addr: string; port: number } | null {
  const s = (raw ?? "").trim();
  const at = s.lastIndexOf(":");
  if (at <= 0 || at === s.length - 1) return null;
  const addr = s.slice(0, at).trim();
  const port = Number(s.slice(at + 1).trim());
  if (!addr || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  // AN UNBRACKETED IPv6 ADDRESS SPLITS ON THE WRONG COLON. `fe80::1` parsed as
  // the host `fe80:` on port 1 — a well-formed entry pointing at nothing, which
  // the list then reports as a failure every minute and no correction can fix,
  // because there is nothing visibly wrong with what was typed. Refused here so
  // the dialog can say which of the two forms this deck dials.
  if (addr.includes(":") && !(addr.startsWith("[") && addr.endsWith("]"))) return null;
  return { addr, port };
}

/** A countdown a person reads while somebody else is reading the token out. */
export function leftLabel(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
