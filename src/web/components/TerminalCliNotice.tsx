// The ccdeck a terminal on this machine starts, in About, when it is older than
// this deck (/api/version's terminalCli, src/server/terminal-cli.mjs). The app,
// an npx run and a global npm install update separately, so a terminal can be
// left behind on any platform. Where it can, the deck replaces that copy itself
// (terminal-cli-update.mjs), and the row says so rather than asking.
import { PRODUCT } from "../brand";
import type { TerminalCli } from "../use-version-check";
import { SettingRow } from "./SettingsParts";

export default function TerminalCliNotice({ cli, running }: { cli: TerminalCli; running: string }) {
  const versions = `The ${PRODUCT} your terminal starts is v${cli.version}; this deck is v${running}.`;
  const run = <code>{cli.command}</code>;
  if (cli.auto === "pending" || cli.auto === "running") {
    return (
      <SettingRow as="div" name="Terminal command" note={versions}
        control={<span className="settings-read">{cli.auto === "running" ? "Updating…" : "Updating soon"}</span>}>
        <span className="settings-row-said">
          {cli.auto === "running" ? "The deck is updating it now." : <>The deck updates it within a few minutes. To do it now, run {run}.</>}
        </span>
      </SettingRow>
    );
  }
  return (
    <SettingRow as="div" name="Terminal command"
      note={cli.auto === "failed" ? versions : `${versions} Updating the app or the deck does not update it.`}
      control={<span className="settings-read">Update needed</span>}>
      <span className="settings-row-said">
        {cli.auto === "failed" && <>The deck could not update it{cli.error ? ` (${cli.error})` : ""}. </>}
        Run {run}, then open a new terminal.
      </span>
    </SettingRow>
  );
}
