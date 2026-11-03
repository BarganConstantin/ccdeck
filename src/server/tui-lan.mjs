// The Local network side of `ccdeck tui`: who is out there, what the section
// says about them, and which of this deck's accounts it offers — the deck's own
// rules and English words, for a terminal.
//
// PORTED, NOT IMPORTED. The TUI is plain Node and cannot load the web's
// TypeScript, so this is a copy of src/web/lan-roster.ts (isOnline,
// sectionState, checkedLabel, askedLabel, deckRows and the row builders behind
// it, oneRowPerMachine, entryLine), src/web/lan-round.ts (seenLabel, isSeenNow,
// WIRE_ANSWERS, faultText, roundWhy, roundLabel), src/web/account-lan.ts
// (lanAccounts, codexLanAccounts, lanKindHeads, offeredHere) and the bits of
// admin-failure.ts (arrivalCheck, keychainText) and i18n/translate.ts (fill,
// plurals) they lean on, with the strings of i18n/areas/lan/en.ts and
// accounts/en.ts. src/web/__tests__/tui-lan.test.ts runs both on the same
// statuses and holds them equal, word for word — change one, change the other.
//
// Pure: no I/O and no clock. The status is GET /api/lan, the accounts are GET
// /api/claude-accounts and GET /api/codex-profiles, and `now` is handed in.

const PRODUCT = "ccdeck";

/** The English words this file says, keyed as the web's catalogs key them —
 *  exported so the parity suite can hold each one to the web's. */
