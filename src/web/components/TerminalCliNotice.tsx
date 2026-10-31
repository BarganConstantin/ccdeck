// The ccdeck a terminal on this machine starts, in About, when it is older than
// this deck (/api/version's terminalCli, src/server/terminal-cli.mjs). The app,
// an npx run and a global npm install update separately, so a terminal can be
// left behind on any platform. Where it can, the deck replaces that copy itself
// (terminal-cli-update.mjs), and the row says so rather than asking.
import { PRODUCT } from "../brand";
import type { TerminalCli } from "../use-version-check";
import { useT } from "../i18n";
import { slot } from "./Slot";
import { SettingRow } from "./SettingsParts";

export default function TerminalCliNotice({ cli, running }: { cli: TerminalCli; running: string }) {
  const t = useT();
  const versions = t("shell.terminal.versions", { product: PRODUCT, cli: cli.version, running });
  const run = <code>{cli.command}</code>;
  if (cli.auto === "pending" || cli.auto === "running") {
    return (
      <SettingRow as="div" name={t("shell.terminal.name")} note={versions}
        control={<span className="settings-read">{cli.auto === "running" ? t("shell.terminal.updating") : t("shell.terminal.updatingSoon")}</span>}>
        <span className="settings-row-said">
          {cli.auto === "running" ? t("shell.terminal.updatingNow") : slot(t("shell.terminal.soon"), "cmd", run)}
        </span>
      </SettingRow>
    );
  }
  return (
    <SettingRow as="div" name={t("shell.terminal.name")}
      note={cli.auto === "failed" ? versions : t("shell.terminal.notUpdated", { versions })}
      control={<span className="settings-read">{t("shell.terminal.needed")}</span>}>
      <span className="settings-row-said">
        {cli.auto === "failed" && <>{cli.error ? t("shell.terminal.failedWith", { error: cli.error }) : t("shell.terminal.failed")} </>}
        {slot(t("shell.terminal.run"), "cmd", run)}
      </span>
    </SettingRow>
  );
}
