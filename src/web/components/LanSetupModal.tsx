// What this deck IS on the network, and nothing about who it talks to.
//
// THE DIALOG USED TO BE THE WHOLE FEATURE. It held the invite, the join field,
// the address field, every deck ever paired with, the machines nearby, the
// firewall advice and a `check now` — thirteen controls in two columns, behind
// a button in a panel. Which meant the two things somebody does every day —
// see who is there, answer somebody who is asking — were the two things furthest
// away, and the reported symptom was exactly that: "it is too complicated, I
// should just see who wants to connect and press yes or no".
//
// So the split moved. WHO THIS DECK TALKS TO is a list, and a list belongs on
// the surface you already have open — it is in the panel now, one row per
// machine, with the verb that changes it on the end of the row. WHAT THIS DECK
// IS — the name it appears under and the logins it offers — is a decision made
// twice, and that is what is left here.
//
// Two fields, then, and both of them are about this machine. Everything that
// takes an address or a token is in LanAddDeckModal.tsx, and another deck's
// name is given in that deck's own dialog, LanPeerModal.tsx.
//
// THE FINGERPRINT IS BACK, WITHOUT THE PROSE (#815). It was taken out of here
// once, with the sentence that told the reader to read it out, as the cost of
// a dialog that had grown three paragraphs of prose around two controls. But
// the request that arrives on the other machine asks its reader to compare the
// value with this deck's, and this is the only surface that can show it — so
// with it gone, the one check a person can make against a rogue deck on the
// network could not be made. It is one row now, the way the paired-deck dialog
// prints a peer's: the value and a copy word, no sentence. The owner's call,
// 2026-09-14.
//
// AND TWO SWITCHES, which are the third thing this deck IS on the network: does
// it ask the machines it finds, and is a request that arrives answered here or
// answered for it. They are last on purpose. The dialog reads as one sentence
// in three parts — this is my name, these are the logins I offer, and this is
// who may take them — and the permission belongs after the list it is a
// permission over, where the warning under it can point at rows the reader has
// just looked at.
//
// BOTH ON BY DEFAULT, and the two are not the same risk. Asking gives nothing
// away: the machine on the other end still answers. Saying yes is the one that
// hands somebody a copy — which is said by the switch's own label rather than by
// a paragraph under it, because the default state is not where a reader needs
// prose. A switch somebody has turned OFF is: that deck is no longer doing what
// it says on the box, and the line under it says what that costs.
//
// AND ABOVE THEM, INVITE-ONLY (#1236), off by default and the strictest answer
// to "who may take them": on, no deck pairs without an invite this one minted
// or was sent. It is a switch like its neighbours, not a second kind of
// control; its line appears only while it is on; and the pair under it — and
// Tailscale's pair — are paused in place rather than hidden, so what comes back
// when it goes off is still in view.
//
// TAILSCALE IS ITS OWN SECTION, shown only on a machine that has it. One switch
// turns discovery over the tailnet on — off until somebody does, because it is
// a new path off this machine — and the same two permissions as the local
// network sit under it once it is, on by default like those. They are a second
// pair rather than the first pair reused because the audience differs: here
// they only ever answer for machines signed in to this person's own Tailscale
// account.
//
// NO PARAGRAPH UNDER IT EITHER, for the reason the pairing switches lost
// theirs. What the reader needs is one fact the labels cannot say — WHICH
// account's machines count, and how many are there — and that is a quiet line
// under the switch's own label. The heading already says Tailscale, so the
// labels do not say it again.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalDismiss, useScrimDismiss } from "./use-modal-dismiss";
import { useFocusRescue } from "./use-focus-rescue";
import { pressState } from "../panel-press";
import { nextShared, settlePending } from "../lan-share";
import { writeFailure } from "../use-lan-section";
import { refusalLine, type SettingsLine } from "../settings-give-back";
import { SettingsFailureLine } from "./SettingsFailureLine";
import { copyText } from "../copy-text";
import type { LanAccount, LanStatus, LanTailscale } from "../lan-types";
import { useFeatureUse } from "../feature-use";
import { t as tNow, useT } from "../i18n";

