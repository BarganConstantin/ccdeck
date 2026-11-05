// A write the deck could not confirm, in any integration panel: the waiting
// glyph, one sentence a screen reader hears at once, and the way out beside
// it (styles in integrations.css, .ig-write-band).
//
//   <IntegrationWriteBand message>{<button …/>}</IntegrationWriteBand>
import type { ReactNode } from "react";
import { KitStateGlyph } from "./kit-icons";

export default function IntegrationWriteBand({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="ig-write-band" data-tone="uncertain">
      <KitStateGlyph name="waiting" />
      <p role="alert">{message}</p>
      {children ? <div className="ig-write-band-actions">{children}</div> : null}
    </div>
  );
}