export const LAN_STRINGS = Object.freeze({
  "lan.checking": "checking…",
  "lan.starting": "starting…",
  "lan.online": "online",
  "lan.wantsPair": "wants to pair",
  "lan.notCalledYet": "has not called yet",
  "lan.neverReached": "never reached",
  "lan.lastOnline": "last online {when}",
  "lan.trying": "trying…",
  "lan.seen.never": "not seen",
  "lan.seen.now": "now",
  "lan.seen.justNow": "just now",
  "lan.ago.m": "{m}m ago",
  "lan.ago.h": "{h}h ago",
  "lan.ago.d": "{d}d ago",
  "lan.list.sep": ", ",
  "lan.round.keychain.short": "Keychain locked on the other Mac",
  "lan.round.keychain.long": "the other Mac could not export it. On that Mac: {keychain}. The next round brings it.",
  "lan.round.inUse.short": "in use on the other deck",
  "lan.round.inUse.long": "the other deck is using this login right now and does not send it: two machines on one login race to renew it, and the loser is signed out. It comes on the first round after that deck switches away — or sign in to it here, which gives this machine a login of its own.",
  "lan.round.wire.waiting": "waiting for them to say yes",
  "lan.round.wire.no": "it said no",
  "lan.round.wire.theirInvite": "it pairs only by invite",
  "lan.round.wire.myInvite": "needs an invite · your setting",
  "lan.fault.ECONNREFUSED": "not listening",
  "lan.fault.EHOSTUNREACH": "no route to it",
  "lan.fault.ENETUNREACH": "no network here",
  "lan.fault.ETIMEDOUT": "no answer",
  "lan.fault.ECONNRESET": "it hung up",
  "lan.fault.EHOSTDOWN": "it is down",
  "lan.fault.ENOTFOUND": "name not found",
  "lan.fault.EACCES": "blocked here",
  "lan.fault.quiet": "it stopped mid-sentence",
  "lan.fault.badReply": "it answered with nonsense",
  "lan.fault.noManifest": "it would not say what it has",
  "lan.fault.badChallenge": "it answered as somebody else",
  "lan.fault.otherDeck": "a different deck is at that address",
  "lan.fault.noProof": "it could not prove who it is",
  "lan.fault.refusedProof": "it would not take this deck's word",
  "lan.fault.refusedHandshake": "it turned this deck away",
  "lan.fault.otherKey": "it knows this deck by another key",
  "lan.round.allFine": "all logins fine · {when}",
  "lan.round.whyLead": ", {list}",
  "lan.round.arrived.one": "{count} login arrived{why} · {when}",
  "lan.round.arrived.other": "{count} logins arrived{why} · {when}",
  "lan.round.partial": "{ok} of {total} logins arrived{why} · {when}",
  "lan.round.then": "{head}, then {fault} · {when}",
  "lan.sec.couldNotStart": "could not start — {why}",
  "lan.sec.waitingAnswer.one": "1 deck is waiting for your answer",
  "lan.sec.waitingAnswer.other": "{count} decks are waiting for your answer",
  "lan.sec.none": "no deck paired yet",
  "lan.sec.foundWaiting.one": "1 deck found · waiting for them to accept",
  "lan.sec.foundWaiting.other": "{count} decks found · waiting for them to accept",
  "lan.sec.cannotReach.one": "this deck cannot reach the one it is paired with",
  "lan.sec.cannotReach.other": "this deck cannot reach any of its {count} decks",
  "lan.sec.ready.one": "1 deck ready",
  "lan.sec.ready.other": "{count} decks ready",
  "lan.sec.readyAway": "{ready} · {n} away",
  "lan.checked.never": "not checked yet",
  "lan.checked.justNow": "checked just now",
  "lan.checked.when": "checked {when}",
  "lan.entry.off": "Off",
  "lan.entry.noStart": "could not start",
  "lan.entry.wantsPair.one": "1 deck wants to pair",
  "lan.entry.wantsPair.other": "{count} decks want to pair",
  "lan.entry.blocked": "nothing can get in",
  "lan.entry.onNone": "On · none paired yet",
  "lan.entry.noneOnline": "none of {n} online",
  "lan.entry.online": "{n} online",
  "lan.entry.someOnline": "{online} of {n} online",
  "lan.oneWay.never": "one-way · has not called yet",
  "lan.oneWay.online": "online · one-way, it calls in",
  "lan.oneWay.last": "one-way · last online {when}",
  "lan.hint.asks": "{name} at {addr} is waiting for an answer.",
  "lan.hint.asksTs": "{name} at {addr}, over Tailscale, is waiting for an answer.",
  "lan.hint.noAnswer": "Nothing has answered at {where} yet — {error}.",
  "lan.hint.dialling": "Dialling {where} until something answers.",
  "lan.hint.at": "{name} at {where}",
  "lan.hint.callsIn": "{name} calls this deck, and this deck has no address to call back on — so it can repair its logins from here, and this deck cannot repair from it. {last} Add its address through Add a deck, the link at the top of this view, to reach it either way.",
  "lan.hint.neverCalled": "It has not called since this deck started.",
  "lan.hint.lastCalled": "It last called {when}.",
  "lan.state.needsInvite": "needs an invite",
  "lan.state.notPaired": "not paired yet",
  "lan.hint.nearbyTs": "{name} at {addr} is on your tailnet and nothing is shared with it.",
  "lan.hint.nearby": "{name} at {addr} is on this network and nothing is shared with it.",
  "lan.state.declined": "you said no",
  "lan.hint.declined": "{name} asked and was turned away. It is not asking any more.",
  "lan.setup.notWorking": "not working here",
  "lan.setup.inUseNotSent": "in use here · not sent",
  "accounts.fail.keychain": "claude-swap could not read the login keychain — start {product} from a Terminal window rather than a background service",
  "accounts.fail.arrival.unreadable_here.short": "Keychain locked on this Mac",
  "accounts.fail.arrival.no_credentials_here.short": "no stored login here",
  "accounts.fail.arrival.no_credentials_here.long": "claude-swap still holds no login for it here.",
  "accounts.fail.arrival.relogin_required_here.short": "login expired",
  "accounts.fail.arrival.relogin_required_here.long": "the imported login was rejected — sign in again on a deck where it still works.",
  "accounts.fail.arrival.unverified_here.short": "not checked",
  "accounts.fail.arrival.unverified_here.long": "claude-swap could not confirm whether this Mac can read it.",
});

// ── t(), English only ────────────────────────────────────────────────────────

const EN_PLURAL = new Intl.PluralRules("en");

/** {name} placeholders from `vars`; one with no value is left as written
 *  (i18n/translate.ts fill). */
