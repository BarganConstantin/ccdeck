// The machine panel's network section, and the popover that says which way
// the traffic goes.
//
// Lifted out of MachinePanel.tsx unchanged. The panel draws it only once
// anything about the network has been read; what it draws, and why the three
// figures are set apart rather than in a row, is below.
import { useState } from "react";

import { pathText } from "../machine-readings";
import type { NetRoute, Network } from "../machine-snapshot";
import { figureText, latencyFigure, rateFigure } from "../net-format";
import AnchoredPopover from "./AnchoredPopover";
import { Fig, OpensHistory } from "./MachineReadout";

/**
 * What the connection is moving, how far Claude is, and — behind one press —
 * which way any of it is going.
 *
 * THREE FIGURES, TWO MEASUREMENTS. Down and up are this machine's own interface
 * counters, every physical wire and radio it has, differenced over five
 * seconds. The third is a TCP handshake with one host: it costs no tokens and
 * sends nothing, and it says nothing about the other two. Set as an even row of
 * three they would read as one connection's three readings, so the latency sits
 * apart at the far edge with the host in its caption, and the disclosure under
 * them says both scopes in words.
 *
 * The figures are set exactly as the load average's are — the number in the
 * weight, its unit and direction in the caption under it — so the two read as
 * one kind of thing. Bytes rather than bits, like the memory above
 * (net-format.ts).
 */
export default function NetworkSection({ network }: { network: Network }) {
  const { down, up, api, route } = network;
  const [details, setDetails] = useState(false);
  const latency = api && api.ms != null ? latencyFigure(api.ms) : null;
  const rates = down != null && up != null;
  return (
    <div className="sd-section" role="group" aria-label="Network">
      <OpensHistory group="network" title="Network history" action="Show network history" label="Network">
        {(rates || latency) && (
          /* THE NAME ON TOP HERE, and under it the value with its unit beside
             it. These three columns are three different measurements, so the
             first thing each needs to say is which one it is — the same order
             the memory rows read in, label then figure. Written the other way
             round the caption had to carry both the unit and the name, and
             "KB/s down" puts the unit where the name belongs. */
          <div className="sd-figs sd-figs-named">
            {rates && ([["Download", down!], ["Upload", up!]] as const).map(([name, v]) => {
              const f = rateFigure(v);
              return <Fig key={name} value={f.value} unit={f.unit} cap={name} />;
            })}
            {latency && <Fig value={latency.value} unit={latency.unit} cap="Claude API" />}
          </div>
        )}
        {/* The first rate needs two readings five seconds apart, and the two
            probes do not land together: a latency that has arrived is drawn
            rather than held back until the counters catch up. */}
        {!rates && <div className="sd-note">measuring…</div>}
        {api && api.ms == null && (
          // The one network state that is a fault rather than a figure stays in
          // the panel, never folded into the disclosure below: a connection
          // that cannot be asked is exactly what somebody opens this to find.
          <div className="sd-note sd-note-warn">Can’t reach Claude</div>
        )}
      </OpensHistory>
      {route && (
        <>
          {/* THE PATH IS BEHIND A PRESS, and it was two lines of sentence under
              the figures before — "Traffic to Claude goes through Tailscale
              exit node …, relayed via fra" — which is worth reading once and
              then occupies the panel forever. What stays outside is the part
              that changes what you should do: a relayed path is slower than the
              same node reached directly, and it is named here in the warning
              colour whether or not anybody opens the detail. */}
          <button
            type="button"
            className="sd-detail"
            id="sd-conn"
            aria-expanded={details}
            aria-haspopup="dialog"
            onClick={() => setDetails(o => !o)}
          >
            Connection details
            {route.relay && <span className="sd-route-relay"> · relayed</span>}
            <i className="sd-row-more" aria-hidden>›</i>
          </button>
          {details && <ConnectionDetails route={route} api={api} onClose={() => setDetails(false)} />}
        </>
      )}
    </div>
  );
}

/**
 * Which way the traffic goes, and what each figure above it was measuring.
 *
 * A popover rather than a dialog: it is four short facts about the row it hangs
 * off, nothing here is a task, and a scrim over the canvas to read a route
 * would be a modal for something that needs neither interruption nor protected
 * focus. AnchoredPopover owns the placement, the Escape, the press-outside and
 * the hand-back of focus to the button; the panel it hangs off is its boundary,
 * so scrolling the route out of view closes it rather than leaving it floating
 * over the canvas.
 *
 * Every row is a reading that exists. A direct line draws no route at all — the
 * server reports one only when the path is not this machine's own — so this is
 * never a surface with "direct" written on it, and it is not rendered at all
 * when there is nothing to disclose.
 */
function ConnectionDetails({ route, api, onClose }: {
  route: NetRoute;
  api: Network["api"];
  onClose: () => void;
}) {
  return (
    <AnchoredPopover
      anchorId="sd-conn"
      boundaryId="system-panel"
      id="sd-conn-pop"
      className="sd-pop"
      role="dialog"
      labelledBy="sd-conn-title"
      onClose={onClose}
    >
      <p className="sd-pop-title" id="sd-conn-title">Connection</p>
      <dl className="sd-pop-rows">
        <div className="sd-pop-row">
          <dt>{route.to === "claude" ? "Traffic to Claude" : "Internet traffic"}</dt>
          <dd>through {pathText(route)}</dd>
        </div>
        {route.relay && (
          <div className="sd-pop-row">
            <dt>Relay</dt>
            <dd>
              <span className="sd-route-relay">{route.relay}</span> — not a direct path, so every packet
              carries one more round trip than it has to
            </dd>
          </div>
        )}
        {api && (
          <div className="sd-pop-row">
            <dt>Round trip</dt>
            <dd>{api.ms == null ? `${api.host} did not answer` : `${figureText(latencyFigure(api.ms))} to open a connection to ${api.host}`}</dd>
          </div>
        )}
        <div className="sd-pop-row">
          <dt>Throughput</dt>
          <dd>every interface on this machine, not this path alone</dd>
        </div>
      </dl>
    </AnchoredPopover>
  );
}
