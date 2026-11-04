// The Network side of `ccdeck tui`: the deck's Local network, as its Accounts
// panel and its setup dialog offer it. The switch, the decks with their
// requests, the accounts this deck shares, the pairing settings, adding a deck
// by address or with an invite — and the keys that change each of them,
// through the deck's own routes (lan-routes.mjs, prefs-routes.mjs).
//
// Pure, like tui-view.mjs: a state and a key in, the next state and the one
// thing to go and do (`effect`) out; a state in, the panel's rows out. The
// deck's own rules and words — what a deck's row says, which accounts can be
// shared — are tui-lan.mjs's, a copy of the web's held to it by its test.
import { clip, oneLine, textWidth } from "./cli-lines.mjs";
import { lanDeckRows, lanSectionState, lanShareRows, toggleShared } from "./tui-lan.mjs";

/** Whether the screen shows the Local network. */
export const onLan = (state) => state.side === "lan";

/** The deck serves Local network: its status has been read. */
export const hasLan = (state) => Boolean(state.deck && state.lan);

/** The decks asking to pair with this one, waiting on somebody here. */
export const lanAsking = (state) => (state.lan?.enabled ? (state.lan.pending ?? []).length : 0);

/** How long a name the deck keeps for another deck may be (deck-prefs.mjs). */
export const ALIAS_MAX = 48;
/** How long this deck's own name on the network may be, here. */
export const NAME_MAX = 64;
/** An invite as lan-invite.mjs makes them. */
const INVITE_PREFIX = "ccdeck1.";

const claudeAccountsOf = (state) => (state.roster?.ok && Array.isArray(state.roster.accounts) ? state.roster.accounts : []);

// ── the rows ────────────────────────────────────────────────────────────────

const PAUSED = "paused while pairing is invite-only";

/**
 * Every row of the Network list, top to bottom, in the deck's order: the
 * switch and what stops this deck being found, this deck, the other decks
 * (those asking first), the accounts it shares and how, then pairing and
 * Tailscale. A row with an `id` can be selected; the rest head or explain.
 * While the switch is off the decks are not listed — nothing reaches them —
 * but what will be shared, and how pairing goes, can be set beforehand.
 */
export function lanItems(state, now) {
  const s = state.lan;
  if (!s) return [];
  const out = [{ id: "enabled", kind: "switch", on: s.enabled === true }];
  if (s.enabled) {
    for (const n of lanNotes(s)) out.push({ kind: "note", text: n.text, tone: n.tone });
    out.push({ id: "self", kind: "self" });
    out.push({ kind: "head", text: "Decks" });
    const decks = lanDeckRows(s, now);
    for (const row of decks) out.push({ id: `deck:${row.fp}`, kind: "deck", row });
    if (!decks.length) out.push({ kind: "muted", text: "No other deck yet — + adds one by its address or with an invite" });
  }
  out.push({ kind: "head", text: "Share these accounts" });
  const shares = lanShareRows(s, claudeAccountsOf(state), state.codex?.profiles ?? []);
  for (const row of shares) {
    if (row.head) out.push({ kind: "sub", text: row.head });
    out.push({ id: `share:${row.key}`, kind: "share", row });
  }
  if (!shares.length) out.push({ kind: "muted", text: "No account on this deck to share yet" });
  out.push({ id: "shareActive", kind: "setting", label: "Show paired decks which of these this deck is using", on: s.shareActive === true });
  out.push({ id: "sendInUse", kind: "setting", label: "Send the login this deck is using too", on: s.sendInUse === true, warn: true });
  const inviteOnly = s.pairingMode === "invite";
  out.push({ kind: "head", text: "Pairing" });
  out.push({ id: "inviteOnly", kind: "setting", label: "Pair new decks only by invite", on: inviteOnly });
  out.push({ kind: "sub", text: inviteOnly ? `Automatic pairing · ${PAUSED}` : "Automatic pairing" });
  out.push({ id: "autoAsk", kind: "setting", label: "Ask every deck this one finds", on: s.autoAsk === true, paused: inviteOnly });
  out.push({ id: "autoAccept", kind: "setting", label: "Say yes to every deck that asks", on: s.autoAccept === true, paused: inviteOnly, warn: true });
  const ts = s.tailscale;
  if (ts?.found) {
    out.push({ kind: "head", text: "Tailscale" });
    out.push({ id: "tailscale", kind: "setting", label: "Look for my devices", on: ts.on === true, detail: tailscaleDetail(ts) });
    if (ts.on) {
      out.push({ kind: "sub", text: inviteOnly ? `Automatic pairing with my devices · ${PAUSED}` : "Automatic pairing with my devices" });
      out.push({ id: "tailscaleAsk", kind: "setting", label: "Ask each device it finds", on: ts.ask === true, paused: inviteOnly });
      out.push({ id: "tailscaleAccept", kind: "setting", label: "Say yes to each device that asks", on: ts.accept === true, paused: inviteOnly });
    }
  }
  return out;
}

