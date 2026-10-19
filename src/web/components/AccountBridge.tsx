// The tab's settings sync, as a component that draws nothing: App mounts it,
// through React.lazy, only while /api/prefs says the ccdeck account is on, so
// the account's code is a chunk a deck with it off never fetches.
// account-bridge.ts holds the rules; use-account.ts the wiring.
import type { Appliers } from "../account-bridge";
import { useAccountSync } from "../use-account";

export default function AccountBridge({ appliers }: { appliers: Appliers }) {
  useAccountSync(appliers);
  return null;
}
