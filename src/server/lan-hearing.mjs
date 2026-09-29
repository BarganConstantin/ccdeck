// Whether this deck can hear other decks announce themselves, and what the
// panel says while it cannot: lifted out of createEngine in lan-engine.mjs
// with the one variable only it used — who is holding the discovery port.
// The beacon knows WHETHER it hears (see createBeacon's `hearing`); this keeps
// the sentence, and asks port-holder.mjs once per spell whose fault it is.
import { DISCOVERY_PORT } from "./lan-beacon.mjs";

/**
 * `beaconNow` answers the engine's beacon as it is at the moment of asking,
 * null while it is down. `portHolder` names the program on the port — see
 * port-holder.mjs — and without one nothing is asked. `onChange` is the
 * engine's own, so the panel redraws when the answer arrives.
 */
export function createHearing({ beaconNow, portHolder, onChange }) {
  /** Who held the discovery port the last time it was asked, for as long as
   *  this deck cannot hear: the answer does not change between two tries half a
   *  minute apart, and on Windows asking costs a PowerShell start. Undefined
   *  until asked, null when the machine would not say. */
  let holder;

  /** What the panel says while this deck cannot hear — see createBeacon's
   *  `hearing`. Null whenever it can. */
  const deafLine = () => {
    const beacon = beaconNow();
    if (!beacon || beacon.hearing()) return null;
    const err = beacon.deafError?.();
    if (err && err.code !== "EADDRINUSE") {
      return `This deck cannot listen on UDP ${DISCOVERY_PORT} (${err.code ?? err.message}), so it hears no other deck announce itself. Other decks still find it and pair with it.`;
    }
    return `${holder ?? "Another program"} is holding UDP ${DISCOVERY_PORT}, so this deck hears no new decks. Others still find it and pair with it, and it takes the port back as soon as it is free.`;
  };

  /** The beacon took the discovery port, or lost it: say so, and while it
   *  cannot hear, ask once which program is holding the port. See deafLine. */
  const hearingChanged = now => {
    if (now) { holder = undefined; onChange?.(); return; }
    if (holder === undefined && portHolder && beaconNow()?.deafError?.()?.code === "EADDRINUSE") {
      holder = null;
      void Promise.resolve().then(() => portHolder()).then(who => { holder = who ?? null; onChange?.(); }, () => {});
    }
    onChange?.();
  };

  /** Forget who held the port, so the next spell of deafness asks again —
   *  what a stop does, because the next start may find somebody else there. */
  const forget = () => { holder = undefined; };

  return { deafLine, hearingChanged, forget };
}