/** What stops other decks finding this one, said under the switch as the
 *  panel says it (LanDiscoveryNotes.tsx): the firewall, with the commands
 *  that open it; a deck that cannot hear; a tunnel. */
function lanNotes(s) {
  const out = [];
  if (s.reach?.blocked) {
    out.push({ text: oneLine(s.reach.text ?? "Other decks cannot reach this one."), tone: "warn" });
    for (const step of Array.isArray(s.reach.steps) ? s.reach.steps : []) out.push({ text: `$ ${oneLine(step)}`, tone: "muted" });
  }
  if (s.deaf) out.push({ text: oneLine(s.deaf), tone: "muted" });
  if (s.lanTunneled) {
    out.push({
      text: s.tailscale?.exitNode
        ? "Tailscale sends this machine's local network through an exit node, so decks on this network cannot find this one. Turn on Allow local network access in Tailscale's exit node menu to bring them back."
        : "This machine sends its local network through a VPN, so decks on this network cannot find this one. Allowing local network access in the VPN brings them back.",
      tone: "muted",
    });
  }
  return out;
}

/** Tailscale on this machine, as the setup dialog says it (tailscaleDetail). */
function tailscaleDetail(ts) {
  if (!ts.running) {
    const why = ts.state === "Stopped" ? "turned off"
      : ts.state === "NeedsLogin" || ts.state === "NeedsMachineAuth" ? "signed out"
      : ts.state === "Starting" ? "still starting"
      : "not answering";
    return `Tailscale is ${why} on this machine`;
  }
  const whose = ts.login ?? "your Tailscale account";
  return ts.on ? `${ts.devices ?? 0} online · ${whose}` : whose;
}

/** The rows a person can land on. */
const selectable = (items) => items.filter(i => i.id);

/** The selected row: the one named by `lanSel`, or the first. */
export function lanSelected(state, now) {
  const rows = selectable(lanItems(state, now));
  return rows.find(i => i.id === state.lanSel) ?? rows[0] ?? null;
}

// ── drawn ───────────────────────────────────────────────────────────────────

const TONE_OF = { bad: "err", warn: "warn", wait: "accent", ok: "ok", idle: "muted" };

/**
 * The panel's rows for `width` columns: `{ lines, selected, foot }`, the
 * selected row's index into `lines`, and what the panel's foot says — when
 * the deck last checked its paired decks.
 */
export function lanLines(state, width, look) {
  const { tone, g, unicode, now } = look;
  const s = state.lan;
  const items = lanItems(state, now);
  const sel = lanSelected(state, now);
  const box = (on) => (on ? (unicode ? "[✓]" : "[x]") : "[ ]");
  const lines = [];
  let selected = -1;
  const right = (left, tail) => {
    const gap = width - textWidth(left) - textWidth(tail);
    return tail && gap >= 2 ? `${left}${" ".repeat(gap)}${tail}` : left;
  };
  for (const item of items) {
    if (item === sel) selected = lines.length;
    if (item.kind === "switch") {
      const st = lanSectionState(s, now);
      const tail = item.on ? (st.text ? `${tone[TONE_OF[st.tone]] ?? ""}${oneLine(st.text)}${tone.reset}` : "")
        : `${tone.muted}Off${tone.reset}`;
      lines.push(right(`${box(item.on)} ${tone.bold}Sync with paired decks${tone.reset}`, tail));
    } else if (item.kind === "note") {
      lines.push(...wrap(item.text, width - 4).map((l, i) => `${i ? "    " : `  ${item.tone === "warn" ? `${tone.warn}!${tone.reset} ` : "  "}`}${tone[item.tone] ?? ""}${l}${tone.reset}`));
    } else if (item.kind === "self") {
      const name = oneLine(s.name) || "";
      const where = s.addrs?.length && s.port ? `${s.addrs[0]}:${s.port}` : "";
      const fp = s.fp ? `fingerprint ${s.fp}` : "fingerprint not known yet";
      const left = `${tone.muted}This deck${tone.reset}  ${name || `${tone.muted}this machine${tone.reset}`}${where ? `  ${tone.muted}${g.bullet} ${where}${tone.reset}` : ""}`;
      lines.push(right(left, `${tone.muted}${clip(fp, Math.max(12, width - textWidth(left) - 2), g.ellipsis)}${tone.reset}`));
    } else if (item.kind === "head") {
      // A rule after it, so the section reads as one without colour too.
      const rest = width - textWidth(item.text) - 1;
      lines.push(`${tone.accent}${tone.bold}${item.text}${tone.reset}${rest > 0 ? ` ${tone.muted}${(unicode ? "─" : "-").repeat(rest)}${tone.reset}` : ""}`);
    } else if (item.kind === "sub") {
      lines.push(`${tone.muted}${item.text}${tone.reset}`);
    } else if (item.kind === "muted") {
      lines.push(...wrap(item.text, width - 2).map(l => `  ${tone.muted}${l}${tone.reset}`));
    } else if (item.kind === "deck") {
      lines.push(deckLine(item.row, width, { tone, g, unicode }));
    } else if (item.kind === "share") {
      const r = item.row;
      const mark = r.mark ? `${tone.muted}${r.mark}${tone.reset}` : "";
      lines.push(right(`${box(r.shared)} ${oneLine(r.email) || r.key}`, mark));
    } else if (item.kind === "setting") {
      const lit = item.on && item.warn ? tone.warn : "";
      const label = `${item.paused ? tone.muted : lit}${item.label}${tone.reset}`;
      const tail = item.paused ? `${tone.muted}paused${tone.reset}` : item.detail ? `${tone.muted}${item.detail}${tone.reset}` : "";
      lines.push(right(`${box(item.on)} ${label}`, tail));
    }
  }
  const foot = s?.enabled ? lanChecked(s, now) : "";
  const plain = look.plain ?? ((l) => l);
  return { lines: lines.map(plain), selected, foot };
}

