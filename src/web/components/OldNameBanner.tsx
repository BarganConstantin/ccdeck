// The notice for a deck started under a name it no longer goes by, and the
// sentence the terminal prints for moving onto the new one.
//
// Moved out of App.tsx's markup unchanged. App.tsx still decides WHICH banner
// the strip under the topbar shows, and this one comes last; the name and its
// dismissal are use-old-name-notice's.
import { PRODUCT } from "../brand";
import type { OldNameNotice } from "../use-old-name-notice";
import type { VersionInfo } from "../use-version-check";

export default function OldNameBanner({ oldName, version, dismissOldName }: {
  /** The name this deck was started under; the caller shows this only when there is one. */
  oldName: string;
  version: VersionInfo | null;
  dismissOldName: OldNameNotice["dismissOldName"];
}) {
  return (
    <div className="ver-banner" role="status">
      <span className="ver-dot" />
      <strong>{oldName} still works — the deck is called {PRODUCT} now.</strong>
      {/* The half people do not expect, and the half this must not get
          wrong: a global install already put a ccdeck on the PATH — the
          same install ships all three commands — so there is nothing to
          fetch and nothing to uninstall, only a different word to type,
          while under npx there is no such install and `npx ccdeck` is the
          whole answer. Telling the second group the first line sends them
          to a `command not found`.

          So it is not decided here. This branch used to read
          `upgradeMode === "npx"`, which sounds like the same question and
          is a different one — it says whether an in-app `npm i -g` is
          allowed, and `AGENTS_DECK_NO_INSTALL=1` makes it null for npx runs
          too, at which point every npx user who opted out of installs got
          the global-install line (#363). The server sends the sentence the
          terminal prints, from the same function, and no string here can
          drift from it. Rendered only when it is there: a missing field is
          a server that could not say, and silence beats a guess. */}
      {version?.renameFix ? <span className="ver-sub">{version.renameFix}</span> : null}
      <button type="button" aria-label="Dismiss" className="ver-close" onClick={dismissOldName}>×</button>
    </div>
  );
}
