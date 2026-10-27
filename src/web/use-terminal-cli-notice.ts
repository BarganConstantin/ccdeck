// Saying, once per terminal version, that the ccdeck a terminal here starts is
// older than this deck.
//
// The old command cannot be told: it reads `ccdeck tui` as an unknown option,
// opens this page and sends the deck nothing. This page is where that person
// lands, so it says what to run (/api/version's terminalCli, from
// src/server/terminal-cli.mjs). In the shape of the old-name notice: nothing is
// broken in the deck, so it is a dismissible line, not an alarm.
import { useCallback, useState } from "react";

import { copyText } from "./copy-text";
import { isVersion } from "./release-notes";
import { readStored, writeStored } from "./storage";
import type { TerminalCli, VersionInfo } from "./use-version-check";

// The terminal version the notice was dismissed for, not a boolean: a terminal
// still on that version has been told, and a different old one has not.
const TERMINAL_CLI_DISMISSED_KEY = "agent-dag.terminalCliNoticeDismissed";

export interface TerminalCliState {
  terminalCli: TerminalCli | null;
  terminalCliOpen: boolean;
  dismissTerminalCli: () => void;
  copyTerminalCli: () => void;
  terminalCliCopied: boolean;
}

export function useTerminalCliNotice(version: VersionInfo | null): TerminalCliState {
  const [dismissed, setDismissed] = useState<string>(() => readStored(TERMINAL_CLI_DISMISSED_KEY) ?? "");
  const [copied, setCopied] = useState(false);
  const found = version?.terminalCli;
  const terminalCli = found && isVersion(found.version) && typeof found.command === "string" && found.command
    ? found : null;
  const terminalCliOpen = terminalCli != null && dismissed !== terminalCli.version;
  // Keyed on the strings: /api/version answers with a fresh object every poll.
  const cliVersion = terminalCli?.version;
  const dismissTerminalCli = useCallback(() => {
    if (!cliVersion) return;
    setDismissed(cliVersion);
    writeStored(TERMINAL_CLI_DISMISSED_KEY, cliVersion);
  }, [cliVersion]);
  const command = terminalCli?.command;
  const copyTerminalCli = useCallback(async () => {
    if (!command || !(await copyText(command))) return; // the command stays on screen and selectable
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [command]);

  return { terminalCli, terminalCliOpen, dismissTerminalCli, copyTerminalCli, terminalCliCopied: copied };
}