function fill(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

/** i18n/translate.ts translate, for English: a numeric `count` tries
 *  "<key>.<one|other>", then "<key>.other", then the key; a key with no text
 *  says itself. */
function t(key, vars) {
  const keys = [];
  if (typeof vars?.count === "number") keys.push(`${key}.${EN_PLURAL.select(vars.count)}`, `${key}.other`);
  keys.push(key);
  for (const k of keys) {
    const hit = Object.hasOwn(LAN_STRINGS, k) ? LAN_STRINGS[k] : undefined;
    if (typeof hit === "string") return fill(hit, vars);
  }
  return fill(key, vars);
}

/** own-row.ts: a table's own row for `key`, never Object.prototype's. */
const ownRow = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

// ── lan-round.ts ─────────────────────────────────────────────────────────────

/** How long ago, in the panel's words: "now" inside ninety seconds, then
 *  minutes, hours, and days past 48 hours; "not seen" for never. */
function seenLabel(lastSeen, now) {
  if (lastSeen == null) return t("lan.seen.never");
  const s = Math.max(0, Math.round((now - lastSeen) / 1000));
  if (s < 90) return t("lan.seen.now");
  const m = Math.round(s / 60);
  if (m < 60) return t("lan.ago.m", { m });
  const h = Math.round(m / 60);
  return h < 48 ? t("lan.ago.h", { h }) : t("lan.ago.d", { d: Math.round(h / 24) });
}

/** Whether seenLabel said "now". */
const isSeenNow = label => label === t("lan.seen.now");

/** The reasons a round names about one login, from the sending deck. */
const ROUND_WHY = {
  keychain_unavailable: { short: "lan.round.keychain.short", long: "lan.round.keychain.long" },
  "in use": { short: "lan.round.inUse.short", long: "lan.round.inUse.long" },
};

/** The keychain sentence (admin-failure.ts keychainText). */
const keychainText = () => t("accounts.fail.keychain", { product: PRODUCT });

/** What this deck found wrong with a login that had just landed. */
const ARRIVAL_CHECK = {
  unreadable_here: true,
  no_credentials_here: true,
  relogin_required_here: true,
  unverified_here: true,
};

/** admin-failure.ts arrivalCheck: the words for one arrival check, or null. */
function arrivalCheck(code) {
  const row = code ? ownRow(ARRIVAL_CHECK, code) : undefined;
  if (!code || !row) return null;
  const say = part => {
    if (code === "unreadable_here" && part === "long") return `${keychainText()}.`;
    return t(`accounts.fail.arrival.${code}.${part}`);
  };
  return { short: say("short"), long: say("long") };
}

/** What a round has to say about one login beyond arrived / did not, or null. */
function roundWhy(d) {
  if (!d.why) return null;
  const mine = ownRow(ROUND_WHY, d.why);
  return mine ? { short: t(mine.short), long: t(mine.long, { keychain: keychainText() }) } : arrivalCheck(d.why);
}

/** The refusals that are answers rather than faults, keyed on the wire's own
 *  sentence (lan-call.mjs). A plain object, as the web's is. */
const WIRE_ANSWERS = {
  "waiting for the other deck to accept this one": { text: t("lan.round.wire.waiting"), tone: "idle" },
  "that deck said no": { text: t("lan.round.wire.no"), tone: "bad" },
  "that deck pairs only by invite": { text: t("lan.round.wire.theirInvite"), tone: "idle" },
  "this deck pairs only by invite": { text: t("lan.round.wire.myInvite"), tone: "idle" },
};

/** Node's errno codes, said as a thing that happened. */
const FAULT_CODES = {
  ECONNREFUSED: "lan.fault.ECONNREFUSED",
  EHOSTUNREACH: "lan.fault.EHOSTUNREACH",
  ENETUNREACH: "lan.fault.ENETUNREACH",
  ETIMEDOUT: "lan.fault.ETIMEDOUT",
  ECONNRESET: "lan.fault.ECONNRESET",
  EHOSTDOWN: "lan.fault.EHOSTDOWN",
  ENOTFOUND: "lan.fault.ENOTFOUND",
  EACCES: "lan.fault.EACCES",
  EPIPE: "lan.fault.ECONNRESET",
};

/** lan-call.mjs's fault sentences, in words a person can act on. */
const WIRE_FAULTS = {
  "handshake timed out": "lan.fault.ETIMEDOUT",
  "peer closed the connection": "lan.fault.ECONNRESET",
  "peer went quiet": "lan.fault.quiet",
  "bad reply": "lan.fault.badReply",
  "no manifest": "lan.fault.noManifest",
  "bad challenge": "lan.fault.badChallenge",
  "a different deck is answering at that address": "lan.fault.otherDeck",
  "that deck could not prove its own key": "lan.fault.noProof",
  "the other deck refused this one's proof": "lan.fault.refusedProof",
  "the other deck refused this handshake": "lan.fault.refusedHandshake",
  "that deck has this one pinned under a different key": "lan.fault.otherKey",
};

/** What to draw for one failure: a known sentence, the errno inside it, or the
 *  text whole. */
function faultText(error) {
  const known = WIRE_FAULTS[error];
  if (typeof known === "string") return t(known);
  const code = /\b(E[A-Z]{3,})\b/.exec(error)?.[1];
  const coded = code ? FAULT_CODES[code] : undefined;
  return typeof coded === "string" ? t(coded) : error;
}

/** What the last round with one peer did: { text, tone, hint? }, or null. */
function roundLabel(last, now) {
  if (!last) return null;
  if (last.error && last.done?.length) {
    const finished = roundLabel({ ...last, error: undefined }, now);
    const at = ` · ${seenLabel(last.at, now)}`;
    return {
      ...finished,
      text: t("lan.round.then", { head: finished.text.slice(0, -at.length), fault: faultText(last.error), when: seenLabel(last.at, now) }),
      tone: "bad",
    };
  }
  if (last.error) return WIRE_ANSWERS[last.error] ?? { text: faultText(last.error), tone: "bad" };
  const done = last.done ?? [];
  if (!done.length) return { text: t("lan.round.allFine", { when: seenLabel(last.at, now) }), tone: "idle" };
  const ok = done.filter(d => d.ok);
  const said = done.map(d => ({ d, why: roundWhy(d) })).filter(x => x.why);
  const names = [...new Set(said.map(x => x.why.short))];
  const what = names.length ? t("lan.round.whyLead", { list: names.join(t("lan.list.sep")) }) : "";
  const hint = said.length ? said.map(x => `${x.d.email}: ${x.why.long}`).join(" ") : undefined;
  const at = seenLabel(last.at, now);
  return ok.length === done.length
    ? { text: t("lan.round.arrived", { count: ok.length, why: what, when: at }), tone: said.length ? "warn" : "ok", ...(hint ? { hint } : {}) }
    : { text: t("lan.round.partial", { ok: ok.length, total: done.length, why: what, when: at }), tone: "bad", ...(hint ? { hint } : {}) };
}

// ── lan-roster.ts ────────────────────────────────────────────────────────────

/** How long a beacon or an answered round keeps a deck online: three beacon
 *  intervals plus slack. */
export const LAN_ONLINE_MS = 95_000;

/**
 * Is this deck reachable right now? A failed round is offline whatever the
 * beacon says — unless the failure was an answer (WIRE_ANSWERS); otherwise a
 * round or a beacon inside LAN_ONLINE_MS is online.
 */
export function lanIsOnline(p, now) {
  if (p.last?.error && !WIRE_ANSWERS[p.last.error]) return false;
  if (p.last?.at && now - p.last.at < LAN_ONLINE_MS) return true;
  if (p.lastSeen != null && now - p.lastSeen < LAN_ONLINE_MS) return true;
  return false;
}

/** A deck that calls in is here when it has called inside the window. */
function calledLately(lastSeen, now) {
  return lastSeen != null && now - lastSeen < LAN_ONLINE_MS;
}

/**
 * The one line under the switch: { text, tone } with tone "bad" | "idle" |
 * "ok" | "wait". Empty text while the feature is off; "checking…" before the
 * first status. Counts machines, not keys, by the list's own fold.
 */
export function lanSectionState(s, now) {
  if (!s) return { text: t("lan.checking"), tone: "idle" };
  if (!s.enabled) return { text: "", tone: "idle" };
  if (s.stalled) return { text: t("lan.sec.couldNotStart", { why: s.stalled }), tone: "bad" };
  if (!s.running) return { text: t("lan.starting"), tone: "wait" };
  const asking = (s.pending ?? []).length;
  if (asking) return { text: t("lan.sec.waitingAnswer", { count: asking }), tone: "wait" };
  const peers = (s.peers ?? []).filter(p => p.paired !== false || p.met);
  if (!peers.length) return { text: t("lan.sec.none"), tone: "idle" };
  const present = p => (p.waiting ? calledLately(p.lastSeen, now) : lanIsOnline(p, now));
  const asksToBeAccepted = p => !p.waiting && p.last?.error === "waiting for the other deck to accept this one";
  const aliases = s.aliases ?? {};
  let here = 0, unanswered = 0, offline = 0;
  for (const machine of machines(peers, p => pairedName(p, p.peerFp ?? p.fp, aliases).name, p => p.addr ?? "")) {
    const on = machine.filter(present);
    if (!on.length) { offline++; continue; }
    here++;
    if (on.every(asksToBeAccepted)) unanswered++;
  }
  if (here && unanswered === here) return { text: t("lan.sec.foundWaiting", { count: here }), tone: "wait" };
  if (!here) return { text: t("lan.sec.cannotReach", { count: offline }), tone: "bad" };
  const ready = t("lan.sec.ready", { count: here });
  return { text: offline ? t("lan.sec.readyAway", { ready, n: offline }) : ready, tone: "ok" };
}

/** When every paired deck was last asked, as a phrase: "checking…" while
 *  busy, "not checked yet", "checked just now", or "checked 3m ago". */
export function lanCheckedLabel(at, now, busy) {
  if (busy) return t("lan.checking");
  if (at == null) return t("lan.checked.never");
  const when = seenLabel(at, now);
  return isSeenNow(when) ? t("lan.checked.justNow") : t("lan.checked.when", { when });
}

/** How long a request has been waiting, coarser than the peer clock. */
function askedLabel(at, now) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 90) return t("lan.seen.justNow");
  const m = Math.round(s / 60);
  return m < 60 ? t("lan.ago.m", { m }) : t("lan.ago.h", { h: Math.round(m / 60) });
}

