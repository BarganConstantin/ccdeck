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
//
// TWO METHODS AND THREE TASKS, which is the shape a critique found wrong here.
// Minting was a full-width bordered button at the foot of the invite section,
// directly under that section's field and its help — the strongest visual
// weight in the dialog, in the position a form puts its submit, for the one
// action that does not add a deck at all. It is the OTHER DIRECTION of the
// invite method: they add this deck rather than this deck adding them. So it
// moved onto the invite heading's own row, where a trailing quiet verb reads as
// a second direction inside the method rather than as the field's commit.
//
// What is left below is two methods with identical rhythm — heading, field,
// one sentence — because two things drawn the same way read as two of a kind,
// and that is the whole of "there are two ways in". The one sentence each is
// the difference that decides between them: an address waits on a person, an
// invite does not.
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

/**
 * What the engine's refusal MEANS, for the four it can give this dialog.
 *
 * `writeFailure` prints the code — "the deck refused it (expired)" — which is
 * right for a reason nobody predicted and wrong for these, because each one has
 * a next move and the code says none of them. A reason this map has never seen
 * still falls through to the code, so a new one is reported rather than
 * swallowed by a guess.
 */
const JOIN_FAULTS: Record<string, string> = {
  not_an_invite: "That is not an invite — paste the whole line they sent you.",
  expired: "That invite has run out. Ask them for a fresh one.",
  not_running: "This deck is not on the network yet. Turn Local network on, then try again.",
};

const MINT_FAULTS: Record<string, string> = {
  not_running: "This deck is not on the network yet. Turn Local network on, then make one.",
};

export function faultLine(
  known: Record<string, string>,
  out: { ok?: boolean; reason?: string } | null,
  what: string,
): string {
  return (out?.reason && known[out.reason]) || writeFailure(what, out);
}

/** Which field a message is about, so the message can be tied to it for a
 *  reader who is not looking at the top of the dialog. */
