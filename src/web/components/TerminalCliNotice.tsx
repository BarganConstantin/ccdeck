// A separate npm CLI on Windows can lag behind an updated desktop install.
// Show a fix only when the desktop shell identifies the installed npm shim.
import { useEffect, useState } from "react";
import { compareVersions, isVersion } from "../release-notes";
import { SettingRow } from "./SettingsParts";

export interface TerminalCliVersion { version: string; desktopVersion: string }

declare global {
  interface Window {
    ccdeckTerminalCli?: { version: () => Promise<TerminalCliVersion | null> };
  }
}

export function outdatedTerminalCli(info: TerminalCliVersion | null): info is TerminalCliVersion {
  return !!info && isVersion(info.version) && isVersion(info.desktopVersion)
    && compareVersions(info.version, info.desktopVersion) < 0;
}

export function TerminalCliWarningRow({ info }: { info: TerminalCliVersion }) {
  return (
    <SettingRow as="div" name="Terminal CLI"
      note={`The npm CLI on Windows PATH is v${info.version}; the desktop app is v${info.desktopVersion}. Desktop updates do not update the npm CLI.`}
      control={<span className="settings-read">Update needed</span>}>
      <span className="settings-row-said">Run <code>npm install -g ccdeck@latest</code>, then reopen PowerShell and run <code>ccdeck tui</code>.</span>
    </SettingRow>
  );
}

export default function TerminalCliNotice() {
  const [info, setInfo] = useState<TerminalCliVersion | null>(null);
  useEffect(() => {
    let active = true;
    window.ccdeckTerminalCli?.version().then(result => {
      if (active && outdatedTerminalCli(result)) setInfo(result);
    }).catch(() => {}); // Other shells/unknown installations are deliberately silent.
    return () => { active = false; };
  }, []);
  return info ? <TerminalCliWarningRow info={info} /> : null;
}