/** A deck that is paired, holds no address here, and calls this one. */
function callsIn(lastSeen, now) {
  if (lastSeen == null) return { text: t("lan.oneWay.never"), here: false };
  const fresh = calledLately(lastSeen, now);
  return { text: fresh ? t("lan.oneWay.online") : t("lan.oneWay.last", { when: seenLabel(lastSeen, now) }), here: fresh };
}

/** Whether it is there now, and when it last was. */
function presenceLabel(p, here, now) {
  if (here) return t("lan.online");
  if (p.lastSeen != null) return t("lan.lastOnline", { when: seenLabel(p.lastSeen, now) });
  return p.waiting ? t("lan.notCalledYet") : t("lan.neverReached");
}

/** deckRows: every machine this deck knows of, one row each — requests, then
 *  paired decks (one row per machine), addresses still dialled, decks nearby,
 *  and the ones declined; by name within each kind. */
function deckRows(s, now) {
  if (!s) return [];
  const rows = [];
  const seen = new Set();
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const aliases = s.aliases ?? {};

  for (const p of s.pending ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    rows.push(askingRow(p, aliases, now));
  }

  const paired = [];
  const dialling = [];
  for (const p of s.peers ?? []) {
    const fp = p.peerFp ?? p.fp;
    if (!fp || seen.has(fp)) continue;
    seen.add(fp);
    if (!p.paired && p.manual && !p.met) dialling.push(diallingRow(p, fp, now));
    else paired.push(pairedRow(p, fp, aliases, now));
  }
  rows.push(...oneRowPerMachine(paired).sort(byName), ...dialling.sort(byName));

  const nearby = [];
  for (const p of s.strangers ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    nearby.push(nearbyRow(p, aliases, s.pairingMode));
  }
  rows.push(...nearby.sort(byName));

  const declined = [];
  for (const p of s.declined ?? []) {
    if (!p?.fp || seen.has(p.fp)) continue;
    seen.add(p.fp);
    declined.push(declinedRow(p, aliases));
  }
  rows.push(...declined.sort(byName));

  // Two rows under one name carry the address that tells them apart.
  const times = new Map();
  for (const r of rows) times.set(r.name, (times.get(r.name) ?? 0) + 1);
  for (const r of rows) {
    if ((times.get(r.name) ?? 0) < 2 || !r.addr) continue;
    r.state = r.quiet || !r.state ? r.addr : `${r.addr} · ${r.state}`;
    r.quiet = false;
  }

  return rows;
}

