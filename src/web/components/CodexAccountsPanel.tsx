import CodexProfilesSection from "./CodexProfilesSection";

/** Codex's own column beside Claude's. The two stay separate while Codex's
 *  account controls settle; the rail gives each its own button, and this one is
 *  drawn the way Claude's is (the header, the open default account with its
 *  bars, Other accounts behind one row). */
export default function CodexAccountsPanel({ onClose, leaving }: { onClose: () => void; leaving?: boolean }) {
  return (
    <aside className={`accounts-panel codex-accounts-panel${leaving ? " leaving" : ""}`} id="codex-accounts-panel" aria-label="Codex accounts">
      <CodexProfilesSection onClose={onClose} />
    </aside>
  );
}