/** A deck's row: its dot, its name, how many decks the machine runs, and
 *  what it is doing in the deck's words, coloured by how that is going. */
function deckLine(row, width, { tone, g, unicode }) {
  const dot = row.kind === "asks" ? `${tone.warn}${unicode ? "●" : "*"}${tone.reset}`
    : row.here ? `${tone.ok}${unicode ? "●" : "*"}${tone.reset}`
    : row.kind === "declined" ? `${tone.muted}${unicode ? "×" : "x"}${tone.reset}`
    : `${tone.muted}${unicode ? "○" : "o"}${tone.reset}`;
  const twins = Array.isArray(row.twins) && row.twins.length > 1 ? ` ${tone.muted}${g.bullet} ${row.twins.length} decks${tone.reset}` : "";
  const via = row.via === "tailscale" ? ` ${tone.muted}${g.bullet} Tailscale${tone.reset}` : "";
  const name = `${tone.bold}${clip(oneLine(row.name) || row.addr || row.fp, Math.max(8, Math.floor(width / 3)), g.ellipsis)}${tone.reset}`;
  const left = `${dot} ${name}${via}${twins}`;
  const state = oneLine(row.state);
  const room = width - textWidth(left) - 2;
  if (!state || room < 6) return left;
  // A quiet row — online, nothing to report — says so in the muted ink the
  // panel would not draw it in at all.
  const ink = row.quiet ? tone.muted : tone[TONE_OF[row.tone]] ?? tone.muted;
  return `${left}  ${ink}${clip(state, room, g.ellipsis)}${tone.reset}`;
}

/** When the deck last checked its paired decks, as the list's foot says it. */
function lanChecked(s, now) {
  const at = s.checkedAt;
  if (at == null) return "not checked yet";
  const ago = Math.max(0, now - at);
  if (ago < 10_000) return "checked just now";
  const m = Math.round(ago / 60_000);
  return m < 1 ? `checked ${Math.round(ago / 1000)}s ago` : m < 60 ? `checked ${m}m ago` : `checked ${Math.round(m / 60)}h ago`;
}

/** The keys that do something on the selected row, for the footer. */
export function lanFooterKeys(state, { now, unicode }) {
  const item = lanSelected(state, now);
  const s = state.lan;
  const keys = [[unicode ? "↑↓" : "up/down", "move"]];
  if (item?.kind === "switch") keys.push(["space", item.on ? "turn off" : "turn on"]);
  else if (item?.kind === "setting") keys.push(["space", item.paused ? "paused" : item.on ? "turn off" : "turn on"]);
  else if (item?.kind === "share") keys.push(["space", item.row.shared ? "stop sharing" : "share"]);
  else if (item?.kind === "self") keys.push(["n", "rename this deck"]);
  else if (item?.kind === "deck") {
    const r = item.row;
    if (r.kind === "asks") keys.push(["enter", "accept"], ["x", "decline"]);
    else if (r.kind === "paired") keys.push(...(r.oneWay ? [] : [["enter", "check now"]]), ["n", "name it"], ["x", "unpair"]);
    else if (r.kind === "nearby") keys.push(["enter", s?.pairingMode === "invite" ? "invite" : "ask to pair"]);
    else if (r.kind === "declined") keys.push(["enter", "let it ask again"]);
    else if (r.kind === "dialling") keys.push(["x", "stop dialling"]);
  }
  keys.push(["+", "add a deck"]);
  if (s?.enabled) keys.push(["r", "check all"]);
  return keys;
}

// ── the keys ────────────────────────────────────────────────────────────────