/** A deck asking to pair. */
function askingRow(p, aliases, now) {
  const n = named(aliases, p.fp, p.name || p.fp);
  return {
    fp: p.fp, ...n, addr: p.addr ?? "",
    kind: "asks", state: `${t("lan.wantsPair")} · ${askedLabel(p.at, now)}`, tone: "wait", here: true,
    hint: t(p.via === "tailscale" ? "lan.hint.asksTs" : "lan.hint.asks", { name: n.name, addr: p.addr ?? "" }),
    ...tailnet(p.via),
  };
}

/** An address somebody typed that nothing has answered at yet. */
function diallingRow(p, fp, now) {
  const line = roundLabel(p.last, now);
  const where = p.addr ? `${p.addr}:${p.port}` : "";
  return {
    fp: where, name: where || p.name || fp, addr: p.addr ?? "",
    kind: "dialling",
    state: line ? roundWords(line) : t("lan.trying"),
    tone: line ? line.tone : "idle",
    here: false,
    hint: p.last?.error
      ? t("lan.hint.noAnswer", { where, error: p.last.error })
      : t("lan.hint.dialling", { where }),
    ...tailnet(p.via),
  };
}

/** A paired deck, or an address that has answered. */
function pairedRow(p, fp, aliases, now) {
  const line = roundLabel(p.last, now);
  const here = lanIsOnline(p, now);
  const where = p.addr ? `${p.addr}:${p.port}` : "";
  const called = p.waiting ? callsIn(p.lastSeen, now) : null;
  const present = called ? called.here : here;
  const said = !called && line
    ? (present ? `${t("lan.online")} · ${roundWords(line)}` : `${roundWords(line)} · ${presenceLabel(p, present, now)}`)
    : called ? called.text
    : presenceLabel(p, present, now);
  const answered = p.last?.error ? WIRE_ANSWERS[p.last.error] : null;
  const quiet = !called && present && !p.last?.error && !(p.last?.done ?? []).length;
  const n = pairedName(p, fp, aliases);
  return {
    fp,
    ...n,
    addr: p.addr ?? "",
    kind: "paired",
    state: said,
    quiet,
    tone: answered ? (answered.tone === "bad" ? "bad" : "wait")
      : line ? line.tone
      : present ? "ok" : "idle",
    here: called ? called.here : here,
    ...tailnet(p.via),
    ...(called ? { oneWay: true } : {}),
    ...(!present && p.lastSeen != null ? { since: seenLabel(p.lastSeen, now) } : {}),
    hint: called
      ? t("lan.hint.callsIn", {
          name: n.name,
          last: p.lastSeen == null ? t("lan.hint.neverCalled") : t("lan.hint.lastCalled", { when: seenLabel(p.lastSeen, now) }),
        })
      : `${where ? t("lan.hint.at", { name: n.name, where }) : n.name}${p.last?.error ? ` — ${p.last.error}` : ""}${line?.hint ? ` — ${line.hint}` : ""}`,
  };
}

