// AccountsPanel — every managed Claude account, its usage, and one click to
// switch between them. Toggled via the topbar button or the A shortcut.
//
// The data comes from claude-swap's local store, which the server reads rather
// than fetching: Anthropic's usage endpoint has a per-account request budget
// shared across every tool on the machine, so a dashboard that polled it
// directly would rate-limit the user's actual account. That has a visible
// consequence here — numbers can be minutes old, and saying so is part of the
// display rather than a caveat to hide.
import React, { useCallback, useEffect, useRef, useState } from "react";
import AddAccountDialog from "./AddAccountDialog";
import { commandOutput, explainCommandFailure, explainFailure } from "../admin-failure";
import { type SwapNote, manageAfterMove, slotChoices } from "../account-move";
import { type PickerCommit, slotCommit, slotShowing, thresholdCommit } from "../picker-commit";
import { laneSplit, lanesTitle, moreLabel } from "../lane-view";
import { knownLanes, laneKey, toggleLane } from "../lane-open";
import { focusDropped, pressAccepted, pressState, rescueSelectors } from "../panel-press";
import { ALIAS_MAX_LENGTH, aliasSave } from "../alias-save";
import { PRODUCT } from "../brand";
import {
  type Failure,
  RELOAD_UNREACHABLE,
  answered,
  explainReload,
  nextFailure,
} from "../accounts-reload";
import { resetCountdown, shortAgoSec } from "../relative-time";

interface Lane {
  id: string;
  label: string;
  pct: number;
  resetAt: number | null;   // unix seconds
}

interface Account {
  num: number;
  email: string | null;
  alias: string | null;
  org: string | null;
  active: boolean;
  disabled: boolean;
  lanes: Lane[];
  headroom: number | null;
  fetchedAt: number | null;  // unix ms
  nextAt: number | null;     // unix ms — claude-swap's next planned read
  stale: boolean;
  error: string | null;
}

interface AccountsData {
  ok: boolean;
  accounts?: Account[];
  activeNum?: number | null;
  reason?: string;
  hint?: string;
  fetchedAt?: number;
}

interface AutoTick {
  at: number;
  event: string;
  reason?: string | null;
  detail?: string | null;
  to?: number | null;
}

interface AutoStatus {
  ok: boolean;
  enabled: boolean;
  external: boolean;          // the user runs their own `cswap auto` loop
  lastTick: AutoTick | null;
  settings: Record<string, { value: string | null; isDefault: boolean }>;
}

const POLL_MS = 15_000;
// How long the "a second account moved too" line stands. Long enough to read a
// sentence the user did not ask for, short enough that a manage block left open
// does not keep reporting a move from ten minutes ago. Same shape as the
// panel's other transient states — `copied` at 1.8s, an armed remove at 4s.
const SWAP_NOTE_MS = 8_000;
// How long `save` stands as `saved`. The panel's other transient confirmations
// — `copied` on a share — use the same 1.8s, and the word is the whole signal.
const SAVED_MS = 1_800;
// Past this, a reload is called dead rather than slow. Both routes can spawn
// cswap, and the server kills those at 20 seconds, so anything shorter would
// abort answers that were still coming.
const RELOAD_TIMEOUT_MS = 30_000;
const THRESHOLDS = [70, 80, 85, 90, 95];

// This panel used to carry its own `countdown` and its own `ago`. The usage
// panel had the same countdown under another name and relative-time.ts had the
// same `ago` under `shortAgo` — and that module's header names THIS panel as
// one of the surfaces it exists to keep in one dialect (#374). Both now come
// from there; the wrapper below is what makes the second one exact rather than
// approximate.

/** The panel's ages, from a millisecond stamp and its second-resolution clock.
 *
 *  `shortAgo` takes a millisecond delta, and `shortAgo(nowSec * 1000 - at)`
 *  would NOT be what this panel computed: flooring a stamp that has a
 *  sub-second part after the subtraction lands a second lower than flooring it
 *  before, which walks every threshold by a second. Subtracting in seconds and
 *  handing the result to the seconds-form helper is character for character the
 *  arithmetic the private copy did. */
function ago(ms: number, nowSec: number): string {
  return shortAgoSec(nowSec - Math.floor(ms / 1000));
}

/**
 * " · next in 4m" — when claude-swap plans to read this account again.
 *
 * The age alone reads as neglect. The two together read as a cadence, which is
 * what it is: claude-swap sets the interval per account and every surface
 * inherits it, so a number that has not moved in ten minutes is on schedule
 * rather than stuck. Nothing is shown once the read is due, because at that
 * point the answer is "any moment now" and a countdown to zero that lingers is
 * worse than no countdown.
 */
function due(nextAt: number | null, nowSec: number): string {
  if (!nextAt) return "";
  const s = Math.floor(nextAt / 1000) - nowSec;
  if (s <= 0)  return " · due";
  if (s < 60)  return ` · next in ${s}s`;
  return ` · next in ${Math.round(s / 60)}m`;
}

/** Plain-language version of claude-swap's error codes. */
/**
 * claude-swap's failure codes, said in the product's voice.
 *
 * These come straight out of its store, and the panel used to print whatever it
 * found — which is how a user ended up looking at `invalid_grant` on their
 * ACTIVE account with nothing to do about it. Two of these are permanent and
 * only the user can clear them: the stored refresh token is dead, and every
 * poll will keep failing until someone signs in again. Those get `fixable`, and
 * the row grows a button.
 */
export function errorText(code: string): { text: string; hint: string; fixable: boolean } {
  switch (code) {
    case "invalid_grant":
    case "no_refresh_token":
      return {
        text: "login expired",
        hint: "claude-swap's stored login for this account was rejected and cannot be refreshed. "
            + "Signing in again replaces it — the account keeps its slot, its alias and its history.",
        fixable: true,
      };
    case "http-401":
      return { text: "re-login needed", hint: "Anthropic refused this account's token.", fixable: true };
    case "http-429":
      return { text: "rate limited", hint: "Anthropic is throttling requests for this account. It clears on its own.", fixable: false };
    case "transient":
      return { text: "temporary error", hint: "A network or server hiccup while reading usage. The next collection retries.", fixable: false };
    case "timeout":
      return { text: "timed out", hint: "Reading this account's usage took too long. The next collection retries.", fixable: false };
    case "network":
      return { text: "unreachable", hint: "Could not reach Anthropic to read this account's usage.", fixable: false };
    default:
      // Still shown, because a code we have not met is better than silence —
      // but labelled as one, so it does not read as a sentence.
      return { text: code, hint: `claude-swap reported "${code}" for this account.`, fixable: false };
  }
}