/**
 * The line under "Look for my devices": whose devices those are, and how many
 * are online once it is looking — or why it cannot look. Exported for the
 * suite.
 */
export function tailscaleDetail(ts: LanTailscale): string {
  if (!ts.running) {
    const why = ts.state === "Stopped" ? tNow("lan.setup.tsWhy.off")
      : ts.state === "NeedsLogin" || ts.state === "NeedsMachineAuth" ? tNow("lan.setup.tsWhy.out")
      : ts.state === "Starting" ? tNow("lan.setup.tsWhy.starting")
      : tNow("lan.setup.tsWhy.silent");
    return tNow("lan.setup.tsState", { why });
  }
  const whose = ts.login ?? tNow("lan.setup.tsAccount");
  return ts.on ? tNow("lan.setup.tsOnline", { n: ts.devices, whose }) : whose;
}

/** What a paused automatic switch says on hover: why it cannot be pressed, and
 *  where the thing that holds it is. One sentence for all four of them. */
const PAUSED_MSG = "lan.setup.paused";

export default function LanSetupModal({ status, accounts, onClose, onChanged }: {
  status: LanStatus;
  accounts: LanAccount[];
  /** The addresses typed into this deck, from prefs. Unused here since the
   *  dialling moved into the panel — kept on the props so the section has one
   *  shape to pass and the two files cannot disagree about it. */
  manual?: string[];
  onClose: () => void;
  /** Something was written — reload the section behind this and the roster. */
  onChanged: () => void;
}) {
  // Opened: one of the features the usage reports name (feature-use.ts).
  useFeatureUse("lan-setup");
  const t = useT();
  const dialogRef = useModalDismiss(onClose);
  const scrimPress = useScrimDismiss(onClose);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [failure, setFailure] = useState<SettingsLine | null>(null);
  /** The fingerprint's copy word reads `copied` for a moment after it lands. */
  const [copied, setCopied] = useState(false);
  // THE SECOND PRESS IS GONE, AND WITH IT #828's ARMING. That guard was built
  // when saying yes shipped OFF: an unguarded press then took a deck from the
  // shipped state to the giving-something-away one, and a mis-toggle was worth
  // a confirmation. Now that it ships ON, the two presses only ever stood
  // between somebody and the state their deck was already in — and the switch
  // people actually reach for it with is the one that turns it OFF, which was
  // never armed. A switch whose first press does nothing visible reads as
  // broken, which is how it was reported.
  //
  // What survives is what the guard was really for: the label says what the
  // switch does, --warn says it costs something, and the line under it says
  // what is given away while it is on.
  /** WHICH control is working, not WHETHER one is. `pressState` is what tells
   *  "yours" from "somebody else's", and it needs a tag to do it: one boolean
   *  across the name field and every account tick would mark all of them as
   *  working the instant any one of them was pressed. */
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const pressProps = (tag: string) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy };
  };
  /** What we last sent, so a second tick inside one poll window composes with
   *  the first instead of being built from a render that predates it. */
  const pending = useRef<string[] | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The server has caught up with the last thing we sent, so it is the truth
  // again and the optimistic copy is retired. A REFUSED write is retired where
  // it is answered, in the box's onChange below — the server never catches up
  // with a list it did not store, so waiting for it here kept the boxes
  // showing what was sent for as long as the dialog stayed open (#1175).
  useEffect(() => {
    pending.current = settlePending(pending.current, status.shared ?? [], null);
  }, [status.shared]);

  const write = useCallback(async (lan: Record<string, unknown>, what: string, tag = "write") => {
    // Unguarded on purpose: a tick composes with the tick before it through
    // `pending`, and refusing the second press would drop it. What the tag adds
    // is only which control says it is working.
    busyRef.current = tag;
    setBusy(tag);
    try {
      const res = await fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lan }),
      });
      const out = await res.json().catch(() => null);
      if (!alive.current) return false;
      if (out?.ok) setFailure(null); else setFailure(refusalLine(writeFailure(what, out), out));
      onChanged();
      return out?.ok === true;
    } catch {
      if (alive.current) setFailure(refusalLine(writeFailure(what, null)));
      return false;
    } finally {
      busyRef.current = null;
      if (alive.current) setBusy(null);
    }
  }, [onChanged]);

  /** The typed name, sent, and let go of only once the deck has kept it. Enter
   *  and `save` used to drop it the moment they sent it, so the field snapped
   *  back to the old name at once — and a refused write left its failure line
   *  beside a field that no longer held what was typed (#1801). A name typed on
   *  while the answer was out is newer than the one sent, and stays. */
  const saveName = useCallback(async (draft: string) => {
    const ok = await write({ name: draft }, "save the name", "name");
    if (ok && alive.current) setNameDraft(d => (d === draft ? null : d));
    return ok;
  }, [write]);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameDirty = nameDraft != null && nameDraft !== (status.name ?? "");
  // `save` is drawn only while the name differs, so a save the deck kept takes
  // it away under the press, and focus goes back to the field it saved.
  const rescueSave = useFocusRescue(!nameDirty, nameRef);

  /** The one way out that is also a decision. A name somebody typed and did
   *  not save is saved on the way, because pressing Done over an unsaved field
   *  is the reader saying they meant it — and the dialog stays open if that
   *  write fails, so the failure line is read rather than closed on. Every box
   *  and switch here was already saved the moment it changed. */
  const done = useCallback(async () => {
    if (nameDirty && !(await saveName(nameDraft))) return;
    onClose();
  }, [nameDirty, nameDraft, saveName, onClose]);

  /** Copied rather than read out: it is compared on another machine, and a
   *  failed copy leaves the value on screen to select by hand. */
  const copyFingerprint = async () => {
    if (!status.fp) return;
    const ok = await copyText(status.fp);
    if (!alive.current) return;
    if (!ok) { setFailure(refusalLine(t("lan.fail.copyFp"))); return; }
    setCopied(true);
    window.setTimeout(() => { if (alive.current) setCopied(false); }, 1_600);
  };

  const shared = new Set(pending.current ?? status.shared ?? []);
  // Absent means on: a deck that has not written prefs since this shipped is a
  // deck with the defaults, and reading a missing key as `off` would draw the
  // switches against what the engine is actually doing.
  const asks = status.autoAsk !== false;
  const says = status.autoAccept !== false;
  // Absent is automatic, which is what the engine does with a missing mode.
  const inviteOnly = status.pairingMode === "invite";
  // The automatic switches, LAN and Tailscale alike, while invite-only holds
  // them: still drawn, still showing what they will do when it is off, and not
  // pressable, because the engine ignores both pairs in that mode. Disabled
  // only through a state the reader did not just press, so no focus is lost.
  const autoProps = (tag: string) => {
    const p = pressProps(tag);
    return { ...p, disabled: p.disabled || inviteOnly };
  };
  // The same rule for the third: absent is on, which is what the engine does.
  const tells = status.shareActive !== false;
  // And the opposite for the fourth (#2192): absent is off, which is what the
  // engine does with a missing setting — the login this deck is on stays here.
  const sends = status.sendInUse === true;
  const ts = status.tailscale ?? null;
  const tsOn = !!ts?.on;
  const tsAsks = ts?.ask !== false;
  const tsSays = ts?.accept !== false;

  // Portalled like every dialog opened from inside the accounts panel: the
  // panel's layout rules are not a modal's to inherit — see AddAccountDialog.
  return createPortal(
    <div className="modal-backdrop" {...scrimPress} role="presentation">
      <div ref={dialogRef} className="modal lan-modal" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="lan-modal-title">
        <header className="modal-head">
          <div className="modal-title">
            <span id="lan-modal-title" className="modal-tool-name">{t("lan.setup.title")}</span>
          </div>
          <div className="modal-actions">
            <button className="glyph-btn" onClick={onClose} aria-label={t("lan.closeEsc")} title={t("lan.closeEsc")}>×</button>
          </div>
        </header>

        <section className="modal-body">
          {/* A folder given back is a deck that read its settings again, so
              the section and the roster behind this reload with it (#1711). */}
          <SettingsFailureLine line={failure} onDismiss={() => setFailure(null)}
            onAnswer={next => { setFailure(next); if (next.done) onChanged(); }} />

          <div className="modal-section">
            <h3 className="lan-h">{t("lan.setup.name")}</h3>
            <div className="ap-lan-row">
              <span className="ap-lan-label">{t("lan.setup.appearAs")}</span>
              <input
                ref={nameRef}
                className="ap-manage-input ap-lan-input"
                aria-label={t("lan.setup.nameAria")}
                value={nameDraft ?? status.name ?? ""}
                placeholder={t("lan.setup.namePlaceholder")}
                onChange={e => setNameDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key !== "Enter" || nameDraft == null) return;
                  void saveName(nameDraft);
                }}
              />
              {nameDirty && (
                <button type="button" className="ap-manage-btn" {...pressProps("name")}
                  onClick={() => { rescueSave(); void saveName(nameDraft); }}
                  title={t("lan.setup.saveTitle")}>{t("lan.save")}</button>
              )}
            </div>
            <div className="ap-lan-row">
              <span className="ap-lan-label">{t("lan.fingerprint")}</span>
              {status.fp ? (
                <span className="lan-fp">
                  <code className="ap-lan-code">{status.fp}</code>
                  <button type="button" className="ap-lan-word lan-copy" onClick={() => void copyFingerprint()}
                    aria-label={copied ? t("lan.fpCopied") : t("lan.setup.fpCopyThis")}>
                    {copied ? t("lan.copied") : t("lan.copy")}
                  </button>
                </span>
              ) : (
                <span className="ap-lan-label">{t("lan.setup.fpUnknown")}</span>
              )}
            </div>
          </div>

          <div className="modal-section">
            <h3 className="lan-h">{t("lan.setup.shareH")}</h3>
            <div className="ap-lan-picks">
              {accounts.length === 0 && (
                <span className="ap-lan-empty">
                  {t("lan.setup.shareNone")}
                </span>
              )}
              {accounts.map(a => (
                <label key={a.key} className="ap-lan-pick" title={!a.alive
                  ? t("lan.setup.shareDead")
                  // The one this deck is on heals nobody while it is (#2192).
                  : a.inUse
                    ? t("lan.setup.shareInUse")
                    : t("lan.setup.shareOffer")}>
                  <input
                    type="checkbox"
                    checked={shared.has(a.key)}
                    onChange={e => {
                      const next = nextShared(pending.current, status.shared ?? [], a.key, e.target.checked);
                      pending.current = next;
                      void write(
                        { shared: next },
                        e.target.checked ? "share that account" : "stop sharing that account",
                      ).then(ok => {
                        // Only the newest tick settles: an older one's answer is
                        // about a list a later tick has already replaced.
                        if (pending.current === next) pending.current = settlePending(next, status.shared ?? [], { ok });
                      });
                    }}
                  />
                  <span className="ap-lan-pick-name">{a.email}</span>
                  {/* Not "dead": a reader who has not read the docs cannot tell whether
                      that is about the account or about this machine. It is about this
                      machine's copy, and that is what makes it the one a peer heals. */}
                  {!a.alive && <span className="ap-lan-dead">{t("lan.setup.notWorking")}</span>}
                  {/* THE ONE THIS DECK IS ON, ticked, stays here while it is
                      (#2192) — said beside it, in the same quiet words, so a
                      tick that seems to do nothing says why. Unticked, nothing
                      is sent either way, and the row says nothing, as before. */}
                  {a.alive && a.inUse && shared.has(a.key) && <span className="ap-lan-dead">{t("lan.setup.inUseNotSent")}</span>}
                </label>
              ))}
            </div>
            {/* WHICH OF THESE THIS DECK IS ON, told to the decks it is paired
                with. Under the list rather than with the pairing switches,
                because it only ever names an account ticked above — sitting
                here, it says so without a sentence. */}
            {accounts.length > 0 && (
              <div className="lan-switches">
                <div className="lan-switch">
                  <span className="lan-switch-what">{t("lan.setup.tell")}</span>
                  <button
                    type="button"
                    className="switch ap-auto-state"
                    role="switch"
                    aria-checked={tells}
                    aria-label={t("lan.setup.tell")}
                    {...pressProps("current")}
                    onClick={() => void write(
                      { shareActive: !tells },
                      tells ? "stop showing which account this deck is using" : "show which account this deck is using",
                      "current",
                    )}
                    title={tells
                      ? t("lan.setup.tellOn")
                      : t("lan.setup.tellOff")}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
                {/* THE LOGIN IN USE, SENT TOO — an explicit choice, off until
                    somebody makes it (#2192). A Claude login renews once, so two
                    machines on one copied login race for it and the loser is
                    signed out; while it is off the account this deck is on stays
                    here and goes out like the others once this deck switches
                    away. Its line says what it costs only while it is on, the
                    rule invite-only keeps below: off is the resting state. The
                    other machine need not use the copy to race: claude-swap
                    renews an idle slot's login while it reads that slot's
                    usage, so the line does not say "if it uses it". And it
                    wears --warn, like the one switch below whose on gives
                    something away. */}
                <div className="lan-switch">
                  <span className="lan-switch-what">
                    {t("lan.setup.send")}
                    {sends && (
                      <span id="lan-send-in-use-detail" className="lan-switch-detail">
                        {t("lan.setup.sendDetail")}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="switch ap-auto-state"
                    role="switch"
                    aria-checked={sends}
                    aria-label={t("lan.setup.send")}
                    aria-describedby={sends ? "lan-send-in-use-detail" : undefined}
                    data-tone="warn"
                    {...pressProps("send-in-use")}
                    onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                    onClick={() => void write(
                      { sendInUse: !sends },
                      sends ? "keep the login this deck is using here" : "send the login this deck is using",
                      "send-in-use",
                    )}
                    title={sends
                      ? t("lan.setup.sendOn")
                      : t("lan.setup.sendOff")}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="modal-section">
            <h3 className="lan-h" id="lan-pairing-h">{t("lan.setup.pairing")}</h3>
            {/* INVITE-ONLY IS A SWITCH, and it sits above the two it overrides.
                It was two native radios — "Automatic pairing (current
                behavior)" / "by invite code only" — in the one dialog whose
                every other on/off is a track and a knob, and with `disabled`
                on the focused one, which drops keyboard focus to <body> (#518).
                One more switch is one fewer kind of control to learn, and "off"
                is what automatic always meant.

                ITS LINE SAYS WHAT CHANGED, AND ONLY WHILE IT IS ON: the owner's
                rule below is about prose over a resting state, and off is the
                resting state. On, the two switches under it are paused rather
                than hidden, so what comes back when this goes off is in view. */}
            <div className="lan-switches lan-switches-lead" role="group" aria-labelledby="lan-pairing-h">
              <div className="lan-switch">
                <span className="lan-switch-what">
                  {t("lan.setup.inviteOnly")}
                  {inviteOnly && (
                    <span id="lan-invite-only-detail" className="lan-switch-detail">
                      {t("lan.setup.inviteOnlyDetail")}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="switch ap-auto-state"
                  role="switch"
                  aria-checked={inviteOnly}
                  aria-label={t("lan.setup.inviteOnly")}
                  aria-describedby={inviteOnly ? "lan-invite-only-detail" : undefined}
                  {...pressProps("mode")}
                  // A held key is one decision: switching it on turns away the
                  // requests that are waiting, and a repeat would undo that.
                  onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                  onClick={() => void write(
                    { pairingMode: inviteOnly ? "automatic" : "invite" },
                    inviteOnly ? "let decks pair on their own again" : "pair new decks only by invite",
                    "mode",
                  )}
                  title={inviteOnly
                    ? t("lan.setup.inviteOnlyOn")
                    : t("lan.setup.inviteOnlyOff")}
                >
                  <span className="switch-knob" />
                </button>
              </div>
            </div>

            {/* Two rows and one shape, because they are the two halves of one
                question: who reaches whom without anybody pressing anything.
                A TRACK AND A KNOB, which is what every switch in this app wears
                now — see `.switch` (#886). It was a pill with a dot and the
                word `on` in it, which reports a state well and asks for one
                badly. Paused, not hidden, while invite-only holds them. */}
            {/* NAMED AS WHAT INVITE-ONLY OVERRIDES. Two switches under a third
                read as three equal settings, and "ask every deck" beside "only
                by invite" looked like a contradiction. A caption and a rule
                above them make them one group the switch above governs, and the
                caption says so while it holds them. A label, not a paragraph:
                it says what the group is, not what the reader should do. */}
            <div className="lan-auto" role="group" aria-labelledby="lan-auto-h">
            <p className="lan-sub" id="lan-auto-h">
              {t("lan.setup.autoH")}
              {inviteOnly && <span className="lan-sub-state"> · {t("lan.setup.autoPaused")}</span>}
            </p>
            <div className="lan-switches" data-paused={inviteOnly || undefined}>
              <div className="lan-switch">
                <span className="lan-switch-what">{t("lan.setup.ask")}</span>
                <button
                  type="button"
                  className="switch ap-auto-state"
                  role="switch"
                  aria-checked={asks}
                  aria-label={t("lan.setup.ask")}
                  {...autoProps("ask")}
                  onClick={() => void write(
                    { autoAsk: !asks },
                    asks ? "stop asking automatically" : "ask every deck this one finds",
                    "ask",
                  )}
                  title={inviteOnly ? t(PAUSED_MSG) : asks
                    ? t("lan.setup.askOn")
                    : t("lan.setup.askOff")}
                >
                  <span className="switch-knob" />
                </button>
              </div>
              <div className="lan-switch">
                <span className="lan-switch-what">{t("lan.setup.accept")}</span>
                <button
                  type="button"
                  className="switch ap-auto-state"
                  role="switch"
                  aria-checked={says}
                  aria-label={t("lan.setup.accept")}
                  // The one switch here whose on gives something away: it fills
                  // with --warn, on either press, from the first one.
                  data-tone="warn"
                  {...autoProps("accept")}
                  // A held key is one decision, as it is on unpair.
                  onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                  onClick={() => void write(
                    { autoAccept: !says },
                    says ? "stop accepting automatically" : "accept every deck that asks",
                    "accept",
                  )}
                  title={inviteOnly ? t(PAUSED_MSG) : says
                    ? t("lan.setup.acceptOn")
                    : t("lan.setup.acceptOff")}
                >
                  <span className="switch-knob" />
                </button>
              </div>
            </div>
            </div>
            {/* AND NO PARAGRAPH UNDER THEM. There was one: it changed with the
                switches and went yellow while saying yes was on. Once that
                setting ships ON, the yellow is the resting state of the dialog —
                a warning about the way the deck comes out of the box, over a
                control whose own label already says what it does in the same
                words. A surface that shouts about its resting state is one
                people stop reading, and the sentence it shouted was the label
                again.

                What says it instead: the switch's label, its --warn fill, and
                its title. The owner asked for the line gone, 2026-09-16. */}
          </div>

          {ts?.found && (
            <div className="modal-section">
              <h3 className="lan-h">{t("lan.setup.ts")}</h3>
              <div className="lan-switches">
                <div className="lan-switch">
                  <span className="lan-switch-what">
                    {t("lan.setup.tsLook")}
                    <span id="lan-ts-detail" className="lan-switch-detail">{tailscaleDetail(ts)}</span>
                  </span>
                  <button
                    type="button"
                    className="switch ap-auto-state"
                    role="switch"
                    aria-checked={tsOn}
                    aria-label={t("lan.setup.tsLookAria")}
                    aria-describedby="lan-ts-detail"
                    {...pressProps("tailscale")}
                    onClick={() => void write(
                      { tailscale: !tsOn },
                      tsOn ? "stop looking over Tailscale" : "look for your devices over Tailscale",
                      "tailscale",
                    )}
                    title={tsOn
                      ? t("lan.setup.tsOn")
                      : t("lan.setup.tsOff")}
                  >
                    <span className="switch-knob" />
                  </button>
                </div>
                {tsOn && (
                  <div className="lan-auto" role="group" aria-labelledby="lan-ts-auto-h">
                    <p className="lan-sub" id="lan-ts-auto-h">
                      {t("lan.setup.tsAutoH")}
                      {inviteOnly && <span className="lan-sub-state"> · {t("lan.setup.autoPaused")}</span>}
                    </p>
                    <div className="lan-switches">
                    <div className="lan-switch" data-paused={inviteOnly || undefined}>
                      <span className="lan-switch-what">{t("lan.setup.tsAsk")}</span>
                      <button
                        type="button"
                        className="switch ap-auto-state"
                        role="switch"
                        aria-checked={tsAsks}
                        aria-label={t("lan.setup.tsAskAria")}
                        {...autoProps("tailscale-ask")}
                        onClick={() => void write(
                          { tailscaleAsk: !tsAsks },
                          tsAsks ? "stop asking your devices automatically" : "ask your devices automatically",
                          "tailscale-ask",
                        )}
                        title={inviteOnly ? t(PAUSED_MSG) : tsAsks
                          ? t("lan.setup.askOn")
                          : t("lan.setup.tsAskOff")}
                      >
                        <span className="switch-knob" />
                      </button>
                    </div>
                    <div className="lan-switch" data-paused={inviteOnly || undefined}>
                      <span className="lan-switch-what">{t("lan.setup.tsAccept")}</span>
                      <button
                        type="button"
                        className="switch ap-auto-state"
                        role="switch"
                        aria-checked={tsSays}
                        aria-label={t("lan.setup.tsAcceptAria")}
                        data-tone="warn"
                        {...autoProps("tailscale-accept")}
                        onKeyDown={e => { if (e.repeat) e.preventDefault(); }}
                        onClick={() => void write(
                          { tailscaleAccept: !tsSays },
                          tsSays ? "stop accepting your devices automatically" : "accept your devices automatically",
                          "tailscale-accept",
                        )}
                        title={inviteOnly ? t(PAUSED_MSG) : tsSays
                          ? t("lan.setup.tsAcceptOn")
                          : t("lan.setup.tsAcceptOff")}
                      >
                        <span className="switch-knob" />
                      </button>
                    </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* A WAY OUT THAT IS A DECISION. This dialog opens by itself on the
            press that puts this deck on the network, and one that arrives on
            its own and offers only a × reads as unfinished — as if something
            still had to be confirmed. Nothing does: every box and switch above
            is saved the moment it changes, which the note says, and Done saves
            the one field that is not. */}
        <footer className="lan-setup-foot">
          <span className="lan-foot-note">{t("lan.setup.foot")}</span>
          <button type="button" className="btn primary" {...pressProps("name")} onClick={() => void done()}>
            {t("lan.setup.done")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