/** The name a paired deck's row is drawn under, which the list folds by. */
function pairedName(p, fp, aliases) {
  return p.manual && !p.met ? { name: p.addr ? `${p.addr}:${p.port}` : "" } : named(aliases, fp, p.name || fp);
}

/** A machine on the network that nobody here has paired with. */
function nearbyRow(p, aliases, pairingMode) {
  const n = named(aliases, p.fp, p.name || p.fp);
  return {
    fp: p.fp, ...n, addr: p.addr ?? "",
    kind: "nearby", state: pairingMode === "invite" ? t("lan.state.needsInvite") : t("lan.state.notPaired"), tone: "idle", here: true,
    hint: t(p.via === "tailscale" ? "lan.hint.nearbyTs" : "lan.hint.nearby", { name: n.name, addr: p.addr ?? "" }),
    ...tailnet(p.via),
  };
}

/** A deck that asked and was told no. */
function declinedRow(p, aliases) {
  const n = named(aliases, p.fp, p.name || p.fp);
  return {
    fp: p.fp, ...n, addr: p.addr ?? "",
    kind: "declined", state: t("lan.state.declined"), tone: "idle", here: false,
    hint: t("lan.hint.declined", { name: n.name }),
  };
}

/** What somebody here calls it: { name } or, renamed, { name, self }. */
function named(aliases, fp, own) {
  const given = fp ? aliases[fp] : undefined;
  return given && given !== own ? { name: given, self: own } : { name: own };
}

