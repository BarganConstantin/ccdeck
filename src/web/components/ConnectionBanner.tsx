// The banner that says the stream from the server is gone: either a restart
// this deck asked for is under way, or the connection dropped by itself.
//
// Moved out of App.tsx's markup unchanged. DeckBanner.tsx decides WHICH banner
// the strip under the topbar shows (a finished restart, then this, then the
// version notice, then the old-name notice); this file is only what this one
// says.
import { PRODUCT } from "../brand";
import { outageSentence } from "../status-pill";
import type { useAutoRestart } from "../use-auto-restart";

type Restart = ReturnType<typeof useAutoRestart>;

export default function ConnectionBanner({ restarting, restartMode, live, paused }: {
  restarting: Restart["restarting"];
  restartMode: Restart["restartMode"];
  /** Whether the event stream is connected right now. */
  live: boolean;
  /** Whether the canvas is paused, which the outage sentence pairs with the drop. */
  paused: boolean;
}) {
  return (
    <div className="conn-banner" role="alert">
      <span className="conn-dot" />
      {restarting
        ? restartMode === "npx"
          ? "Fetching the new version with npx — this can take a minute…"
          : `Restarting ${PRODUCT}…`
        : (() => {
            // The one sentence on this page that was reachable by mouse and
            // by nothing else (#510). It lived in the title of the status
            // pill, on a non-focusable span that Chrome reports as
            // role=generic name="" description="SSE disconnected" — a
            // description with no name to hang off, which screen readers do
            // not reliably announce and no keyboard can go and ask for.
            // It arrives here rather than on a focusable pill because this
            // banner already owns the announcement path for exactly this
            // condition: it is a role="alert", it fires the moment the
            // stream dies, and unlike the version banner beside it it has
            // no dismiss control, so it is on screen for precisely as long
            // as the thing it describes. That is the property the pill was
            // being kept for, and the banner already had it.
            // Nothing is added while the canvas is running: the sentence
            // above already says the connection is gone. What was missing
            // is what the two states mean together.
            const outage = outageSentence({ connected: live, paused });
            return (
              <>
                {`Lost connection to the ${PRODUCT} server. Reconnecting…`}
                {outage && <span className="conn-sub">{outage}</span>}
              </>
            );
          })()}
    </div>
  );
}
