// The tab's settings sync, as a component that draws nothing: App mounts it,
// through React.lazy, only while /api/prefs says the ccdeck account is on, so
// the account's code is a chunk a deck with it off never fetches.
// account-bridge.ts holds the rules; use-account.ts the wiring.
//
// It is also how the feedback doors hear about the account: whenever the view
// changes it publishes who a send would go as and what is unread to
// feedback-unread.ts, in the main bundle, for the Feedback button's dot and the
// dialog's tabs — and null when it goes, so nothing is left lit.
import { useEffect } from "react";
import { feedbackAccountOf, type Appliers } from "../account-bridge";
import { publishFeedbackAccount } from "../feedback-unread";
import { useAccountSync, useAccountView } from "../use-account";

export default function AccountBridge({ appliers }: { appliers: Appliers }) {
  useAccountSync(appliers);
  const { view } = useAccountView();
  useEffect(() => { publishFeedbackAccount(feedbackAccountOf(view)); }, [view]);
  useEffect(() => () => publishFeedbackAccount(null), []);
  return null;
}