/** `via` for a row, present only for a deck reached over the tailnet. */
function tailnet(via) {
  return via === "tailscale" ? { via: "tailscale" } : {};
}

/** What a round did, without its clock: everything before the first " · ". */
function roundWords(line) {
  return line.text.replace(/ · .*$/, "");
}

/** One row per machine among the paired decks: by name, split by address only
 *  where one name is at two; the online one leads, the rest are its `twins`. */
function oneRowPerMachine(rows) {
  return machines(rows, r => r.name, r => r.addr).map(fold);
}

/** oneRowPerMachine's grouping, for rows and for peers alike. */
function machines(list, nameOf, addrOf) {
  const byName = new Map();
  for (const item of list) {
    const group = byName.get(nameOf(item));
    if (group) group.push(item); else byName.set(nameOf(item), [item]);
  }
  const out = [];
  for (const group of byName.values()) {
    const addrs = [...new Set(group.map(addrOf).filter(Boolean))];
    if (addrs.length > 1) {
      for (const a of addrs) out.push(group.filter(item => addrOf(item) === a));
      for (const item of group) if (!addrOf(item)) out.push([item]);
    } else {
      out.push(group);
    }
  }
  return out;
}

/** One machine's decks as one row: the lead, and the rest as its twins. */
function fold(list) {
  const [lead, ...twins] = [...list].sort((a, b) =>
    (Number(b.here) - Number(a.here)) || (Number(!!b.addr) - Number(!!a.addr)));
  return twins.length ? { ...lead, twins } : lead;
}

/**
 * The list of machines, as the Local network view draws it (LanSyncSection):
 * deckRows over the status, with the requests left out while this deck pairs
 * only by invite. Each row is { fp, name, self?, addr, kind: "asks" | "paired" |
 * "dialling" | "nearby" | "declined", state, quiet?, tone, here, via?, oneWay?,
 * since?, hint, twins? }.
 */
export function lanDeckRows(status, now) {
  return deckRows(status?.pairingMode === "invite" && status ? { ...status, pending: [] } : status, now);
}

/**
 * The way in, in one line — { text, tone, live }: off, could not start,
 * requests waiting, nothing can get in, or how many paired machines are
 * online now. From the same rows lanDeckRows draws.
 */
export function lanEntryLine(status, now) {
  return entryLine(status, lanDeckRows(status, now));
}

function entryLine(s, rows) {
  if (!s) return { text: t("lan.checking"), tone: "idle", live: false };
  if (!s.enabled) return { text: t("lan.entry.off"), tone: "idle", live: false };
  if (s.stalled) return { text: t("lan.entry.noStart"), tone: "bad", live: false };
  if (!s.running) return { text: t("lan.starting"), tone: "wait", live: false };
  const asks = rows.filter(r => r.kind === "asks").length;
  if (asks) return { text: t("lan.entry.wantsPair", { count: asks }), tone: "wait", live: false };
  if (s.reach?.blocked) return { text: t("lan.entry.blocked"), tone: "bad", live: false };
  const paired = rows.filter(r => r.kind === "paired");
  if (!paired.length) return { text: t("lan.entry.onNone"), tone: "idle", live: false };
  const online = paired.filter(r => r.here).length;
  if (!online) return { text: t("lan.entry.noneOnline", { n: paired.length }), tone: "idle", live: false };
  if (online === paired.length) return { text: t("lan.entry.online", { n: online }), tone: "ok", live: true };
  return { text: t("lan.entry.someOnline", { online, n: paired.length }), tone: "ok", live: true };
}

