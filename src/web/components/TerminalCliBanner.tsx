// The notice for a terminal whose ccdeck is older than this deck, and the line
// that updates it. DeckBanner.tsx decides when the strip shows it; the
// dismissal and the copy are use-terminal-cli-notice's. The row spans the
// window and the docked panels start under it (terminal-cli-banner.css), so
// nothing covers the command or the ×. Settings › About says the rest.
import { PRODUCT } from "../brand";
import { useRowHeight } from "../use-row-height";
import type { TerminalCliState } from "../use-terminal-cli-notice";
import type { TerminalCli } from "../use-version-check";

export default function TerminalCliBanner({ cli, notice }: {
  cli: TerminalCli;
  notice: Pick<TerminalCliState, "dismissTerminalCli" | "copyTerminalCli" | "terminalCliCopied">;
}) {
  const rowRef = useRowHeight("--cli-banner-h", cli.version);
  return (
    <div ref={rowRef} className="ver-banner cli-banner" role="status">
      <span className="ver-dot" />
      <strong>Your terminal's {PRODUCT} is out of date (v{cli.version}).</strong>
      <button type="button" className="ver-cmd" onClick={notice.copyTerminalCli} title="Copy to clipboard">
        <code>{cli.command}</code>
        <span className="ver-cmd-hint">{notice.terminalCliCopied ? "copied" : "copy"}</span>
      </button>
      <button type="button" aria-label="Dismiss" className="ver-close" onClick={notice.dismissTerminalCli}>×</button>
    </div>
  );
}
