// Why nothing will ever turn up, said under the switch that turned it on: the
// verdict on whether other decks can reach this one, a discovery port another
// program holds, and a local network sent through a tunnel.
//
// Lifted out of LanSyncSection.tsx unchanged, with the sentence for the
// tunnel. Each line is drawn only while the section is on; what each says,
// and why it is said here rather than anywhere else, is beside it.
import type { LanStatus, LanTailscale } from "../lan-types";
import LanReachNote from "./LanReachNote";

/**
 * What to say when this machine sends its local network through a tunnel. The
 * Tailscale case is named, with the setting that fixes it; any other VPN is
 * said generally. Exported for the suite.
 */
export function tunnelNote(s: { tailscale?: LanTailscale | null }): string {
  if (s.tailscale?.exitNode) {
    return "Tailscale sends this machine's local network through an exit node, so decks on this network cannot find this one. Turn on Allow local network access in Tailscale's exit node menu to bring them back.";
  }
  return "This machine sends its local network through a VPN, so decks on this network cannot find this one. Allowing local network access in the VPN brings them back.";
}

export default function LanDiscoveryNotes({ on, status }: {
  /** Whether this deck is on the network. Nothing here is said while it is not. */
  on: boolean;
  status: LanStatus | null;
}) {
  return (
    <>
      {/* WHY NOTHING WILL EVER TURN UP, UNDER THE SWITCH THAT TURNED IT ON.
          The verdict has been read off this machine since 3.23.2 and was
          drawn in one place: inside `+ add a deck`, which a reader opens
          only after deciding the feature is broken. So the deck knew, and
          the report that came back was still "I switched it on and nobody
          appeared". It belongs at the moment of the act — above the list it
          explains the emptiness of, and above the status line, because the
          status line says WHAT is happening and this says why it cannot.

          Only while the section is ON: a deck with the sockets down is not
          a deck anything is failing to reach, and the switch below would be
          answering a question nobody has asked yet. */}
      {on && <LanReachNote reach={status?.reach} where="panel" />}
      {/* A DECK THAT CANNOT HEAR IS STILL A DECK. It announces, it is found,
          it pairs and syncs; what it has lost is hearing new decks announce
          themselves, and the one line says so and who has the port. Not the
          warning ink: nothing here is for the reader to do, and the deck
          takes the port back on its own. */}
      {on && status?.deaf && <p className="ap-lan-fine">{status.deaf}</p>}
      {/* THE LOCAL NETWORK GOES THROUGH A TUNNEL HERE, so nothing on it can
          find this deck, and the deck has stopped shouting into the tunnel
          rather than onto somebody else's network. The one line says what
          to change, in the words the VPN's own menu uses. */}
      {on && status?.lanTunneled && <p className="ap-lan-fine">{tunnelNote(status)}</p>}
    </>
  );
}
