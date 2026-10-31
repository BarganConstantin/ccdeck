import CodexProfilesSection from "./CodexProfilesSection";

/** Codex's own column beside Claude's. The two stay separate while Codex's
 *  account controls settle; the rail gives each its own button. The + that adds
 *  an account and the ⋯ for terminal selection are the section's, on its first
 *  row, so this header holds only the name and the close. */
export default function CodexAccountsPanel({ onClose, leaving }: { onClose: () => void; leaving?: boolean }) {
  return (
    <aside className={`accounts-panel codex-accounts-panel${leaving ? " leaving" : ""}`} id="codex-accounts-panel" aria-label="Codex accounts">
      <div className="ap-header">
        <h2>Codex accounts</h2>
        <div className="ap-header-right">
          <button type="button" className="glyph-btn" aria-label="Close Codex accounts" onClick={onClose}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
              <path d="m3.5 3.5 7 7m0-7-7 7" />
            </svg>
          </button>
        </div>
      </div>
      <div className="ap-scroll"><CodexProfilesSection standalone /></div>
    </aside>
  );
}