function LaneBar({ lane, nowSec }: { lane: Lane; nowSec: number }) {
  const capped = Math.min(100, Math.max(0, lane.pct));
  const color  = capped >= 90 ? "var(--err)" : capped >= 70 ? "var(--warn)" : "var(--accent)";
  const reset  = lane.resetAt ? resetCountdown(lane.resetAt, nowSec) : null;
  return (
    <div className="ap-lane">
      <span className="ap-lane-label">{lane.label}</span>
      <div className="ap-lane-track">
        <div className="ap-lane-fill" style={{ width: `${capped === 0 ? 1.5 : capped}%`, background: color, opacity: capped === 0 ? 0.4 : 1 }} />
      </div>
      <span className="ap-lane-pct" style={{ color }}>{capped}%</span>
      <span className="ap-lane-reset">{reset ? `resets ${reset}` : ""}</span>
    </div>
  );
}

/**
 * Copy text, and say whether it worked.
 *
 * navigator.clipboard is undefined outside a secure context and can sit
 * unresolved while the browser decides on permission — which leaves a Copy
 * button silently dead. Race it, then fall back to the old selection trick.
 * Same shape as the version banner's copy, for the same reason.
 */
async function copyText(text: string): Promise<boolean> {
  let ok = false;
  try {
    ok = await Promise.race([
      navigator.clipboard?.writeText(text).then(() => true) ?? Promise.resolve(false),
      new Promise<boolean>(r => window.setTimeout(() => r(false), 500)),
    ]);
  } catch { ok = false; }
  if (ok) return true;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ok = document.execCommand("copy");
    ta.remove();
  } catch { ok = false; }
  return ok;
}

/**
 * How much longer another deck will ACCEPT this share, said as a countdown.
 *
 * Not how long it is safe for, which is a claim this timer cannot make and used
 * to imply. The envelope is base64 of plain `{v, exp, payload}` with no MAC and
 * no key anywhere — anyone holding the text can decode it, rewrite `exp`,
 * re-encode and import it, and if they could not, the payload inside is still
 * the account's OAuth token in the clear and `cswap import` takes it directly.
 * A key would not help: the whole point of a share is that the receiving deck
 * shares no secret with the sending one, so there is nothing to sign with that
 * the recipient could verify.
 *
 * What the expiry does buy is real but smaller, and it is worth naming so it
 * does not get mistaken for the other thing: a copy left behind in clipboard
 * history, a scrollback buffer or a chat window stops working through the
 * import dialog. That is hygiene against forgetting, not defence against
 * anybody. Until the login is rotated, a copy is a copy.
 *
 * `tone` drives the colour, and it says "this is about to stop working" — which
 * is why `gone` is the emphatic one. The warning about what the text IS lives
 * beside the countdown rather than on it.
 */
export function shareExpiry(expiresAt: number, nowSec: number): { text: string; tone: "ok" | "soon" | "gone" } {
  const left = Math.round(expiresAt / 1000) - nowSec;
  if (left <= 0) return { text: "expired", tone: "gone" };
  if (left < 60) return { text: `expires in ${left}s`, tone: "soon" };
  return { text: `expires in ${Math.round(left / 60)}m`, tone: "ok" };
}

interface Props { onClose: () => void }

