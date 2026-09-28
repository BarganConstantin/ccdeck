// The LAN section's conversation with its own deck: the poll that reads what
// the deck knows about the network, and every write the section makes to it.
//
// Lifted out of LanSyncSection.tsx unchanged — the status and the dial list,
// the clock the rows are drawn against, the one request slot every control
// shares, the failure line, and the six verbs. What that buys is the writer
// count. `status` is replaced by a poll or by the answer to a write and by
// nothing else, `busy` is taken and given back only through the slot, and the
// failure line changes only through the verbs and its own ×; none of those
// setters is visible to the markup any more. The component gets what to draw,
// `pressProps` for its controls, and the verbs by name.
//
// One press here opens something that is the component's: switching the
// network on opens the setup dialog, so `toggle` says so through
// `onSwitchedOn`, at the moment it always did.
import { useCallback, useEffect, useRef, useState } from "react";

import type { LanStatus } from "./lan-types";
import { pressAccepted, pressState } from "./panel-press";

/** How often to ask the deck about the network while it IS on the network.
 *  A pairing request arriving is the point of this section and of the dialog in
 *  App, so both ask at the same cadence and it is a short one. */
export const LAN_POLL_ON_MS = 5_000;

/** …and while it is not.
 *
 *  Nothing can arrive: no beacon is running, nobody can dial in, `pending`
 *  cannot become anything and the peer list cannot change. The only event this
 *  cadence has to catch is somebody switching it on in another tab. Right after
 *  a switch-on nothing can arrive instantly either — a peer has to hear the
 *  beacon first, which is up to thirty seconds — so a poller that is a minute
 *  late to speed up is a minute late for nothing. */
export const LAN_POLL_OFF_MS = 60_000;

/**
 * Why a write did not happen, in words rather than in silence.
 *
 * Every one of these was silence. The distinction matters because the two cases
 * fail for completely different causes and lead to completely different next
 * moves: a deck that answered `bad_request` has a panel bug behind it, and a
 * deck that answered nothing at all has stopped.
 */
export function writeFailure(
  what: string,
  out: { ok?: boolean; reason?: string; detail?: RefusalDetail | null } | null,
): string {
  if (out == null) return `Could not ${what} — the deck did not answer.`;
  const machine = out.reason ? outOfReach(out.reason, out.detail) : undefined;
  if (machine) return `Could not ${what} — ${machine}`;
  return out.reason
    ? `Could not ${what} — the deck refused it (${out.reason}).`
    : `Could not ${what}.`;
}

/** The two refusals whose next move is on the machine rather than in the panel
 *  (#1335), so a bracketed code would send the reader looking in the wrong
 *  place. The server keeps the path out of its answer; its log has it. */
const SETTINGS_OUT_OF_REACH: Record<string, string> = {
  prefs_unreadable: "this deck cannot read its settings file, so it will not write over it. "
    + "The file may belong to another user, for example after ccdeck was run with sudo. The deck's log names the file.",
  prefs_not_writable: "this deck is not allowed to save its settings. "
    + "The settings folder may belong to another user, for example after ccdeck was run with sudo, "
    + "or another program may be holding the file. The deck's log names the folder.",
};

/** What the deck says blocked a settings write — deck-prefs.mjs's
 *  prefsRefusalDetail: an errno, who owns what blocked it, file or folder.
 *  Closed sets, never a path. A deck older than this sends none. */
export type RefusalDetail = { code?: string; owner?: string; on?: string };

/** The only read errors that can be about who owns the file. */
const PERMISSION = new Set(["EACCES", "EPERM"]);

/**
 * The sentence for a settings write the machine refused, as exact as the deck
 * could make it (#1335), then the errno — so a screenshot of this line is enough
 * to tell the cases apart. The general sentence, which has to guess, is what is
 * left when the deck could not say more.
 */
function outOfReach(reason: string, detail?: RefusalDetail | null): string | undefined {
  const general = SETTINGS_OUT_OF_REACH[reason];
  if (!general) return undefined;
  const exact = reason === "prefs_unreadable" && detail ? unreadableBecause(detail) : undefined;
  const code = detail?.code && detail.code !== "BADJSON" ? ` Error code: ${detail.code}.` : "";
  return (exact ?? general) + code;
}

function unreadableBecause({ code, owner, on }: RefusalDetail): string | undefined {
  if (code === "BADJSON") {
    return "its settings file is damaged and could not be moved aside, so it will not write over it. "
      + "The deck's log names the file.";
  }
  if (on === "folder" && owner === "other") {
    return "this deck cannot open its settings folder, which belongs to another user, "
      + "for example after ccdeck was run with sudo. The deck's log has the command that gives it back.";
  }
  if (on === "folder" && owner === "you") {
    return "this deck cannot open its own settings folder, so it will not write over what is in it. "
      + "The deck's log names the folder.";
  }
  if (owner === "other") {
    return "its settings file belongs to another user and could not be moved aside, so it will not write over it. "
      + "The deck's log names the file.";
  }
  if (owner === "you") {
    return "this deck cannot read its settings file although the file is yours, so it will not write over it. "
      + "Something on this machine is blocking the read; the deck's log names the file.";
  }
  if (code && !PERMISSION.has(code)) {
    return "this deck cannot read its settings file, so it will not write over it. The deck's log names the file.";
  }
  return undefined;
}

