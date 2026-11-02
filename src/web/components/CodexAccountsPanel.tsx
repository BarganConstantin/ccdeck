import { type ReactNode, useRef } from "react";

import { useT } from "../i18n";
import SheetHandle from "./SheetHandle";
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
  // Shown again by the Claude | Codex switch after being hidden: a phone's
  // sheet does not rise again for it (phone-sheet.css).
  const wasHidden = useRef(false);
  if (side === "hidden") wasHidden.current = true;
  return (
    <aside className={`accounts-panel codex-accounts-panel${leaving ? " leaving" : ""}`} id="codex-accounts-panel" aria-label={t("codex.panel.title")}
      hidden={side === "hidden"} data-side={side} data-switched={wasHidden.current && side !== "hidden" ? "" : undefined}>
      <SheetHandle />
      <CodexProfilesSection onClose={onClose} switcher={switcher} onNotice={onNotice} />
    </aside>
  );
}