// ── account-lan.ts ───────────────────────────────────────────────────────────

/**
 * This deck's Claude accounts as Local network lists them (/api/claude-accounts
 * rows): { key: "email@@orgUuid", email, alive, shareable, active? } — keyed as
 * the server keys them, shareable as its export preflight decides.
 */
export function lanAccounts(accounts) {
  return (accounts ?? []).map(a => ({
    key: `${String(a.email ?? "").trim().toLowerCase()}@@${a.orgUuid ?? ""}`,
    email: a.email ?? "",
    alive: a.alive === true,
    shareable: a.collector === "ok" || (a.collector == null && !a.active),
    ...(a.active ? { active: true } : {}),
  }));
}

/** A Local network key that names a Codex login. */
export const isCodexLanKey = key => key.startsWith("codex:");

/**
 * This deck's Codex logins (/api/codex-profiles profiles carrying `lan`), one
 * row per account, the active profile's row winning: { key, email, alive: true,
 * shareable: true, provider: "codex", active? }.
 */
export function codexLanAccounts(profiles) {
  const rows = new Map();
  for (const p of profiles ?? []) {
    if (!p.lan || p.available === false) continue;
    const had = rows.get(p.lan.key);
    if (had && (had.active || !p.active)) continue;
    rows.set(p.lan.key, {
      key: p.lan.key, email: p.lan.email, alive: true, shareable: true, provider: "codex",
      ...(p.active ? { active: true } : {}),
    });
  }
  return [...rows.values()];
}

/** "Claude" above the first Claude login and "Codex" above the first Codex
 *  one, only on a deck that has both; null elsewhere. */
export function lanKindHeads(accounts) {
  const kind = a => (a.provider === "codex" ? "Codex" : "Claude");
  const mixed = new Set(accounts.map(kind)).size > 1;
  return accounts.map((a, i) => (mixed && (i === 0 || kind(accounts[i - 1]) !== kind(a)) ? kind(a) : null));
}

/** The accounts as Local network hands them out: unless `status.sendInUse`,
 *  every row of the login this deck is on is marked { shareable: false,
 *  inUse: true }. */
export function lanOfferedHere(accounts, status) {
  if (status?.sendInUse === true) return accounts;
  const live = new Set(accounts.filter(a => a.active).map(a => a.key));
  return accounts.map(a => (live.has(a.key) ? { ...a, shareable: false, inUse: true } : a));
}

/**
 * The "Share these accounts" list of the setup dialog (LanSetupModal), in its
 * order: Claude's logins, then Codex's. Each row is { key, email, provider:
 * "claude" | "codex", head: "Claude" | "Codex" | null, shared, shareable,
 * alive, inUse, mark } — `mark` the quiet words the dialog draws after the
 * email: "not working here" for a copy that does not work here, "in use here ·
 * not sent" for the ticked login this deck is on, otherwise null.
 */
export function lanShareRows(status, claudeAccounts, codexProfiles) {
  const held = [...lanAccounts(claudeAccounts ?? []), ...codexLanAccounts(codexProfiles ?? [])];
  const accounts = lanOfferedHere(held, status ?? null);
  const heads = lanKindHeads(accounts);
  const shared = new Set(status?.shared ?? []);
  return accounts.map((a, i) => {
    const inUse = a.inUse === true;
    const ticked = shared.has(a.key);
    return {
      key: a.key,
      email: a.email,
      provider: a.provider === "codex" ? "codex" : "claude",
      head: heads[i],
      shared: ticked,
      shareable: a.shareable === true,
      alive: a.alive === true,
      inUse,
      mark: !a.alive ? t("lan.setup.notWorking")
        : inUse && ticked ? t("lan.setup.inUseNotSent")
        : null,
    };
  });
}

/** The shared list after one tick (lan-share.ts nextShared): `key` removed if
 *  it is there, added at the end if not; every other key kept, in order. */
export function toggleShared(shared, key) {
  const next = new Set(shared ?? []);
  if (next.has(key)) next.delete(key); else next.add(key);
  return [...next];
}