/**
 * A key on the Network list: `{ state, effect }`, or null for a key this side
 * does not take (quitting, help, the sides, the machine's keys). `note` is
 * tui-view.mjs's.
 *
 * Effects:
 *   { type: "lan-prefs", patch, doing, said }       POST /api/prefs { lan: patch }
 *   { type: "lan-peer", action, fp, name?, doing, said }   POST /api/lan/peer
 *   { type: "lan-invite", action, token?, doing }   POST /api/lan/invite
 *   { type: "lan-sync", fp?, doing, said }          POST /api/lan/sync
 */
export function lanKey(state, str, key, { now, g, note }) {
  if (state.lanForm) return lanFormKey(state, str, key, { now, g, note });
  const name = key.name ?? "";
  const told = (tone, text) => ({ state: { ...state, notice: note(tone, text, now) }, effect: null });
  const rows = selectable(lanItems(state, now));
  const found = rows.findIndex(i => i.id === state.lanSel);
  const at = found === -1 ? 0 : found;
  const item = rows[at] ?? null;
  const go = (i) => ({ state: { ...state, notice: null, lanSel: rows[Math.max(0, Math.min(rows.length - 1, i))]?.id ?? null }, effect: null });
  if (name === "up" || str === "k") return go(at <= 0 ? rows.length - 1 : at - 1);
  if (name === "down" || str === "j" || (name === "tab" && !key.shift)) return go(at >= rows.length - 1 ? 0 : at + 1);
  if (name === "home" || str === "g") return go(0);
  if (name === "end" || str === "G") return go(rows.length - 1);
  if (name === "pageup") return go(at - 5);
  if (name === "pagedown") return go(at + 5);

  const s = state.lan;
  const enter = name === "return" || name === "enter";
  const space = str === " ";
  const wantsDeck = enter || space || str === "x" || name === "delete" || str === "n" || str === "+" || str === "r";
  if (wantsDeck && !state.deck) return told("info", `Local network is the deck's ${g.dash} d starts one`);
  if (wantsDeck && state.busy) return told("info", `${state.busy.text} ${g.dash} one thing at a time`);
  if (wantsDeck && !s) return told("info", `reading the Local network${g.ellipsis}`);

  if (str === "+") return addOpen(state, now, g, note);
  if (str === "r") {
    if (!s.enabled) return { state, effect: { type: "refresh" } };
    return { state, effect: { type: "lan-sync", doing: "checking every paired deck", said: "checked every paired deck" } };
  }
  if (!item) return null;

  if (item.kind === "switch" && (enter || space)) {
    const on = !item.on;
    return {
      state,
      effect: {
        type: "lan-prefs", patch: { enabled: on },
        doing: on ? "turning Local network on" : "turning Local network off",
        said: on ? `Local network on ${g.dash} paired decks get the accounts ticked here` : `Local network off ${g.dash} nothing goes out or comes in`,
      },
    };
  }
  if (item.kind === "setting" && (enter || space)) {
    if (item.paused) return told("info", "Paused while this deck pairs only by invite. Turn that off above to use it.");
    return { state, effect: settingEffect(item, g) };
  }
  if (item.kind === "share" && (enter || space)) {
    const r = item.row;
    const who = oneLine(r.email) || r.key;
    return {
      state,
      effect: {
        type: "lan-prefs", patch: { shared: toggleShared(s.shared ?? [], r.key) },
        doing: r.shared ? `no longer sharing ${who}` : `sharing ${who}`,
        said: r.shared ? `${who} is no longer offered ${g.dash} a copy a deck already has stays there` : `${who} is offered to the paired decks`,
      },
    };
  }
  if (item.kind === "self" && (enter || str === "n")) {
    return { state: { ...state, lanForm: { view: "name", draft: oneLine(s.name), error: null } }, effect: null };
  }
  if (item.kind === "deck") return deckKey(state, item.row, str, name, { now, g, note });
  return null;
}

function settingEffect(item, g) {
  const on = !item.on;
  const patch = item.id === "inviteOnly" ? { pairingMode: on ? "invite" : "automatic" } : { [item.id]: on };
  const said = item.id === "inviteOnly"
    ? (on ? `new decks pair only by invite ${g.dash} requests waiting now are turned away` : "decks on this network can pair on their own again")
    : `${item.label} ${g.dash} ${on ? "on" : "off"}`;
  return { type: "lan-prefs", patch, doing: `${on ? "turning on" : "turning off"}: ${item.label.toLowerCase()}`, said };
}