type Failure = { text: string; field?: "addr" | "join" };

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
  const [failure, setFailure] = useState<Failure | null>(null);
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
  /** The one alert box, tied to whichever field put it there. */
  const fieldProps = (field: "addr" | "join") => (failure?.field === field
    ? { "aria-invalid": true, "aria-describedby": "lan-add-failure" }
    : {});
  /** Editing a field retires that field's complaint, and only that one: a
   *  failed copy or a refused mint is not answered by typing an address, and
   *  clearing it on any keystroke made the message look like a flicker. */
  const clearFor = (field: "addr" | "join") =>
    setFailure(f => (f && f.field === field ? null : f));

  const addAddress = useCallback(async () => {
    const parsed = parseAddress(addrDraft);
    if (!parsed) {
      setFailure({ text: addressFault(addrDraft), field: "addr" });
      return;
    }
    const entry = `${parsed.addr}:${parsed.port}`;
    // TWO WAYS THIS ALREADY EXISTS, and neither of them used to say so: the
    // write succeeded, the dialog closed, and the list behind it looked exactly
    // as it had. A person who typed the address of a deck they are already
    // paired with had no way to tell that from a deck that has not answered
    // yet.
    const met = status.peers.find(p => p.addr === parsed.addr && p.port === parsed.port && p.paired);
    if (met) {
      setFailure({ text: `Already paired with ${met.name} at that address.`, field: "addr" });
      return;
    }
    if (manual.includes(entry)) {
      setFailure({ text: "This deck already calls that address.", field: "addr" });
      return;
    }
    if (!claim("add")) return;
    try {
      const out = await post("/api/prefs", { lan: { manual: [...manual, entry] } });
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); setAddrDraft(""); onChanged(); onClose(); }
      else setFailure({ text: writeFailure("add that address", out), field: "addr" });
    } catch {
      if (alive.current) setFailure({ text: writeFailure("add that address", null), field: "addr" });
    } finally {
      release();
    }
  }, [addrDraft, manual, status.peers, onChanged, onClose, claim, release]);

  const invite = useCallback(async (action: "make" | "withdraw") => {
    if (!claim(`invite:${action}`)) return;
    const what = action === "make" ? "make an invite" : "cancel that invite";
    try {
      const out = await post("/api/lan/invite", { action });
      if (!alive.current) return;
      if (out?.ok) { setFailure(null); setCopied(null); onChanged(); }
      else setFailure({ text: faultLine(MINT_FAULTS, out, what) });
    } catch {
      if (alive.current) setFailure({ text: writeFailure(what, null) });
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
      else if (out?.reason === "unreachable" && Array.isArray(out.tried) && out.tried.length) {
        // The list IS the message here, and printing both put the same finding
        // in two places with the dialog's top pushed down between them.
        setTried(out.tried);
        setFailure(null);
      } else {
        setTried(null);
        setFailure({ text: faultLine(JOIN_FAULTS, out, "use that invite"), field: "join" });
      }
    } catch {
      if (alive.current) setFailure({ text: writeFailure("use that invite", null), field: "join" });
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
      setFailure({ text: "Could not copy it — select the text and copy it by hand." });
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
              <span id="lan-add-failure" className="ap-failure-text">{failure.text}</span>
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
                Nothing here is stuck: whoever pastes an invite is the one dialling out.
                Ask them for one and paste it below, or type their address.
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

          {/* Both methods are heading, field, one sentence, and the sentence is
              the same question answered two ways: does anybody have to say yes.
              Nothing else about the network is here — a reader choosing between
              two ways in cannot use a subnet. */}
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
                {...fieldProps("addr")}
                onChange={e => { setAddrDraft(e.target.value); clearFor("addr"); }}
                onKeyDown={e => { if (e.key === "Enter") void addAddress(); }}
              />
              {/* The verb arrives with something to commit, rather than sitting
                  there disabled: #620's rule is that a press never disables the
                  control it came from, and `disabled` here would have to mean
                  two different things at once. Its width is NOT held open for
                  it: an empty 70px gutter is a permanent raggedness against the
                  edge the heading's own verb sits on, paid every time the dialog
                  opens, to spare one field's right border moving once. */}
              {addrDraft.trim() !== "" && (
                <button type="button" className="ap-manage-btn" {...pressProps("add")}
                  onClick={() => void addAddress()}
                  title="Add it to the decks this one calls, starting now.">add</button>
              )}
            </div>
            <p className="lan-note">This deck calls that address until somebody there accepts.</p>
          </div>

          <div className="modal-section">
            {/* The other direction, on the heading's own row. Below the heading
                is the one field this method has; beside it is the way to be on
                the other end of somebody else's. */}
            <h3 className="lan-h">
              With an invite
              {!live && (
                <button type="button" className="ap-lan-word lan-h-act" {...pressProps("invite:make")}
                  onClick={() => void invite("make")}
                  title="One piece of text you send them. They paste it, and the two decks pair — nobody has to press anything here.">
                  {busy === "invite:make" ? "making…" : "make one to send"}
                </button>
              )}
            </h3>
            <div className="ap-lan-row">
              <input
                className="ap-manage-input ap-lan-input"
                aria-label="An invite you were sent"
                value={joinDraft}
                placeholder="paste one you were sent"
                spellCheck={false}
                {...fieldProps("join")}
                onChange={e => { setJoinDraft(e.target.value); setTried(null); clearFor("join"); }}
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
            <p className="lan-note">Pasting one pairs both decks on the spot — nobody has to accept.</p>

            {tried && (
              <div className="ap-lan-tried">
                <span className="lan-note">
                  Nothing answered at any address in that invite. Check that deck is running
                  with its Local network switch on.
                </span>
                {tried.map(t => (
                  <span key={t.addr} className="ap-lan-tried-row">
                    <code className="ap-lan-code">{t.addr}</code>
                    <span className="ap-lan-bad">{t.why}</span>
                  </span>
                ))}
              </div>
            )}

            {live && (
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
                <p className="lan-warn">
                  Anyone who gets this text can pair with this deck until it runs out.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Why an address was refused, in the terms of the thing that is wrong with it.
 *
 * One sentence for every case used to be "that is not an address and a port",
 * which is true of a missing port, of a typo, and of an IPv6 address somebody
 * wrote without brackets — three mistakes with three different corrections. The
 * shape is shown rather than described, because a person fixing a typed address
 * copies the example.
 */
export function addressFault(raw: string): string {
  const s = (raw ?? "").trim();
  if (s === "") return "Type an address and a port, like 192.168.1.5:54340.";
  // An unbracketed IPv6 address splits on the wrong colon, so it is refused
  // rather than dialled at whatever the last group happens to look like. The
  // message promises nothing about IPv6, because nothing here delivers it: it
  // names the two forms this deck does dial.
  if (!s.startsWith("[") && (s.match(/:/g) ?? []).length > 1) {
    return "Too many colons to split. Use that deck's IPv4 address or its name, like 192.168.1.5:54340.";
  }
  if (!s.includes(":")) return `Add the port too, like ${s}:54340.`;
  const port = s.slice(s.lastIndexOf(":") + 1).trim();
  if (port === "") return "That is missing its port — try 192.168.1.5:54340.";
  if (!/^\d+$/.test(port)) return `A port is a number, and this one is "${port}".`;
  return `A port runs from 1 to 65535, and this one is ${port}.`;
}
