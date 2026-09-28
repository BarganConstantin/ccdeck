// Reading the tailnet on a timer while discovery over it is switched on, lifted
// out of createEngine in lan-engine.mjs with the two variables only it used.
// The reader itself — spawning the CLI, keeping its last answer — is
// createTailnet in tailscale.mjs; this is only WHEN the engine asks it.
import { TAILNET_MS } from "./tailscale.mjs";

/**
 * `tailnet` is the engine's reader, or null on a deck that has none.
 * `beaconNow` answers the engine's beacon as it is at the moment of asking —
 * null while it is down, and a different one after a restart — and `wanted`
 * whether the settings in force ask for the tailnet at all.
 */
export function createTailnetPoll({ tailnet, beaconNow, wanted }) {
  /** The tailnet read's own timer, running only while the switch is on. */
  let tailTimer = null;
  // An in-flight refresh may finish after discovery is disabled or restarted.
  let tailRefreshGeneration = 0;

  /**
   * Read the tailnet on a timer while the switch is on, and not at all while it
   * is off — the read at start covers telling a tailnet address from a local
   * one, and the dialog's own poll covers whether Tailscale is there at all.
   *
   * TURNING IT ON ANNOUNCES AT ONCE, after one read, so the owner's machines
   * hear about this one in the second after the press rather than on the next
   * beacon, up to half a minute later.
   */
  const sync = () => {
    const beacon = beaconNow();
    const want = !!(beacon && tailnet && wanted());
    if (want && !tailTimer) {
      const startedIn = ++tailRefreshGeneration;
      const currentBeacon = beacon;
      void tailnet.refresh().then(() => {
        if (startedIn === tailRefreshGeneration && beaconNow() === currentBeacon && wanted()) {
          currentBeacon.announce();
        }
      }, () => {});
      tailTimer = setInterval(() => { void tailnet.refresh(); }, TAILNET_MS);
      tailTimer.unref?.();
    } else if (!want && tailTimer) {
      tailRefreshGeneration++;
      clearInterval(tailTimer);
      tailTimer = null;
    }
  };

  /** Stop reading, and make a read still in flight announce nothing when it
   *  lands: the listener it would announce is gone. */
  const stop = () => {
    tailRefreshGeneration++;
    if (tailTimer) clearInterval(tailTimer);
    tailTimer = null;
  };

  return { sync, stop };
}