/** A key on a deck's row: what its one verb does, and the others. */
function deckKey(state, row, str, name, { now, g, note }) {
  const told = (tone, text) => ({ state: { ...state, notice: note(tone, text, now) }, effect: null });
  const s = state.lan;
  const enter = name === "return" || name === "enter" || str === " ";
  const drop = str === "x" || name === "delete";
  const who = oneLine(row.name) || row.addr || row.fp;
  const peer = (action, doing, said) => ({ state, effect: { type: "lan-peer", action, fp: row.fp, doing, said } });
  if (str === "n") {
    if (row.kind === "dialling") return told("info", `${who} is an address this deck calls ${g.dash} it has a name once it answers`);
    return { state: { ...state, lanForm: { view: "alias", fp: row.fp, name: who, self: row.self ?? null, draft: row.self ? who : "", error: null } }, effect: null };
  }
  if (row.kind === "asks") {
    if (enter) return peer("accept", `accepting ${who}`, `paired with ${who}`);
    if (drop) return peer("dismiss", `declining ${who}`, `said no to ${who} ${g.dash} enter on its row lets it ask again`);
  }
  if (row.kind === "paired") {
    if (enter) {
      if (row.oneWay) return told("info", "There is no address here to call it on. It calls this deck, and it is up to date each time it does.");
      return { state, effect: { type: "lan-sync", fp: row.fp, doing: `checking ${who}`, said: `checked ${who}` } };
    }
    if (drop) return { state: { ...state, lanForm: { view: "unpair", fp: row.fp, name: who, twins: Array.isArray(row.twins) ? row.twins.length : 1 } }, effect: null };
  }
  if (row.kind === "nearby" && enter) {
    if (s.pairingMode === "invite") return addOpen(state, now, g, note, "invite");
    return peer("accept", `asking ${who} to pair`, `asked ${who} to pair ${g.dash} somebody there says yes, or its deck does`);
  }
  if (row.kind === "declined" && enter) return peer("allow", `letting ${who} ask again`, `${who} can ask to pair again`);
  if (row.kind === "dialling") {
    if (drop) {
      const manual = state.lanPrefs?.manual;
      if (!Array.isArray(manual)) return told("info", `reading the addresses this deck calls${g.ellipsis}`);
      // A dialling row is named by the "host:port" it dials (lan-roster.ts).
      const entry = row.fp;
      return {
        state,
        effect: { type: "lan-prefs", patch: { manual: manual.filter(m => m !== entry) }, doing: `no longer calling ${entry}`, said: `stopped calling ${entry}` },
      };
    }
    if (enter) return told("info", `trying ${who} every round ${g.dash} x stops it`);
  }
  return enter || drop ? { state, effect: null } : null;
}

// ── adding a deck, naming, unpairing ────────────────────────────────────────

const ADD_ITEMS = Object.freeze([
  { id: "address", key: "a", label: "By its address" },
  { id: "invite", key: "i", label: "Make an invite to send them" },
  { id: "join", key: "p", label: "Paste an invite you were sent" },
]);

function addOpen(state, now, g, note, start = null) {
  const s = state.lan;
  if (start === "invite") return inviteMake(state, g);
  // Invite-only: adding by address is off, so the invite is where to start.
  const at = s?.pairingMode === "invite" ? 1 : 0;
  return { state: { ...state, lanForm: { view: "add", at, error: null } }, effect: null };
}

function inviteMake(state, g) {
  // An invite still good is shown again rather than replaced.
  if (state.lan?.invite?.token) return { state: { ...state, lanForm: { view: "invite", error: null } }, effect: null };
  return {
    state: { ...state, lanForm: { view: "invite", error: null } },
    effect: { type: "lan-invite", action: "make", doing: "making an invite" },
  };
}