async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

/**
 * @param onChanged The roster changed under the section — a healed account is
 *   a different row. The section's own prop, passed through.
 * @param onSwitchedOn A press switched the network on, and the write landed.
 */
export function useLanSection(onChanged: () => void, onSwitchedOn: () => void) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [manual, setManual] = useState<string[]>([]);
  /** WHICH control is working, not WHETHER one is — the tagged slot #518 wrote
   *  for this panel, which this section was spelling as one boolean.
   *
   *  It read the same to the eye only because nothing painted `aria-busy`. Now
   *  that something does, a shared boolean would light the switch, `setup…` and
   *  every accept at once on a press of any one of them — six controls claiming
   *  to be working when one is. The tag is what makes `pressState` able to tell
   *  "yours" from "somebody else's", which is the whole of the rule. */
  const [busy, setBusy] = useState<string | null>(null);
  /** The one thing this section could not say. See writeFailure. */
  const [failure, setFailure] = useState<string | null>(null);
  /** Read by the press guard rather than the state, because `busy` is a render
   *  behind: two clicks in the same frame both see `null` and both fire. */
  const busyRef = useRef<string | null>(null);

  /** Take the section's one request slot, or refuse the press. */
  const claim = useCallback((tag: string) => {
    if (!pressAccepted(busyRef.current)) return false;
    busyRef.current = tag;
    setBusy(tag);
    return true;
  }, []);
  const release = useCallback(() => {
    busyRef.current = null;
    if (alive.current) setBusy(null);
  }, []);
  /** Inert while somebody else is working; busy and still focusable while it is
   *  your own request. Spread rather than written out per control, so there is
   *  one answer rather than one per button. */
  const pressProps = (tag: string) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy };
  };
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);
  /** The cadence to use next, decided by the answer that just came back. Held
   *  in a ref rather than in state because it steers a timer rather than a
   *  render, and a re-render per tick is what this whole change is against. */
  const every = useRef<number>(LAN_POLL_ON_MS);

  const load = useCallback(async () => {
    try {
      const [lan, prefs] = await Promise.all([
        fetch("/api/lan").then(r => r.json()),
        fetch("/api/prefs").then(r => r.json()),
      ]);
      if (!alive.current) return;
      if (lan?.ok) setStatus(lan);
      if (prefs?.ok) setManual(Array.isArray(prefs.prefs?.lan?.manual) ? prefs.prefs.lan.manual : []);
      every.current = lan?.enabled === true ? LAN_POLL_ON_MS : LAN_POLL_OFF_MS;
    } catch { /* the deck is down; the connection banner already says so */ }
  }, []);

  useEffect(() => {
    alive.current = true;
    // A TIMEOUT CHAIN, NOT AN INTERVAL, so the cadence can change without the
    // effect being torn down and rebuilt.
    //
    // Five seconds while the network is ON: a pairing request arriving is the
    // point of this section, and it has to show up without a press. A minute
    // while it is OFF, where five seconds buys nothing at all — no beacon is
    // running, nobody can dial in, `pending` cannot become anything, and the
    // peer list cannot change. The only thing that can happen is somebody
    // turning it on in ANOTHER tab, and a minute is soon enough to notice that.
    //
    // Measured before this: three requests every five seconds, forever, for a
    // section reading "off — this deck is not on the network". Fifty-two
    // thousand a day.
    let timer = 0;
    const tick = async () => {
      setNow(Date.now());
      await load();
      if (alive.current) timer = window.setTimeout(tick, every.current);
    };
    void tick();
    return () => { alive.current = false; window.clearTimeout(timer); };
  }, [load]);

  const toggle = useCallback(async () => {
    const on = status?.enabled === true;
    if (!claim("switch")) return;
    try {
      const out = await post("/api/prefs", { lan: { enabled: !on } });
      if (!alive.current) return;
      if (out?.ok) {
        setFailure(null);
        // NOBODY GOES ON THE NETWORK WITHOUT HAVING SEEN WHAT GOES WITH THEM.
        // Switching on puts this deck's name in a beacon every other machine
        // hears and offers whichever logins the share list already holds — two
        // facts that lived one press deeper, behind `name & shared logins`, so
        // the ordinary way to turn this on was to turn it on and never look.
        // Every time and not only the first: what is shared changes between one
        // switch-on and the next, and a dialog shown once is a dialog about a
        // list that has since moved.
        //
        // OFF→ON ONLY, AND FROM THE PRESS RATHER THAN FROM `status.enabled`.
        // Reading the flag instead would pop this in front of somebody who
        // pressed nothing — on a reload, on the first poll of a deck that was
        // already on, or when the server switched it on by itself.
        if (!on) onSwitchedOn();
      } else {
        setFailure(writeFailure(on ? "turn this off" : "turn this on", out));
      }
      await load();
    } catch {
      if (alive.current) setFailure(writeFailure(on ? "turn this off" : "turn this on", null));
    } finally {
      release();
    }
  }, [status?.enabled, load, claim, release, onSwitchedOn]);

  /** Every verb the list has, through the one route that owns them. What each
   *  one MEANS is on the button; what they share is that the fingerprint comes
   *  from what this deck met on the wire and never from the page.
   *
   *  Answers with the sentence it put in the failure line, or null — so a
   *  deck's own dialog, which sits over that line, can say it where it is. */
  const answer = useCallback(async (
    action: "accept" | "dismiss" | "unpair" | "allow",
    fp: string,
    what: string,
  ): Promise<string | null> => {
    // Tagged per ROW rather than per section: two decks asking at once light
    // only the row that was actually pressed.
    if (!claim(`${action}:${fp}`)) return null;
    let said: string | null = null;
    try {
      const out = await post("/api/lan/peer", { action, fp });
      if (!alive.current) return null;
      if (out?.ok) { setStatus(out); setFailure(null); }
      else { said = writeFailure(what, out); setFailure(said); }
      await load();
    } catch {
      said = writeFailure(what, null);
      if (alive.current) setFailure(said);
    } finally {
      release();
    }
    return said;
  }, [load, claim, release]);

  /** Stop dialling an address that never answered.
   *
   *  Through prefs rather than through /api/lan/peer, because there is nothing
   *  to unpair: no deck was ever met here, and the row's fingerprint is a
   *  placeholder built out of the address. `setPeers` replaces the dial list
   *  wholesale on every prefs write, so filtering the entry out is the whole of
   *  the removal. */
  const dropAddress = useCallback(async (entry: string): Promise<string | null> => {
    if (!claim(`drop:${entry}`)) return null;
    let said: string | null = null;
    try {
      const out = await post("/api/prefs", { lan: { manual: manual.filter(m => m !== entry) } });
      if (!alive.current) return null;
      if (out?.ok) { setFailure(null); onChanged(); }
      else { said = writeFailure("stop dialling that address", out); setFailure(said); }
      await load();
    } catch {
      said = writeFailure("stop dialling that address", null);
      if (alive.current) setFailure(said);
    } finally {
      release();
    }
    return said;
  }, [manual, load, onChanged, claim, release]);

  /** Give a deck a name of this deck's own, or take it back with "". Its own
   *  dialog is the only caller, so the answer is the sentence to show there
   *  rather than a line in the section behind it. */
  const rename = useCallback(async (fp: string, name: string): Promise<string | null> => {
    if (!claim(`alias:${fp}`)) return "Something else is still being saved. Try again in a moment.";
    try {
      const out = await post("/api/lan/peer", { action: "alias", fp, name });
      if (!alive.current) return null;
      if (out?.ok) { setStatus(out); return null; }
      return writeFailure("rename that deck", out);
    } catch {
      return writeFailure("rename that deck", null);
    } finally {
      release();
    }
  }, [claim, release]);

  /** One deck, now, from its own dialog. A deck that only calls in has no
   *  address here, and the route says so rather than reporting a round that
   *  asked nobody. */
  const checkOne = useCallback(async (fp: string): Promise<string | null> => {
    if (!claim(`check:${fp}`)) return null;
    try {
      const out = await post("/api/lan/sync", { fp });
      if (!alive.current) return null;
      if (out?.ok) { setStatus(out); onChanged(); return null; }
      return out?.reason === "no_address"
        ? "There is no address here to call it on. It calls this deck, and it is up to date each time it does."
        : writeFailure("check that deck", out);
    } catch {
      return writeFailure("check that deck", null);
    } finally {
      release();
    }
  }, [claim, release, onChanged]);

  /** Ask every paired deck now rather than at the next tick — for somebody who
   *  has just fixed a login on the other machine and does not want to wait a
   *  minute to see it arrive. */
  const checkNow = useCallback(async () => {
    if (!claim("check")) return;
    try {
      const out = await post("/api/lan/sync", {});
      if (!alive.current) return;
      if (out?.ok) { setStatus(out); setFailure(null); }
      else setFailure(writeFailure("check the other decks", out));
      onChanged();
    } catch {
      if (alive.current) setFailure(writeFailure("check the other decks", null));
    } finally {
      release();
    }
  }, [claim, release, onChanged]);

  /** The failure line's ×. */
  const dismissFailure = () => setFailure(null);

  return {
    status, manual, now, busy, failure, dismissFailure, pressProps, load,
    toggle, answer, dropAddress, rename, checkOne, checkNow,
  };
}
