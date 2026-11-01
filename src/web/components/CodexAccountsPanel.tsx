import { type ReactNode } from "react";

import { useT } from "../i18n";
import CodexProfilesSection from "./CodexProfilesSection";

/** Codex's side of the Accounts panel, or the whole panel on a deck with only
 *  Codex. It is drawn the way Claude's is (the header, the open default account
 *  with its bars, Other accounts behind one row). */
export default function CodexAccountsPanel({ onClose, leaving, switcher, side, onNotice }: {
  onClose: () => void;
  leaving?: boolean;
  switcher?: ReactNode;
  side?: "shown" | "hidden";
  onNotice?: (needs: boolean) => void;
}) {
  const t = useT();
  return (
    <aside className={`accounts-panel codex-accounts-panel${leaving ? " leaving" : ""}`} id="codex-accounts-panel" aria-label={t("codex.panel.title")}
      hidden={side === "hidden"} data-side={side}>
      <CodexProfilesSection onClose={onClose} switcher={switcher} onNotice={onNotice} />
    </aside>
  );
}