/** A key while a form of the Network side is up. */
function lanFormKey(state, str, key, { now, g, note }) {
  const name = key.name ?? "";
  const f = state.lanForm;
  if (state.busy) return { state, effect: null };
  const set = (patch) => ({ state: { ...state, lanForm: { ...f, ...patch } }, effect: null });
  const close = () => ({ state: { ...state, lanForm: null }, effect: null });
  const enter = name === "return" || name === "enter";
  const s = state.lan ?? {};

  if (f.view === "add") {
    if (name === "escape" || str === "q") return close();
    if (name === "up" || str === "k") return set({ at: (f.at + ADD_ITEMS.length - 1) % ADD_ITEMS.length, error: null });
    if (name === "down" || str === "j" || name === "tab") return set({ at: (f.at + 1) % ADD_ITEMS.length, error: null });
    const pick = enter ? ADD_ITEMS[f.at] : ADD_ITEMS.find(i => i.key === str);
    if (!pick) return { state, effect: null };
    if (pick.id === "address") {
      if (s.pairingMode === "invite") return set({ at: ADD_ITEMS.indexOf(pick), error: "Adding by address is off while this deck pairs only by invite." });
      return set({ view: "address", draft: "", error: null });
    }
    if (pick.id === "invite") return inviteMake(state, g);
    return set({ view: "join", draft: "", error: null, tried: null });
  }

  if (f.view === "invite") {
    if (str === "x" && s.invite?.token) {
      return {
        state: { ...state, lanForm: null },
        effect: { type: "lan-invite", action: "withdraw", doing: "cancelling the invite", said: "invite cancelled — the text can no longer be used" },
      };
    }
    return close();
  }

  if (f.view === "unpair") {
    if (str === "y" || str === "Y") {
      return {
        state: { ...state, lanForm: null },
        effect: { type: "lan-peer", action: "unpair", fp: f.fp, doing: `unpairing ${f.name}`, said: `unpaired ${f.name} ${g.dash} logins no longer go between the two decks` },
      };
    }
    return close();
  }

  // The fields: this deck's name, a name for another deck, an address, an invite.
  const back = () => (f.view === "address" || f.view === "join"
    ? set({ view: "add", at: f.view === "address" ? 0 : 2, draft: "", error: null, tried: null })
    : close());
  if (name === "escape") return back();
  if (name === "backspace") return set({ draft: [...f.draft].slice(0, -1).join(""), error: null });
  if (key.ctrl && name === "u") return set({ draft: "", error: null });
  const max = f.view === "alias" ? ALIAS_MAX : f.view === "name" ? NAME_MAX : f.view === "join" ? 4096 : 260;
  const typed = typeof str === "string" && str.length > 0 && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(str);
  if (typed) return set({ draft: [...`${f.draft}${str}`].slice(0, max).join(""), error: null });
  if (!enter) return { state, effect: null };

  const draft = f.draft.trim();
  if (f.view === "name") {
    return {
      state,
      effect: {
        type: "lan-prefs", patch: { name: draft }, doing: "renaming this deck",
        said: draft ? `other decks see this one as ${draft}` : "other decks see this one by its machine's name",
      },
    };
  }
  if (f.view === "alias") {
    return {
      state,
      effect: {
        type: "lan-peer", action: "alias", fp: f.fp, name: draft, doing: `naming ${f.name}`,
        said: draft ? `${f.name} is ${draft} on this deck` : `${f.name} goes by its own name again`,
      },
    };
  }
  if (f.view === "address") {
    const parsed = parseAddress(draft);
    if (!parsed) return set({ error: addressFault(draft) });
    const entry = `${parsed.addr}:${parsed.port}`;
    const met = (s.peers ?? []).find(p => p.addr === parsed.addr && p.port === parsed.port && p.paired);
    if (met) return set({ error: `Already paired with ${oneLine(met.name)} at that address.` });
    const manual = state.lanPrefs?.manual;
    if (!Array.isArray(manual)) return set({ error: `reading the addresses this deck calls${g.ellipsis} try again in a moment` });
    if (manual.includes(entry)) return set({ error: "This deck already calls that address." });
    return {
      state,
      effect: {
        type: "lan-prefs", patch: { manual: [...manual, entry] }, doing: `adding ${entry}`,
        said: `calling ${entry} ${g.dash} it is asked to pair until somebody there accepts`,
      },
    };
  }
  if (f.view === "join") {
    if (!draft) return set({ error: "Paste the whole line they sent you." });
    if (!draft.startsWith(INVITE_PREFIX)) return set({ error: "That is not an invite — paste the whole line they sent you." });
    return { state, effect: { type: "lan-invite", action: "join", token: draft, doing: "joining with the invite" } };
  }
  return { state, effect: null };
}

/**
 * The form in its box: `{ title, footRight, lines, selected }` for
 * tui-view.mjs to draw, `inner` columns wide.
 */
export function lanFormSpec(state, inner, look) {
  const spec = formSpec(state, inner, look);
  const plain = look.plain ?? ((l) => l);
  const each = (v) => (Array.isArray(v) ? v.map(plain) : typeof v === "string" ? plain(v) : v);
  return { ...spec, title: each(spec.title), note: each(spec.note), footRight: each(spec.footRight), lines: spec.lines.map(plain) };
}