export default function AccountsPanel({ onClose }: Props) {
  const [data, setData] = useState<AccountsData | null>(null);
  const [auto, setAuto] = useState<AutoStatus | null>(null);
  // The tag of the one request the panel has out, or null. A switch is one of
  // them now rather than a flag of its own: #518 needs every control to answer
  // the same question — "is somebody else working" — and two flags cannot.
  const [busy, setBusy] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const timerRef = useRef<number | null>(null);
  // Which account's row is expanded into its edit controls. One at a time —
  // the panel is 288px wide and two open rows leave nothing to look at.
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [aliasDraft, setAliasDraft] = useState("");
  // Which account's alias was just stored. `save` is never disabled by the
  // draft matching the alias any more — that was the block's resting state and
  // it rendered at 1.98:1 — so the button confirms instead of greying out.
  const [aliasSaved, setAliasSaved] = useState<number | null>(null);
  // Removal is irreversible, and there is no confirmation dialog anywhere in
  // this deck. The button becomes its own confirmation and gives up after a
  // few seconds, so a stray click can never be the second one.
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [share, setShare] = useState<{ num: number; blob: string; expiresAt: number } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  // A move into an occupied slot relocates an account the user never picked.
  // Nothing else on screen says so — both accounts simply appear where they
  // were not — so the slot row says it, in the block that did it.
  const [swapNote, setSwapNote] = useState<SwapNote | null>(null);
  // What the slot picker is SHOWING, which is no longer what the store holds.
  // A select fires `change` on any keystroke that matches an option, so a
  // single `s` used to move an account and, into a taken slot, a second one
  // with it (#516). The picker proposes now and the button beside it commits.
  // Null is the account own slot, which is where the picker opens; only one
  // manage block is ever open, so one draft covers the panel.
  const [slotDraft, setSlotDraft] = useState<number | null>(null);
  // Which block just had its slot control pressed with nothing to send. Same
  // transient confirmation `save` gives an alias that was already stored.
  const [slotDone, setSlotDone] = useState<number | null>(null);
  // The same two for the auto-switch threshold, which had the same defect with
  // a setting write on the other end. Null follows whatever the store holds.
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);
  const [thresholdSaved, setThresholdSaved] = useState(false);
  // Which rows have their other quota windows open. Every row opens collapsed,
  // including the active one: uniform rows are what makes a column scannable,
  // and a default that depended on state would make the panel's resting height
  // depend on which account happens to be live. More than one may be open —
  // comparing two accounts is exactly what this panel is for.
  //
  // Held by ACCOUNT and not by slot, which is the whole of #542: a swap trades
  // two slot numbers and this set, unlike the manage block, never went through
  // manageAfterMove — so the disclosure stayed on the number and expanded a row
  // belonging to somebody else. laneKey names the account instead; see
  // lane-open.ts, which also says why a fifth ManageState field would not have
  // been enough.
  const [openLanes, setOpenLanes] = useState<string[]>([]);

  // The same fact as `busy`, where a handler can read it without waiting for a
  // render. #518 leaves the working control enabled, so a second press reaches
  // the handler and the handler is what has to refuse it.
  const busyRef = useRef<string | null>(null);
  /** Take the panel's one request slot, or refuse the press. */
  const claim = useCallback((tag: string) => {
    if (!pressAccepted(busyRef.current)) return false;
    busyRef.current = tag;
    setBusy(tag);
    return true;
  }, []);
  const release = useCallback(() => { busyRef.current = null; setBusy(null); }, []);

  /**
   * The two attributes #518 puts on every control that a request makes inert.
   *
   * Spread rather than written out per button, because the whole of that fix is
   * that there is ONE answer: inert while somebody else is working, busy and
   * still focusable while it is your own request. A control that spelled either
   * half by hand would be the second answer the issue asks against.
   */
  const pressProps = (tag: string, working = false) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy || working };
  };

  /**
   * Focus the nearest control that outlived the press.
   *
   * Only when focus was actually dropped — a user who tabbed somewhere else
   * while the request was out is left where they put themselves. After the
   * frame, because the control being rescued from is unmounted by a React
   * commit and rAF is the first moment the document is certain to be the one
   * the reader is looking at.
   */
  const rescueFocus = useCallback((row: number | null) => {
    window.requestAnimationFrame(() => {
      if (!focusDropped(document.activeElement?.tagName ?? null)) return;
      for (const sel of rescueSelectors(row)) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el) { el.focus(); return; }
      }
    });
  }, []);

  // A reload the user asked for, and the same one on a timer. Only the forced
  // half touches `reloading`: a poll blinking the ↻ every 15 seconds would read
  // as the panel doing something to itself.
  const load = useCallback(async (force = false) => {
    if (force) setReloading(true);
    // A deck that accepts the connection and then wedges never rejects these
    // fetches. Unbounded, the first load would sit on "Checking…" behind a ↻
    // disabled forever — the dead button this busy state exists to rule out,
    // made permanent.
    const ctl = new AbortController();
    const bell = window.setTimeout(() => ctl.abort(), RELOAD_TIMEOUT_MS);
    try {
      const [accts, autoRes] = await Promise.all([
        fetch(`/api/claude-accounts${force ? "?refresh=1" : ""}`, { signal: ctl.signal }),
        fetch("/api/cswap-auto", { signal: ctl.signal }),
      ]);
      if (accts.ok) {
        const fresh: AccountsData = await accts.json();
        setData(fresh);
        // An account that was removed while its lanes were open would otherwise
        // keep its place in the set until the panel is unmounted, ready to
        // reopen itself on whoever signs that address back in. The roster is
        // the only thing that knows an account has gone, so the roster is where
        // the set is trimmed. Unchanged in and unchanged out when nobody left,
        // which is every poll but one.
        setOpenLanes(open => knownLanes(open, fresh.accounts));
      }
      if (autoRes.ok)  setAuto(await autoRes.json());
      const verdict = explainReload([await answered(accts), await answered(autoRes)]);
      setFailure(prev => nextFailure(prev, verdict));
    } catch {
      setFailure(prev => nextFailure(prev, RELOAD_UNREACHABLE));
    } finally {
      window.clearTimeout(bell);
      if (force) setReloading(false);
    }
  }, []);

  /** Every auto-switch control is one POST; they all reload afterwards. */
  const post = useCallback(async (body: Record<string, unknown>, tag: string) => {
    if (!claim(tag)) return null;
    setFailure(null);
    try {
      const res = await fetch("/api/cswap-auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => null);
      // This route's `detail` is cswap's stderr verbatim, not a sentence
      // anybody wrote — same as the switch below, and unlike the admin route.
      if (!out?.ok) setFailure({ text: explainCommandFailure(out, "command failed"), raw: commandOutput(out) });
      return out;
    } catch {
      setFailure({ text: "server unreachable" });
      return null;
    } finally {
      release();
    }
  }, [claim, release]);

  /** Every store-changing action is one POST to the same route. */
  const admin = useCallback(async (body: Record<string, unknown>, tag: string) => {
    if (!claim(tag)) return null;
    setFailure(null);
    try {
      const res = await fetch("/api/claude-accounts/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await res.json().catch(() => null);
      // The admin route composes its `detail` with failureText(), so here the
      // server's own words are the message and explainFailure ranks them first.
      if (!out?.ok) setFailure({ text: explainFailure(out, "command failed") });
      return out;
    } catch {
      setFailure({ text: "server unreachable" });
      return null;
    } finally {
      release();
    }
  }, [claim, release]);

  useEffect(() => {
    load(true);
    timerRef.current = window.setInterval(() => load(false), POLL_MS);
    return () => { if (timerRef.current != null) window.clearInterval(timerRef.current); };
  }, [load]);

  // Countdowns tick independently of the fetch so they stay honest between polls.
  useEffect(() => {
    const t = window.setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // How close the active account is to tripping the rule. `peak` is the fullest
  // lane of all, shown or folded, which is the one claude-swap measures against
  // — the same lane `headroom` is about. The row leads with the windows rather
  // than with the fullest, so this is deliberately NOT the lane the row shows
  // first; taking that one would have this readout disagree with the rule it
  // describes on any account whose model lane is the hot one.
  const threshold = auto?.settings["autoswitch.threshold"]?.value ?? "90";
  // The percentage the picker is showing, which is a proposal until it is
  // saved. The live number below races the STORED one, because that is the
  // number claude-swap actually measures against — an unsaved pick moves
  // nothing and must not move the warning colour either.
  const thresholdPick = thresholdDraft ?? threshold;
  const thresholdCtl = thresholdCommit(thresholdPick, threshold);
  const activeAcct = data?.accounts?.find(a => a.active);
  // The same fullest lane the rows measure against, from the same function.
  // This used to
  // be a second `Math.max` written out here, which is one of the two places the
  // panel did the arithmetic the row was leaving to the reader.
  const activePct = laneSplit(activeAcct?.lanes ?? []).peak?.pct ?? null;
  const nearTrigger = activePct != null && activePct >= Number(threshold) - 15;

  const doSwitch = async (num: number) => {
    if (!claim(`switch-${num}`)) return;
    setFailure(null);
    try {
      const res = await fetch("/api/claude-accounts/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: num }),
      });
      const body = await res.json().catch(() => null);
      if (!body?.ok) setFailure({ text: explainCommandFailure(body, "the switch failed"), raw: commandOutput(body) });
      await load(true);
    } catch {
      setFailure({ text: "server unreachable" });
    } finally {
      release();
      // A switch that landed replaces this button with the `active` marker,
      // which is a span and cannot hold focus. One that failed leaves the
      // button standing, still focused, and this is a no-op — the rescue only
      // fires when focus was actually dropped. See panel-press.ts.
      rescueFocus(num);
    }
  };

  /**
   * Store the alias in the field, and say so.
   *
   * Both endings are the same word. A draft that already matches the store is
   * not a failure and not a no-op the user should have to detect — it is an
   * alias that is saved — so it confirms without a round trip, and a draft that
   * differs confirms once the store has it. `saved` replaces the disabled state
   * the block used to open in.
   */
  const doAlias = async (num: number, stored: string | null) => {
    const { commit, alias } = aliasSave(aliasDraft, stored);
    if (commit) {
      const out = await admin({ action: "alias", account: num, alias }, `alias-${num}`);
      await load(true);
      if (!out?.ok) return;
      // The store now holds the trimmed value, so the field should too — or the
      // next comparison is against a draft the store never saw.
      setAliasDraft(alias);
    }
    setAliasSaved(num);
    window.setTimeout(() => setAliasSaved(n => (n === num ? null : n)), SAVED_MS);
  };

  /**
   * Send an account to another slot, then put the manage block back where its
   * account went.
   *
   * The reload alone is not enough: `cswap move` into an occupied slot is a
   * swap, so the slot numbers this block is keyed by change hands underneath
   * it. manageAfterMove decides what survives that; a refused move returns
   * null and nothing here is touched, leaving the block open and armed exactly
   * as the user left it with the failure box below to say why.
   */
  const doMove = async (from: number, to: number) => {
    const out = await admin({ action: "move", account: from, slot: to }, `move-${from}`);
    const next = manageAfterMove(
      { menuFor, confirmRemove, shareFor: share?.num ?? null, swapNote },
      from,
      out,
    );
    // The roster first, then the block, and never the other way round: the two
    // disagree about who holds a slot for exactly as long as one has moved on
    // and the other has not, and that disagreement IS the bug — the block
    // rendered over a row belonging to somebody else. Both updates land in the
    // same tick here, so no render is ever caught between them.
    await load(true);
    if (next) {
      setMenuFor(next.menuFor);
      setConfirmRemove(next.confirmRemove);
      if (next.shareFor == null) { setShare(null); setShareCopied(false); }
      setSwapNote(next.swapNote);
      const note = next.swapNote;
      if (note) window.setTimeout(() => setSwapNote(n => (n === note ? null : n)), SWAP_NOTE_MS);
      // The account is where the picker said, so the picker has nothing left to
      // propose. A refused move keeps the draft: the block stays open on the
      // pick the user made, ready to be pressed again under the failure box.
      setSlotDraft(null);
      // The block followed its account into the slot it moved to, so the button
      // that was pressed was unmounted and re-mounted a row away. Focus lands
      // on the disclosure of the row the account is in now.
      rescueFocus(next.menuFor);
    }
    return out;
  };

  /**
   * Act on the slot showing in the picker, because the user said so.
   *
   * This is the whole of #516. A `<select>` changes value on a keystroke and
   * fires `change` for it, so the picker cannot be the thing that acts — one
   * `s` matched `slot 3 · swap` by type-ahead and traded two accounts with no
   * confirmation and no undo. The press is the decision now, and slotCommit
   * decides what the press means from the choice alone.
   *
   * Both endings confirm, which is what `save` does one row above: a pick that
   * is already where the account lives has nothing to send and is not a
   * failure, and a pick that moved it is answered by the block following the
   * account into its new slot.
   */
  const doSlot = async (from: number, to: number, commit: PickerCommit) => {
    if (commit.sends) {
      const out = await doMove(from, to);
      if (!out?.ok) return;
    }
    setSlotDone(from);
    window.setTimeout(() => setSlotDone(n => (n === from ? null : n)), SAVED_MS);
  };

  /** The same rule for the threshold: the picker proposes, `save` stores it. */
  const doThreshold = async (pick: string, commit: PickerCommit) => {
    if (commit.sends) {
      const out = await post({ action: "setting", key: "autoswitch.threshold", value: pick }, "threshold");
      await load(true);
      if (!out?.ok) return;
      setThresholdDraft(null);
    }
    setThresholdSaved(true);
    window.setTimeout(() => setThresholdSaved(false), SAVED_MS);
  };

  return (
    // Named for the topbar toggle's aria-controls — see UsagePanel, which also
    // carries the reason this is an <aside> and not the <div> it was: the
    // aria-label on a roleless <div> resolved to `generic` and the tree threw
    // the name away (#381). This panel is the left sidebar beside the canvas,
    // which is complementary content by any reading.
    <aside className="accounts-panel" id="accounts-panel" aria-label="Claude accounts">
      <div className="ap-header">
        {/* h2, under the topbar's h1 — the level every panel title sits at. */}
        <h2>Accounts</h2>
        <div className="ap-header-right">
          {/* The `+` is one glyph, so `title` was its whole accessible name.
              A last-resort name source that a touch user never sees and that
              some readers are configured to ignore is not a name; this is the
              second and last of the two the #381 sweep found. The tooltip stays
              as the longer hover sentence. */}
          <button type="button" className="glyph-btn ap-add" onClick={() => setAddOpen(true)}
            aria-label="Add an account"
            title="Sign in to another Claude account, or paste one shared from another deck">+</button>
          {/* #518: this used to be `disabled={reloading}`, which disabled the
              control the press came from and dropped focus to the document
              body on every reload. It is inert while somebody ELSE is working and busy while
              its own request is out — the same two attributes every control in
              the panel takes from pressProps — and the glyph goes on saying
              which of the two it is.
              `reloading` is a second flag rather than the panel request slot
              because a reload is fired by the poll and by every other action
              too, and a reload that took the slot would disable the control
              that had just fired it — which is the defect, one step further
              along. */}
          <button type="button" className="glyph-btn ap-refresh" onClick={() => load(true)}
            {...pressProps("reload", reloading)} aria-label="Reload accounts"
            title="Reload from claude-swap">{reloading ? "…" : "↻"}</button>
          <button type="button" className="glyph-btn" onClick={onClose} aria-label="Close accounts panel" title="Close (A)">×</button>
        </div>
      </div>

      {/* Nothing has arrived yet. "Checking…" is only true while a request is
          still out: the panel's failure box lives inside the branch below,
          which needs a roster to render, so a first load that failed used to
          leave this word standing with nothing behind it. */}
      {data == null ? (
        failure ? (
          <div className="ap-empty" role="alert">
            <span title={failure.raw || undefined}>{failure.text}</span>
            <span className="ap-hint">
              No accounts have arrived, so there is nothing to show yet. The panel keeps
              trying every {POLL_MS / 1000} seconds.
            </span>
            <button type="button" className="ap-fix" disabled={reloading} onClick={() => load(true)}>
              {reloading ? "trying…" : "try again"}
            </button>
          </div>
        ) : (
          <div className="ap-empty">Checking…</div>
        )
      ) : !data.ok ? (
        <div className="ap-empty">
          {data.reason === "no_cswap" ? (
            <>
              <span>claude-swap isn't installed.</span>
              <span className="ap-hint">
                This panel reads the account store claude-swap keeps — without it there is
                nothing to show. It is a separate tool, published on PyPI, so it does not
                come with this package.
              </span>
              {data.hint && <code className="ap-cmd">{data.hint}</code>}
              <span className="ap-hint">Then add an account with the <strong>+</strong> button above.</span>
            </>
          ) : data.reason === "no_accounts" ? (
            <>
              <span>No accounts added yet.</span>
              <span className="ap-hint">
                claude-swap is installed but has nothing in its store. Use the <strong>+</strong> above
                to sign one in, or to paste one shared from another deck.
              </span>
            </>
          ) : (
            <>
              <span>Couldn't read the account store.</span>
              <span className="ap-hint">
                claude-swap is installed, but its store could not be read
                {data.reason ? ` (${data.reason})` : ""}.
              </span>
            </>
          )}
        </div>
      ) : (
        <>
          {data.accounts?.map(a => {
            const { shown, rest, fuller, peak } = laneSplit(a.lanes);
            const lanesOpen = openLanes.includes(laneKey(a));
            const more = moreLabel(rest.length, lanesOpen, fuller);
            return (
            <div key={a.num} className={`ap-account${a.active ? " active" : ""}`}>
              <div className="ap-account-head">
                <span className="ap-num">{a.num}</span>
                {/* Both of these are clipped with an ellipsis so a long one
                    cannot widen the panel, which means the row can be showing
                    less than the whole string — so each one carries its own
                    whole value in a title. The email used to carry the ORG
                    name there instead (#517), which meant the identifier could
                    be down to four characters with the full value recoverable
                    nowhere: an 18-character alias engages the 40% clamp on
                    `.ap-alias` and leaves the address 31.98px, measured. */}
                {a.alias && <span className="ap-alias" title={a.alias}>{a.alias}</span>}
                <span className="ap-email" title={a.email ?? undefined}>{a.email}</span>
                {/* aria-controls only while the block exists: an IDREF that
                    resolves to nothing is not a relationship, it is a dangling
                    pointer, and closed is exactly when there is nothing to
                    point at. The id is what focus falls back to when a press
                    unmounts its own control — see panel-press.ts. */}
                <button type="button" id={`ap-more-${a.num}`}
                  className={`ap-more${menuFor === a.num ? " on" : ""}`}
                  aria-label={`Manage account ${a.num}`} aria-expanded={menuFor === a.num}
                  aria-controls={menuFor === a.num ? `ap-manage-${a.num}` : undefined}
                  title="Share, rename, move, remove"
                  onClick={() => {
                    setMenuFor(menuFor === a.num ? null : a.num);
                    setAliasDraft(a.alias ?? "");
                    setConfirmRemove(null);
                    setShare(null);
                    setShareCopied(false);
                    setSwapNote(null);
                    setAliasSaved(null);
                    setSlotDraft(null);
                    setSlotDone(null);
                  }}>⋯</button>
                {/* Three tiers, and they were inverted. The panel exists to say
                    which account is live, and that fact was carried by a wash
                    measuring 1.12:1 in dark while the `switch` it repeats on
                    every OTHER row was a 30px bordered box. So state is a
                    filled chip — 10.85:1 dark and 5.93:1 light against the
                    panel, 9.35:1 and 5.13:1 against the pill it replaces one
                    row down — and the verb drops to the small outlined pill
                    that `save`, `share` and `remove` already use. The dot is
                    gone with the box: a filled chip does not need a dot inside
                    it, and the word is what keeps this out of colour-alone
                    territory.
                    Held out gets a word of its own for the same reason (#519).
                    It replaces `switch` rather than sitting beside it, because
                    a switch to a held-out account is refused — a control that
                    can never act is worse than no control — and the way back
                    into rotation is in the footer below, now on every held-out
                    row rather than only while something is rotating. */}
                {a.active && <span className="ap-badge-active">active</span>}
                {a.disabled && <span className="ap-badge-held">held out</span>}
                {!a.active && !a.disabled && (
                  <button
                    type="button"
                    className="ap-manage-btn ap-switch"
                    {...pressProps(`switch-${a.num}`)}
                    onClick={() => doSwitch(a.num)}
                    title={`Switch to ${a.alias ?? a.email}`}
                  >{busy === `switch-${a.num}` ? "…" : "switch"}</button>
                )}
              </div>

              {/* One lane at rest: the one that runs out first, which is the
                  only one that decides anything. The group keeps its id in both
                  states — unlike the manage block above, whose target does not
                  exist while it is closed — so the disclosure below points at
                  it unconditionally. See lane-view.ts for why the rest are not
                  re-sorted. */}
              <div className="ap-lanes" id={`ap-lanes-${a.num}`}>
                {shown.length
                  ? <>
                      {shown.map(l => <LaneBar key={l.id} lane={l} nowSec={nowSec} />)}
                      {lanesOpen && rest.map(l => <LaneBar key={l.id} lane={l} nowSec={nowSec} />)}
                    </>
                  : <div className="ap-hint">No usage recorded yet.</div>}
              </div>

              {/* Freshness is load-bearing here, not a footnote: an account
                  that has been rate-limited for hours still shows its last
                  good numbers, and switching to it on that basis would be a
                  decision made on old information. */}
              <div className="ap-meta">
                {a.error && (() => {
                  const e = errorText(a.error);
                  return (
                    <>
                      <span className="ap-err" title={e.hint}>{e.text}</span>
                      {/* A dead login is the one failure here that no amount of
                          waiting fixes, so the fix is one click away rather
                          than a paragraph away. */}
                      {e.fixable && (
                        <button type="button" className="ap-fix" onClick={() => setAddOpen(true)}
                          title="Open the sign-in dialog. Signing in as this account replaces its stored login in place.">
                          sign in again
                        </button>
                      )}
                    </>
                  );
                })()}
                {/* The row footer is where the other windows are opened from,
                    because it is the line that exists on every row and is empty
                    most of the time. The count is the whole label: it says how
                    much is not being shown, which is the question a collapsed
                    row raises. */}
                {more && (
                  <button
                    type="button"
                    className="ap-lanes-more"
                    aria-expanded={lanesOpen}
                    aria-controls={`ap-lanes-${a.num}`}
                    title={lanesTitle(a.headroom, peak?.label ?? null, rest.length, lanesOpen)}
                    onClick={() => setOpenLanes(open => toggleLane(open, a))}
                  >{more}</button>
                )}
                {/* Holding an account out only matters when something is
                    rotating, so `hold out` appears with it. Putting one BACK is
                    not conditional on anything: #519 found that with
                    auto-switch off a held-out account was signalled by a 0.6
                    opacity and nothing else, and the one control that would
                    undo it was the control not being rendered. The word is the
                    chip up in the head row now, so what is left here is the
                    verb. */}
                {(((auto?.enabled || auto?.external) && !a.active) || a.disabled) && (
                  <button
                    type="button"
                    className="ap-rotate"
                    {...pressProps(`rot-${a.num}`)}
                    onClick={() => post({ action: "account", account: a.num, enabled: a.disabled }, `rot-${a.num}`).then(() => load(true))}
                    title={a.disabled
                      ? "Return this account to auto-rotation"
                      : "Hold this account out of auto-rotation"}
                  >{a.disabled ? "put back" : "hold out"}</button>
                )}
                {/* A bare "9m ago" under a stack of percentages does not say
                    what happened 9 minutes ago — and the honest answer is not
                    "you looked", it is "claude-swap read this account". The
                    verb is the whole content of the line. */}
                {a.fetchedAt
                  ? <span
                      className={`ap-age${a.stale ? " ap-stale" : ""}`}
                      title={"When claude-swap last read this account's usage, and when it plans to read it again. "
                           + "It sets that interval itself — 3 minutes at the fastest, wider while an account is "
                           + "recovering from a rate limit — and every surface, including `cswap watch`, follows "
                           + "the same plan."}
                    >collected {ago(a.fetchedAt, nowSec)}{due(a.nextAt, nowSec)}</span>
                  : <span className="ap-age ap-stale" title="claude-swap has not read this account yet">never collected</span>}
              </div>

              {menuFor === a.num && (
                /* A named group, so a screen reader that has just heard "Manage
                   account 2, expanded" is told what the three rows underneath
                   belong to instead of walking into unattributed form fields. */
                <div className="ap-manage" id={`ap-manage-${a.num}`}
                  role="group" aria-label={`Manage account ${a.num}`}>
                  <div className="ap-manage-name">
                    {/* A real <label> still, only no longer on screen. The word
                        `name` beside a field whose placeholder already reads
                        `e.g. work` was a 34px gutter spent restating the field,
                        and the same gutter on the two rows below pushed every
                        control into two thirds of a 259px column. Hidden rather
                        than dropped for an aria-label, because the association
                        is what a screen reader and voice control both use, and
                        2.5.3 has nothing to disagree with once no label shows. */}
                    <label className="vis-hidden" htmlFor={`ap-alias-${a.num}`}>Alias</label>
                    <input
                      id={`ap-alias-${a.num}`}
                      className="ap-manage-input"
                      type="text"
                      value={aliasDraft}
                      onChange={e => setAliasDraft(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") doAlias(a.num, a.alias); }}
                      /* The store's own bound, stated where the typing happens
                         rather than discovered from a `bad_value` after a
                         round trip. See ALIAS_MAX_LENGTH for why it matches the
                         server exactly and why it is not what protects the
                         panel's width. */
                      maxLength={ALIAS_MAX_LENGTH}
                      /* An example, not a narration of the empty state: "no
                         alias" reads as a field whose value is those two words. */
                      placeholder="e.g. work"
                      spellCheck={false}
                      /* The block is a form revealed by a button, and the field
                         at the top of it is where the keyboard should land —
                         otherwise reaching it means tabbing back through the
                         switch, the lanes and the freshness line. It mounts
                         only when the block opens, so this fires exactly then. */
                      autoFocus
                    />
                    <button type="button" className="ap-manage-btn" {...pressProps(`alias-${a.num}`)}
                      onClick={() => doAlias(a.num, a.alias)}
                      title="A short name to show instead of the email"
                    >{aliasSaved === a.num ? "saved" : "save"}</button>
                  </div>

                  {/* The picker and the press that acts on it, paired the way
                      the alias field above is paired with `save`. It had been
                      alone on the verb row, acting on its own `change` — which
                      a `<select>` fires for a keystroke as readily as for a
                      pick, so one letter matched an option by type-ahead and
                      moved an account, and into a taken slot moved a second one
                      nobody pointed at (#516). Nothing is sent until the button
                      is pressed, and the button says which of the two it will
                      do. */}
                  {(() => {
                    const choices = slotChoices((data.accounts ?? []).map(x => x.num), a.num);
                    const picked = slotShowing(choices, slotDraft, a.num);
                    const commit = slotCommit(choices, picked, a.num);
                    return (
                      <div className="ap-manage-slot">
                        <label className="vis-hidden" htmlFor={`ap-slot-${a.num}`}>Slot</label>
                        <span className="ap-field">
                          <select
                            id={`ap-slot-${a.num}`}
                            value={String(picked)}
                            {...pressProps(`move-${a.num}`)}
                            onChange={e => setSlotDraft(Number(e.target.value))}
                          >
                            {/* `rotation order` named the number and never the
                                effect; `swaps if the slot is taken` named the
                                effect and left the reader to work out which
                                slots those were — all of them but the last. On
                                the options, the warning sits on the choice that
                                carries it and the one harmless move is visible
                                as the exception. */}
                            {choices.map(c => <option key={c.slot} value={c.slot}>{c.label}</option>)}
                          </select>
                        </span>
                        <button type="button" className="ap-manage-btn" {...pressProps(`move-${a.num}`)}
                          title={commit.title}
                          onClick={() => doSlot(a.num, picked, commit)}
                        >{slotDone === a.num ? commit.done : commit.label}</button>
                      </div>
                    );
                  })()}

                  {/* Two verbs on one line. They were three labelled rows —
                      `slot`, `share` and a `remove` under its own rule — each
                      one a control with a word introducing it and a sentence
                      explaining it. None of the three needed either once the
                      controls said what they do: the picker names the slot and
                      the consequence per option, and a button called `share` is
                      not clarified by being told it is the share row. */}
                  <div className="ap-manage-acts">
                    <button type="button" className="ap-manage-btn" {...pressProps(`share-${a.num}`)}
                      /* It said "carries a live login and expires in 10
                         minutes", which reads as a lock with a timer on it. The
                         share is plain text with the account's token inside and
                         an expiry nothing signs, so the sentence has to lead
                         with what the reader is about to put on their clipboard
                         and describe the ten minutes as what it is: how long
                         the OTHER deck will still take it. */
                      title={`Copy this account to another ${PRODUCT}. Anyone who has the text can use the account — treat it as the password. The other deck stops accepting it after 10 minutes; that does not make an escaped copy safe.`}
                      onClick={async () => {
                        setShareCopied(false);
                        const out = await admin({ action: "share", account: a.num }, `share-${a.num}`);
                        if (out?.ok) setShare({ num: a.num, blob: out.blob, expiresAt: out.expiresAt });
                      }}>share</button>
                    {/* Two clicks, and the second one expires. There is no
                        confirmation dialog anywhere in this deck and removing an
                        account cannot be undone, so it is pushed to the far edge
                        of the row: 47px of empty space, measured, against the
                        14px that separated it from `share` when it had a row of
                        its own. `confirm` rather than `confirm remove` because
                        the long form is 99px and would leave the row one pixel
                        of slack and no gap at all — see the pinned width in
                        styles.css, which is what stops the button moving out
                        from under the second click as it arms. */}
                    <button
                      type="button"
                      className={`ap-manage-btn danger${confirmRemove === a.num ? " armed" : ""}`}
                      {...pressProps(`rm-${a.num}`)}
                      title={confirmRemove === a.num
                        ? "This deletes the stored credentials for this account"
                        : "Remove this account from claude-swap"}
                      onClick={() => {
                        if (confirmRemove !== a.num) {
                          setConfirmRemove(a.num);
                          window.setTimeout(() => setConfirmRemove(c => (c === a.num ? null : c)), 4000);
                          return;
                        }
                        setConfirmRemove(null);
                        admin({ action: "remove", account: a.num }, `rm-${a.num}`).then(() => {
                          setMenuFor(null);
                          load(true);
                          // The row this button lived on is gone, so there is
                          // no local anchor left and focus falls to the panel
                          // reload — see rescueSelectors in panel-press.ts.
                          rescueFocus(null);
                        });
                      }}
                    >{confirmRemove === a.num ? "confirm" : "remove"}</button>
                  </div>

                  {/* A move into an occupied slot relocates an account the user
                      never picked, and this is the only place that says so. It
                      is a row that exists for eight seconds and then does not,
                      which is why the block can be two rows at rest and still
                      report something that happens on one move in three. */}
                  {swapNote?.at === a.num && (() => {
                    const other = data.accounts?.find(x => x.num === swapNote.displaced);
                    const who = other?.alias ?? other?.email ?? "the account that was there";
                    return (
                      <span className="ap-manage-hint ap-manage-swap"
                        title={`Slot ${swapNote.at} was taken, so the two accounts traded places: `
                             + `${who} now holds slot ${swapNote.displaced}.`}>
                        swapped with slot {swapNote.displaced}
                      </span>
                    );
                  })()}

                  {share?.num === a.num && (() => {
                    const exp = shareExpiry(share.expiresAt, nowSec);
                    const dead = exp.tone === "gone";
                    return (
                      <div className={`ap-share${dead ? " expired" : ""}`}>
                        <code className="ap-share-blob">{share.blob}</code>
                        <div className="ap-share-foot">
                          {/* Past the expiry the import dialog on the other deck
                              refuses this text, so offering to copy it is
                              offering a dead end. That is the only thing the
                              expiry does — see shareExpiry — and it is a
                              statement about the dialog, not about the copy. */}
                          <button type="button" className="ap-manage-btn" {...pressProps(`share-${a.num}`)}
                            onClick={async () => {
                              if (dead) {
                                setShareCopied(false);
                                const out = await admin({ action: "share", account: a.num }, `share-${a.num}`);
                                if (out?.ok) setShare({ num: a.num, blob: out.blob, expiresAt: out.expiresAt });
                                return;
                              }
                              if (await copyText(share.blob)) {
                                setShareCopied(true);
                                window.setTimeout(() => setShareCopied(false), 1800);
                              }
                            }}>
                            {dead ? "make a new share" : shareCopied ? "copied" : "copy"}
                          </button>
                          {/* "carries a live login" was true and read as a
                              caption. The text IS the login, and the countdown
                              beside it is not what keeps anyone out — so the
                              warning is the part that carries the colour, and
                              the full explanation is one hover away rather than
                              crammed into a 288px column. Kept to twenty
                              characters so the two halves stay on one line at
                              the panel's width; the sentence that does the
                              explaining is the title. */}
                          <span className="ap-manage-hint"
                            title={"This text is the account's password. It is base64 of plain JSON — the expiry inside it is not signed, so anyone holding a copy can change it, "
                                 + "and the login itself is in there in the clear either way. The countdown only says how long another deck's import dialog will still accept it. "
                                 + "If a copy escapes, sign the account out and back in."}>
                            <span className="ap-share-warn">this is the password</span>
                            {" · "}
                            <span className={`ap-share-expiry ${exp.tone}`}>{exp.text}</span>
                          </span>
                        </div>
                      </div>
                    );
                  })()}

                </div>
              )}
            </div>
            );
          })}

          {/* ── auto-switch ── */}
          {auto?.ok && (
            <div className="ap-auto">
              {/* The four things on this line had no rank between them: the
                  name of the section, the number saying where you are, the
                  control saying where it trips and the switch saying whether it
                  is armed all sat at one altitude, separated by one 10px gap.
                  Rank is bought with distance rather than with a new size or a
                  rule — the title takes the line, the controls take the next
                  one 8px under it, and the on/off switch is pushed to the far
                  edge of that line because it is a different decision from the
                  threshold beside it. 8 and 6 are the panel ladder, not the
                  topbar one.
                  A real h3 rather than a span, under the h2 the panel header
                  carries: this is a section of the panel and a reader walking
                  headings should find it. `margin: 0` in the sheet, because the
                  UA sheet gives it 1em and that would put the title back on a
                  line of its own by accident rather than on purpose. */}
              <div className="ap-auto-head">
                <h3 className="ap-auto-title">Auto-switch</h3>

                <span className="ap-auto-ctl">
                  {/* The live number belongs next to the threshold it is
                      racing: the setting means nothing without knowing where
                      you are. */}
                  {activePct != null && (
                    <span className={`ap-auto-now${nearTrigger ? " near" : ""}`}>{Math.round(activePct)}%</span>
                  )}
                  {/* The same pairing as the slot picker, for the same reason:
                      this select wrote a setting per keystroke, `8` then `7`
                      landing two writes (#516). Smaller blast radius, and it
                      would have been the one control in the panel still acting
                      on a key. */}
                  <span className="ap-field" title="Switch once the active account passes this much of its limit">
                    <select
                      aria-label="Switch threshold"
                      value={thresholdPick}
                      {...pressProps("threshold")}
                      onChange={e => setThresholdDraft(e.target.value)}
                    >
                      {THRESHOLDS.map(t => <option key={t} value={t}>{t}%</option>)}
                    </select>
                  </span>
                  <button type="button" className="ap-manage-btn" {...pressProps("threshold")}
                    title={thresholdCtl.title}
                    onClick={() => doThreshold(thresholdPick, thresholdCtl)}
                  >{thresholdSaved ? thresholdCtl.done : thresholdCtl.label}</button>

                  {/* Always a control, never a read-out. An earlier version
                      hid the toggle whenever a terminal loop was detected, on
                      the grounds that the deck's own loop would be redundant —
                      but a setting you cannot see is worse than a redundant
                      one, and the toggle still decides what happens the moment
                      that terminal loop stops. The terminal's state is shown
                      beside it instead of replacing it. */}
                  <button
                    type="button"
                    className={`ap-auto-state${auto.enabled ? " live" : ""}`}
                    role="switch"
                    aria-checked={auto.enabled}
                    {...pressProps("enable")}
                    onClick={() => post({ action: "enable", enabled: !auto.enabled }, "enable").then(() => load(true))}
                    title={auto.enabled
                      ? "Stop switching accounts automatically"
                      : "Switch accounts automatically when the active one nears its limit"}
                  >
                    <i className={auto.enabled ? "ap-pulse" : "ap-dot"} aria-hidden />
                    {auto.enabled ? "on" : "off"}
                  </button>
                </span>
              </div>

              {/* Which engine is actually switching right now. Two would not
                  corrupt anything — claude-swap serializes under its state
                  lock — but they double the tick rate against a request budget
                  that is already the scarce resource, so the deck stands down
                  while the terminal loop runs and says so. */}
              {auto.external && (
                <p className="ap-auto-note">
                  <i className="ap-pulse" aria-hidden /> A <code>cswap auto</code> loop in your terminal is
                  doing the switching. The deck stands down while it runs
                  {auto.enabled ? " — this toggle takes over when you stop it." : "."}
                </p>
              )}

              {/* The one thing worth saying after the settings: that the loop
                  is alive. Only shown once a tick has actually happened —
                  before that there is nothing to report and an empty rule
                  under the settings reads like something failed to load. */}
              {auto.lastTick && (
                <div className="ap-auto-foot">
                  <span className="ap-auto-result">checked {ago(auto.lastTick.at, nowSec)}</span>
                </div>
              )}
            </div>
          )}

          {/* Announced, because a switch that failed is the answer to a click
              that happened somewhere else in the panel, and dismissible,
              because nothing else here clears it: the next action does, and
              until then a stale refusal sits under a roster that has since
              moved on. */}
          {failure && (
            <div className="ap-failure" role="alert">
              <span className="ap-failure-text" title={failure.raw || undefined}>{failure.text}</span>
              <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
                aria-label="Dismiss this message" title="Dismiss">×</button>
            </div>
          )}

          {/* The line named an actor the reader has already met on every row
              (`collected 9m ago`) and in the auto-switch note, and buried the
              one fact only this line carries: these numbers do not keep
              themselves up to date. Consequence first, actor not at all. */}
          <p className="ap-footnote" title="Anthropic's usage endpoint allows roughly 28–30 requests per hour per account, shared by every tool on this machine — polling it from here would rate-limit your account. So the deck never fetches: it asks claude-swap to collect while this panel is open, at most once every three minutes, and claude-swap decides whether that touches the network at all.">
            These numbers only update while this panel is open.
          </p>
        </>
      )}

      {addOpen && (
        <AddAccountDialog
          onClose={() => setAddOpen(false)}
          onChanged={() => load(true)}
        />
      )}
    </aside>
  );
}
