// The English sentences the deck's server hands the Radar UI (traffic-radar-*.mjs),
// by the key the client shows them under. The server sends text, not codes, and
// stays untouched: a sentence it is known to send is shown in the language on
// show, and any other (a tcpdump error, a path, a new message) is shown as it
// arrives, so nothing is ever lost or invented.
import { t as translateNow, type TFunction } from "./i18n";

// Not only the Radar's: any fixed sentence of the deck's server a screen shows
// as it came (the usage lookup's, for one), under the key of the area that owns it.
const EXACT: Record<string, string> = {
  "Settings could not be verified. Try again after they can be read.": "radar.srv.unverified",
  "Controlled by organization or managed settings. Ask your administrator to change this flag.": "radar.srv.managedBlock",
  "Settings could not be verified. No changes were saved.": "radar.srv.unverifiedNoSave",
  "This flag is controlled by organization or managed settings. Ask your administrator to change it.": "radar.srv.managedNoSave",
  "Choose a supported telemetry flag and an On or Off value.": "radar.srv.badFlag",
  "User settings contain an invalid env object. No changes were saved.": "radar.srv.badEnv",
  "Install Wireshark with Npcap to capture traffic. Configuration and file inspection work without it.": "radar.srv.installWireshark",
  "Install tcpdump to capture traffic. Configuration and file inspection work without it.": "radar.srv.installTcpdump",
  "Monitoring setup failed. Retrying automatically.": "radar.srv.setupFailed",
  "Could not complete capture setup. Use a valid IPv4 destination and check its network route.": "radar.srv.captureSetupFailed",
  "Capture session ended or unauthorized.": "radar.srv.captureEnded",
  "Unknown capture action.": "radar.srv.unknownAction",
  "Capture permission is set up for a signed-in user.": "radar.srv.signedInUser",
  "Nobody answered the password prompt.": "radar.srv.noAnswer",
  "No password prompt can open in this session.": "radar.srv.noPrompt",
  "The password was not accepted.": "radar.srv.badPassword",
  "Install Wireshark with Npcap to allow packet capture.": "radar.srv.installNpcap",
  "Choose an IPv4 address and TCP port.": "radar.srv.ipv4",
  "Live capture is available on macOS, Linux and Windows.": "radar.srv.platform",
  "Choose between one and eight destinations.": "radar.srv.destCount",
  "Local ccdeck port unavailable.": "radar.srv.portUnavailable",
  "Network interface unavailable. Check the destination and retry.": "radar.srv.ifaceUnavailable",
  "Monitoring setup was cancelled.": "radar.srv.cancelled",
  "Capture chunk too large.": "radar.srv.chunkLarge",
  "Packet capture permission is required.": "radar.srv.permissionNeeded",
  "Capture disconnected. Retrying automatically.": "radar.srv.disconnected",
  "Capture interface unavailable. Retrying automatically.": "radar.srv.ifaceLost",
  "Npcap interfaces are unavailable. Check that Npcap is installed and its capture permissions allow this user.": "radar.srv.npcapIfaces",
  "Capture tool failed. Check Npcap and capture permissions.": "radar.srv.toolFailed",
  "Capture input interrupted.": "radar.srv.inputInterrupted",
  "Telemetry contents are available on this machine only.": "radar.srv.localOnly",
  "Invalid settings request.": "radar.srv.badRequest",
  "This event is no longer retained.": "radar.srv.eventGone",
  "Request too large.": "radar.srv.tooLarge",
  "Choose a Claude or Codex session and a supported pricing mode.": "insights.srv.badSession",
  "Usage reports are already being read. Try again in a moment.": "insights.srv.busy",
  "Invalid session lookup.": "insights.srv.invalidLookup",
  "Enabled": "radar.val.enabled",
  "Disabled": "radar.val.disabled",
  "Enabled (file destination hidden)": "radar.val.enabledFile",
  "Configured (hidden)": "radar.val.configured",
  "Invalid (value hidden)": "radar.val.invalid",
  "Unknown (value hidden)": "radar.val.unknown",
  "Not set": "radar.val.notSet",
  "User settings": "radar.src.user",
  "Cached organization settings": "radar.src.org",
  "Managed settings": "radar.src.managed",
};

/** A sentence from the server in the language on show; any other text as it came. */
export function serverText(text: string | null | undefined, tr: TFunction = translateNow): string {
  if (!text) return "";
  const key = Object.hasOwn(EXACT, text) ? EXACT[text] : undefined;
  if (key) return tr(key);
  const launch = /^Process launch environment · PID (.+?)(?: and (\d+) more)?$/.exec(text);
  if (launch) return launch[2] ? tr("radar.src.launchMore", { pid: launch[1], n: launch[2] }) : tr("radar.src.launch", { pid: launch[1] });
  const refused = /^macOS refused: (.*)\.$/s.exec(text);
  if (refused) return tr("radar.srv.macRefused", { detail: refused[1] });
  const stopped = /^The setup stopped: (.*)\.$/s.exec(text);
  if (stopped) return tr("radar.srv.setupStopped", { detail: stopped[1] });
  return text;
}