function formSpec(state, inner, { tone, g, unicode, now }) {
  const f = state.lanForm;
  const s = state.lan ?? {};
  const say = (text, code = tone.muted) => wrap(text, inner).map(l => `${code}${l}${tone.reset}`);
  const refused = f.error ? wrap(f.error, inner - 3).map((l, i) => `${tone.err}${i ? "   " : `${g.fail}  `}${l}${tone.reset}`) : [];
  const caret = `${tone.accent}${unicode ? "▏" : "_"}${tone.reset}`;
  // A long draft — an invite — shows its end, where the typing is.
  const field = (text) => {
    const room = inner - 3;
    const shown = textWidth(text) > room ? `${g.ellipsis}${[...text].slice(-(room - 1)).join("")}` : text;
    return `${tone.accent}${unicode ? "›" : ">"}${tone.reset} ${shown}${caret}`;
  };
  const back = (verb) => [`${tone.muted}enter ${verb} ${g.bullet} esc back${tone.reset}`, `${tone.muted}esc back${tone.reset}`];
  if (f.view === "add") {
    const inviteOnly = s.pairingMode === "invite";
    const lines = [];
    let selected = -1;
    ADD_ITEMS.forEach((item, i) => {
      if (i === f.at) selected = lines.length;
      const pointer = i === f.at ? `${tone.accent}${tone.bold}${unicode ? "›" : ">"}${tone.reset}` : " ";
      const off = item.id === "address" && inviteOnly;
      const room = inner - 5;
      lines.push(`${pointer} ${off ? tone.muted : ""}${padEnd(clip(item.label, room, g.ellipsis), room)}${tone.reset} ${tone.muted}${item.key}${tone.reset}`);
    });
    const where = s.addrs?.length && s.port ? `${s.addrs[0]}:${s.port}` : null;
    return {
      title: `${tone.bold}Add a deck${tone.reset}`,
      footRight: [`${tone.muted}enter chooses ${g.bullet} esc closes${tone.reset}`, `${tone.muted}esc closes${tone.reset}`],
      lines: [
        ...lines,
        "",
        ...(inviteOnly ? say("Adding by address is off while this deck pairs only by invite.")
          : where ? say(`They type this deck's own address into the same field on theirs: ${where}`) : []),
        ...refused,
      ],
      selected,
    };
  }
  if (f.view === "address") {
    return {
      title: `${tone.bold}Add a deck by its address${tone.reset}`,
      footRight: back("adds it"),
      lines: [...say("The other deck's address and port, like 192.168.1.5:54340. This deck calls it until somebody there accepts.", ""), "", field(f.draft), ...refused],
    };
  }
  if (f.view === "join") {
    return {
      title: `${tone.bold}Paste an invite${tone.reset}`,
      footRight: back("joins"),
      lines: [...say("Pasting one pairs both decks on the spot — nobody has to accept.", ""), "", field(f.draft), ...refused,
        ...(Array.isArray(f.tried) && f.tried.length ? f.tried.map(t => `${tone.muted}   ${oneLine(t.addr)}: ${oneLine(t.why)}${tone.reset}`) : [])],
    };
  }
  if (f.view === "invite") {
    const inv = s.invite;
    if (!inv?.token) {
      return {
        title: `${tone.bold}Invite to pair${tone.reset}`,
        footRight: `${tone.muted}esc closes${tone.reset}`,
        lines: [...(state.busy ? say(`making the invite${g.ellipsis}`) : f.error ? [] : say("The invite ran out or was cancelled. + makes a fresh one.")), ...refused],
      };
    }
    const left = Math.max(0, Math.round(((inv.expiresAt ?? now) - now) / 1000));
    const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
    return {
      title: `${tone.bold}Send this to them${tone.reset}`,
      note: `${tone.muted}${clock}${tone.reset}`,
      footRight: [`${tone.muted}x cancels it ${g.bullet} esc closes${tone.reset}`, `${tone.muted}esc closes${tone.reset}`],
      lines: [
        ...say("They paste it in Add a deck on theirs, and the two decks pair. Select it to copy it.", ""),
        "",
        ...chunks(inv.token, inner).map(l => `${tone.accent}${l}${tone.reset}`),
        "",
        ...say("Anyone who gets this text can pair with this deck until it runs out."),
        ...refused,
      ],
    };
  }
  if (f.view === "unpair") {
    return {
      title: `${tone.err}${tone.bold}Unpair ${f.name}?${tone.reset}`,
      footRight: `${tone.muted}any other key keeps it${tone.reset}`,
      lines: [
        ...say(f.twins > 1
          ? `Logins stop going between this deck and the ${f.twins} decks on that machine. Pairing again takes a request or an invite.`
          : "Logins stop going between the two decks. Pairing again takes a request or an invite.", ""),
        "",
        `${tone.bold}y${tone.reset} ${tone.muted}unpairs it${tone.reset}`,
        ...refused,
      ],
    };
  }
  if (f.view === "alias") {
    return {
      title: `${tone.bold}Name ${f.name}${tone.reset}`,
      footRight: back("saves"),
      lines: [...say(`Only this deck shows the name.${f.self ? ` It calls itself ${f.self}.` : ""} Empty puts back its own.`, ""), "", field(f.draft), ...refused],
    };
  }
  return {
    title: `${tone.bold}This deck's name on the network${tone.reset}`,
    footRight: back("saves"),
    lines: [...say("The name other decks show for this one. Empty uses the machine's name.", ""), "", field(f.draft), ...refused],
  };
}

// ── the invite, to send ─────────────────────────────────────────────────────

/** Whether the invite shows as a page of its own: once there is one to send.
 *  In a box its text would wrap between borders and copy with them. */
export const lanInvitePage = (state) => state.lanForm?.view === "invite" && Boolean(state.lan?.invite?.token);

/** The keys the invite page takes. */
export const lanInviteKeys = () => [["x", "cancel it"], ["esc", "close"]];

/**
 * The invite as a page, `room` rows under the title bar: what to do with it,
 * the text itself written edge to edge as one run the terminal wraps — so a
 * selection copies it whole, as the sign-in link is — and the warning that
 * goes with it. `{ lines, run }`, as signinLines gives.
 */
