// Reaching a deck the network could not offer, in a dialog rather than in a
// drawer inside a 288px column.
//
// It lived in the panel, folded away behind `+ add a deck`, and everything in
// it is the wrong shape for that column: an address is monospace, an invite is
// a 140-character token, and the block that explains a firewall is a paragraph
// and a shell command. Unfolded, the section it belongs to stopped being a list
// of machines and became a form with a list on top of it.
//
// So the two ways in get the room they need. What stays in the panel is the
// word that opens this, because the panel's job is to say who is out there.
//
// THE TWO ROUTES ARE NOT ALTERNATIVES, and the order they are in says which is
// which. An invite is dialled by whoever PASTES it, so a deck nothing can reach
// from outside has to be the one pasting rather than the one minting — that is
// why the reach warning sits above both and points at the paste field. Typing
// an address works the same way round: this deck dials out, and one outbound
// connection is the whole of a round. See lan-reach.mjs.
import { useCallback, useEffect, useRef, useState } from "react";
import { useModalDismiss } from "./use-modal-dismiss";
import { pressAccepted, pressState } from "../panel-press";
import { leftLabel, parseAddress, writeFailure } from "./LanSyncSection";
import type { LanStatus } from "./LanSyncSection";

async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

export default function LanAddDeckModal({ status, manual, onClose, onChanged }: {
  status: LanStatus;
  /** The addresses this deck dials, from prefs. A write replaces the list
   *  wholesale, so adding one means sending all of them. */
  manual: string[];
  onClose: () => void;
  /** Something landed — reload the section behind this. */
  onChanged: () => void;
}) {
  const addrRef = useRef<HTMLInputElement>(null);
  // The address field takes focus rather than the dialog's first control: the
  // reader pressed `+ add a deck` and the deck they mean is either an address
  // or a token, and only one of the two is something they are holding.
  const dialogRef = useModalDismiss(onClose, { focusRef: addrRef });
  const [addrDraft, setAddrDraft] = useState("");
  const [joinDraft, setJoinDraft] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Which addresses a failed join tried, and what each one said. An invite
   *  carries several because nobody knows which routes; when none did, that
   *  list is the only thing the reader can act on. */
  const [tried, setTried] = useState<Array<{ addr: string; why: string }> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // The invite has a countdown on it, so this dialog has a clock.
    const iv = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(iv);
  }, []);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const busyRef = useRef<string | null>(null);
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
   *  your own request. */
  const pressProps = (tag: string) => {
    const s = pressState(busy, tag);
    return { disabled: s.disabled, "aria-busy": s.busy };
  };

  const addAddress = useCallback(async () => {
    const parsed = parseAddress(addrDraft);
    if (!parsed) { setFailure("That is not an address and a port — try 192.168.1.5:54340."); return; }
    if (!claim("add")) return;
    try {
      const entry = `${parsed.addr}:${parsed.port}`;
      const out = await post("/api/prefs", { lan: { manual: [...manual.filter(m => m !== entry), entry] } });
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); setAddrDraft(""); onChanged(); onClose(); }
      else setFailure(writeFailure("add that address", out));
    } catch {
      if (alive.current) setFailure(writeFailure("add that address", null));
    } finally {
      release();
    }
  }, [addrDraft, manual, onChanged, onClose, claim, release]);

  const invite = useCallback(async (action: "make" | "withdraw") => {
    if (!claim(`invite:${action}`)) return;
    try {
      const out = await post("/api/lan/invite", { action });
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); setCopied(null); onChanged(); }
      else setFailure(writeFailure(action === "make" ? "make an invite" : "cancel that invite", out));
    } catch {
      if (alive.current) setFailure(writeFailure(action === "make" ? "make an invite" : "cancel that invite", null));
    } finally {
      release();
    }
  }, [onChanged, claim, release]);

  const join = useCallback(async () => {
    const token = joinDraft.trim();
    if (!token || !claim("join")) return;
    setTried(null);
    try {
      const out = await post("/api/lan/invite", { action: "join", token });
      if (!alive.current) return;
      if (out?.ok) { setJoinDraft(""); setFailure(null); onChanged(); onClose(); }
      else {
        setTried(Array.isArray(out?.tried) ? out.tried : null);
        setFailure(writeFailure("use that invite", out));
      }
    } catch {
      if (alive.current) setFailure(writeFailure("use that invite", null));
    } finally {
      release();
    }
  }, [joinDraft, onChanged, onClose, claim, release]);

  const copyText = useCallback(async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      window.setTimeout(() => { if (alive.current) setCopied(c => (c === tag ? null : c)); }, 1_600);
    } catch {
      setFailure("Could not copy it — select the text and copy it by hand.");
    }
  }, []);

  const live = status.invite && status.invite.expiresAt > now ? status.invite : null;
  const steps = status.reach?.steps ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div ref={dialogRef} className="modal lan-add" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby="lan-add-title">
        <header className="modal-head">
          <div className="modal-title">
            <span id="lan-add-title" className="modal-tool-name">Add a deck</span>
          </div>
          <div className="modal-actions">
            <button className="glyph-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">×</button>
          </div>
        </header>

        <section className="modal-body">
          {failure && (
            <div className="ap-failure" role="alert">
              <span className="ap-failure-text">{failure}</span>
              <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
                aria-label="Dismiss this message" title="Dismiss">×</button>
            </div>
          )}

          {/* WHY THE LIST IS EMPTY, WHEN THE MACHINE CAN BE ASKED. "Nothing here
              yet" and "nothing can get in" look identical and are not: the first
              is answered by waiting and the second never is. What comes first is
              the way out that needs no firewall rule at all, because a round is
              one OUTBOUND connection — this deck dialling is the whole of it.
              The command comes second, is optional, and is text: nothing here
              runs it, for the reason relay-guard.mjs gives. */}
          {status.reach?.blocked && (
            <div className="ap-lan-reach">
              <p className="lan-warn">{status.reach.text}</p>
              <p className="lan-note">
                Nothing here is stuck: a deck that dials out first needs none of this.
                {" "}<strong>Ask them for an invite and paste it below</strong> — an invite is dialled
                by whoever pastes it, so on this machine it has to be pasted rather than made.
                Typing their address works the same way.
              </p>
              {steps.length > 0 && (
                <details className="ap-lan-reach-fix">
                  <summary>or let them find this deck on their own</summary>
                  <p className="lan-note">
                    Run this in PowerShell <strong>as Administrator</strong>, then restart the deck.
                    {status.reach.category === "Public" && (
                      <> The first line marks this network as a home or office one — leave it
                      out on a network you do not trust.</>
                    )}
                  </p>
                  <pre className="ap-lan-cmd"><code>{steps.join("\n")}</code></pre>
                  <button type="button" className="ap-manage-btn" {...pressProps("copy:fix")}
                    onClick={() => void copyText(steps.join("\n"), "fix")}
                    title="Copy these lines, then paste them into an elevated PowerShell">
                    {copied === "fix" ? "copied" : "copy command"}
                  </button>
                </details>
              )}
            </div>
          )}

          <div className="modal-section">
            <h3 className="lan-h">By address</h3>
            <div className="ap-lan-row">
              <input
                ref={addrRef}
                className="ap-manage-input ap-lan-input"
                aria-label="Another deck's address"
                value={addrDraft}
                placeholder="192.168.1.5:54340"
                spellCheck={false}
                onChange={e => setAddrDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void addAddress(); }}
              />
              {/* The verb arrives with something to commit, rather than sitting
                  there disabled: #620's rule is that a press never disables the
                  control it came from, and `disabled` here would have to mean
                  two different things at once. */}
              {addrDraft.trim() !== "" && (
                <button type="button" className="ap-manage-btn" {...pressProps("add")}
                  onClick={() => void addAddress()}
                  title="Try this address every minute, starting now.">add</button>
              )}
            </div>
            <p className="lan-note">
              This deck dials that one and asks to pair; somebody there has to accept.
              Use it when a deck has not turned up on its own — another subnet, a VPN,
              or a firewall in the way.
            </p>
          </div>

          <div className="modal-section">
            <h3 className="lan-h">With an invite</h3>
            <div className="ap-lan-row">
              <input
                className="ap-manage-input ap-lan-input"
                aria-label="An invite you were sent"
                value={joinDraft}
                placeholder="paste one you were sent"
                spellCheck={false}
                onChange={e => { setJoinDraft(e.target.value); setTried(null); }}
                onKeyDown={e => { if (e.key === "Enter") void join(); }}
              />
              {joinDraft.trim() !== "" && (
                <button type="button" className="ap-manage-btn" {...pressProps("join")}
                  onClick={() => void join()}
                  title="Reach that deck and pair with it. Nobody has to press anything there.">
                  {busy === "join" ? "joining…" : "join"}
                </button>
              )}
            </div>
            <p className="lan-note">
              Pasting one pairs the two decks on the spot — nothing to press on either side.
            </p>

            {tried && (
              <div className="ap-lan-tried">
                <span className="lan-note">
                  Nothing answered at any address in that invite. Check that deck is running
                  and that its Local network switch is on.
                </span>
                {tried.map(t => (
                  <span key={t.addr} className="ap-lan-tried-row">
                    <code className="ap-lan-code">{t.addr}</code>
                    <span className="ap-lan-bad">{t.why}</span>
                  </span>
                ))}
              </div>
            )}

            {live ? (
              <div className="ap-lan-invite">
                <div className="ap-lan-invite-head">
                  <span className="ap-lan-invite-title">Send this to them</span>
                  <span className="ap-lan-invite-left">{leftLabel(live.expiresAt, now)} left</span>
                </div>
                <code className="ap-lan-token">{live.token}</code>
                <div className="ap-lan-acts">
                  <button type="button" className="ap-manage-btn" {...pressProps("copy:invite")}
                    onClick={() => void copyText(live.token, "invite")}
                    title="Copy it, and send it however you already talk to them">
                    {copied === "invite" ? "copied" : "copy"}
                  </button>
                  <button type="button" className="ap-manage-btn" {...pressProps("invite:withdraw")}
                    onClick={() => void invite("withdraw")}
                    title="Cancel it. Anybody already holding the text can no longer use it.">
                    cancel
                  </button>
                </div>
                <p className="lan-note">
                  It carries every address this deck has, so they do not have to know which
                  one works.
                </p>
                <p className="lan-warn">
                  Anyone who gets hold of this text can pair with this deck until it runs out.
                </p>
              </div>
            ) : (
              <button type="button" className="ap-manage-btn lan-add-mint" {...pressProps("invite:make")}
                onClick={() => void invite("make")}
                title="One piece of text you send them. They paste it and the two decks pair.">
                make an invite for them
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
