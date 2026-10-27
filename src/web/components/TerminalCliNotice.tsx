// The ccdeck a terminal on this machine starts, in About, when it is older than
// this deck (/api/version's terminalCli, src/server/terminal-cli.mjs). The app,
// an npx run and a global npm install update separately, so a terminal can be
// left behind on any platform.
import { PRODUCT } from "../brand";
import type { TerminalCli } from "../use-version-check";
import { SettingRow } from "./SettingsParts";

export default function TerminalCliNotice({ cli, running }: { cli: TerminalCli; running: string }) {
  return (
    <SettingRow as="div" name="Terminal command"
      note={`The ${PRODUCT} your terminal starts is v${cli.version}; this deck is v${running}. Updating the app or the deck does not update it.`}
      control={<span className="settings-read">Update needed</span>}>
      <span className="settings-row-said">Run <code>{cli.command}</code>, then open a new terminal.</span>
    </SettingRow>
  );
}
