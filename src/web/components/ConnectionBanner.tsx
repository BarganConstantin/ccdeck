// The banner that says the stream from the server is gone: either a restart
// this deck asked for is under way, or the connection dropped by itself.
//
// Moved out of App.tsx's markup unchanged. DeckBanner.tsx decides WHICH banner
// the strip under the topbar shows (a finished restart, then this, then the
// version notice, then the old-name notice); this file is only what this one
// says.
import { PRODUCT } from "../brand";
import { UnreachableGlyph } from "./action-glyphs";
import BannerMark from "./BannerMark";
import { outageSentence } from "../status-pill";
import type { useAutoRestart } from "../use-auto-restart";
import { useT } from "../i18n";

type Restart = ReturnType<typeof useAutoRestart>;

/** The phone's words for a dropped connection (Figma, "Can't reach your computer"):
 *  honest that the link dropped, not that the agents stopped. The apostrophe is
 *  the curly one the frame draws. The sentence names the last news when the
 *  page heard any (use-event-stream.ts), and says it plainly when it never did. */
export const UNREACHABLE_TITLE = "Can\u2019t reach your computer";
export const UNREACHABLE_SUB = "Agents may still be running, so what you see may be old.";

/** The last news as a clock time, 24-hour like the frame's "14:02". */
export function lastNewsTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** The card's second line: the last news named when there is one. */
export function unreachableSub(lastNewsAt: number | null | undefined): string {
  if (lastNewsAt == null) return UNREACHABLE_SUB;
  return `Agents may still be running. Last news ${lastNewsTime(lastNewsAt)}, so what you see may be old.`;
}

/** The "Can't reach your computer" card: the phone's dropped connection. Inside
 *  the Sessions panel when it is up (SessionList's `offline`), else under the
 *  top bar (DeckBanner). */
export function OfflineCard({ lastNewsAt }: { lastNewsAt?: number | null }) {
  return (
    <div className="conn-banner conn-banner-phone" role="alert">
      <span className="conn-unreachable"><UnreachableGlyph /></span>
      <span className="conn-phone-text">
        <span className="conn-phone-title">{UNREACHABLE_TITLE}</span>
        <span className="conn-phone-sub">{unreachableSub(lastNewsAt)}</span>
      </span>
    </div>
  );
}

export default function ConnectionBanner({ restarting, restartMode, live, paused, phone = false, lastNewsAt = null }: {
  restarting: Restart["restarting"];
  restartMode: Restart["restartMode"];
  /** Whether the event stream is connected right now. */
  live: boolean;
  /** Whether the canvas is paused, which the outage sentence pairs with the drop. */
  paused: boolean;
  /** 640px and under: the lost connection reads as the phone frame does. A
   *  restart the deck asked for keeps its own sentence at every width. */
  phone?: boolean;
  /** When the stream last had news, for the phone's card. */
  lastNewsAt?: number | null;
}) {
  const t = useT();
  if (phone && !restarting) return <OfflineCard lastNewsAt={lastNewsAt} />;
  return (
    <div className="conn-banner" role="alert">
      <BannerMark glyph="unreachable" tone="err" />
      {restarting
        ? restartMode === "npx"
          ? t("shell.banner.fetchingNpx")
          : t("shell.banner.restartingProduct", { product: PRODUCT })
        : (() => {
            // The one sentence on this page that was reachable by mouse and
            // by nothing else (#510). It lived in the title of the status
            // pill, on a non-focusable span that Chrome reports as
            // role=generic name="" description="SSE disconnected" — a
            // description with no name to hang off, which screen readers do
            // not reliably announce and no keyboard can go and ask for.
            // It arrives here rather than on a focusable pill because this
            // banner already owns the announcement path for exactly this
            // condition: it is a role="alert", it fires the moment the
            // stream dies, and unlike the version banner beside it it has
            // no dismiss control, so it is on screen for precisely as long
            // as the thing it describes. That is the property the pill was
            // being kept for, and the banner already had it.
            // Nothing is added while the canvas is running: the sentence
            // above already says the connection is gone. What was missing
            // is what the two states mean together.
            const outage = outageSentence({ connected: live, paused });
            return (
              <>
                {t("shell.banner.lost", { product: PRODUCT })}
                {outage && <span className="conn-sub">{outage}</span>}
              </>
            );
          })()}
    </div>
  );
}