export function lanInviteLines(state, room, width, columns, look) {
  const { tone, g, now } = look;
  const plain = look.plain ?? ((l) => l);
  const inv = state.lan.invite;
  const token = String(inv.token);
  const say = (text, code = tone.muted) => wrap(text, width - 4).map(l => plain(`  ${code}${l}${tone.reset}`));
  const left = Math.max(0, Math.round(((inv.expiresAt ?? now) - now) / 1000));
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left`;
  const pieces = chunks(token, columns);
  const blocks = {
    top: [""],
    head: [plain(`  ${tone.bold}Send this to them${tone.reset}  ${tone.muted}${g.bullet} ${clock}${tone.reset}`)],
    what: say("They paste it in Add a deck on theirs, and the two decks pair. Nobody has to press anything here. Select it to copy it."),
    gap: [""],
    token: pieces,
    after: ["", ...say("Anyone who gets this text can pair with this deck until it runs out.")],
    error: state.lanForm.error ? ["", ...say(state.lanForm.error, tone.err)] : [],
  };
  const order = ["top", "head", "what", "gap", "token", "error", "after"];
  const shown = new Set(order);
  const height = () => order.filter(b => shown.has(b)).reduce((n, b) => n + blocks[b].length, 0);
  for (const drop of ["after", "what", "top", "gap"]) {
    if (height() <= room) break;
    shown.delete(drop);
  }
  if (height() > room) blocks.token = say(`make the window taller to see the invite ${g.dash} it needs ${pieces.length} rows`, tone.warn);
  const lines = [];
  let run = null;
  for (const b of order) {
    if (!shown.has(b)) continue;
    if (b === "token" && blocks.token === pieces) run = { row: lines.length, rows: pieces.length, full: token.length % columns === 0, text: `${tone.accent}${token}${tone.reset}` };
    lines.push(...blocks[b]);
  }
  return { lines: [...lines, ...Array.from({ length: Math.max(0, room - lines.length) }, () => "")].slice(0, room), run: run && run.row + run.rows <= room ? run : null };
}

// ── the deck's answers ──────────────────────────────────────────────────────

/** What a Local network refusal means, in the deck's words. */
export const LAN_REFUSED = Object.freeze({
  not_seen: "this deck has not heard that one yet, or pairs only by invite",
  not_running: "This deck is not on the network yet. Turn Local network on, then try again.",
  no_address: "There is no address here to call it on. It calls this deck, and it is up to date each time it does.",
  not_an_invite: "That is not an invite — paste the whole line they sent you.",
  expired: "That invite has run out. Ask them for a fresh one.",
  unreachable: "Nothing answered at any address in that invite. Check that deck is running with its Local network switch on.",
  prefs_unreadable: "this deck cannot read its settings file, so it will not write over it. The deck's log names the file.",
  prefs_not_writable: "this deck is not allowed to save its settings. The deck's log names the folder.",
  bad_request: "the deck did not take that",
  unknown_action: "this deck does not know that yet — an update of ccdeck brings it",
});

// ── the address, as the add dialog reads it (lan-add-deck.ts) ───────────────

/** An address somebody typed, or null: a host — a name, an IPv4, a bracketed
 *  IPv6 — and a port from 1 to 65535, split on the last colon. */
export function parseAddress(raw) {
  const s = String(raw ?? "").trim();
  const at = s.lastIndexOf(":");
  if (at <= 0 || at === s.length - 1) return null;
  const addr = s.slice(0, at).trim();
  const port = Number(s.slice(at + 1).trim());
  if (!addr || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (addr.includes(":") && !(addr.startsWith("[") && addr.endsWith("]"))) return null;
  return { addr, port };
}

/** Why an address was refused, in the terms of what is wrong with it. */
export function addressFault(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return "Type an address and a port, like 192.168.1.5:54340.";
  if (!s.startsWith("[") && (s.match(/:/g) ?? []).length > 1) {
    return "Too many colons to split. Use that deck's IPv4 address or its name, like 192.168.1.5:54340.";
  }
  if (!s.includes(":")) return `Add the port too, like ${s}:54340.`;
  const port = s.slice(s.lastIndexOf(":") + 1).trim();
  if (port === "") return "That is missing its port — try 192.168.1.5:54340.";
  if (!/^\d+$/.test(port)) return `A port is a number, and this one is "${port}".`;
  return `A port runs from 1 to 65535, and this one is ${port}.`;
}

// ── text ────────────────────────────────────────────────────────────────────

const padEnd = (s, n) => s + " ".repeat(Math.max(0, n - textWidth(s)));

function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    if (line && textWidth(`${line} ${word}`) > width) { out.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.flatMap(l => (textWidth(l) > width ? chunks(l, width) : [l]));
}

/** Text with no spaces — an invite, a command — cut into lines `width` wide. */
function chunks(text, width) {
  const cells = [...String(text)];
  const out = [];
  for (let i = 0; i < cells.length; i += Math.max(1, width)) out.push(cells.slice(i, i + Math.max(1, width)).join(""));
  return out.length ? out : [""];
}
