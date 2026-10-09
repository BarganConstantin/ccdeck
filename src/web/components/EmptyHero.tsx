// What the canvas says while it has nothing to draw.
//
// Moved out of App.tsx, where both sat after `Inner` as module-level
// components: the hero for an empty board, which says why it is empty and what
// would fill it, and the one for a tab the browser is holding behind other deck
// tabs (#830). App.tsx picks between them.
import { useEffect, useState } from "react";
import { PRODUCT } from "../brand";
import { captureHints } from "../provider-copy";
import type { Providers } from "../providers";
import { emptyScope } from "../scope";
import FilmLink from "./FilmLink";

function TerminalSymbol({ active = false }: { active?: boolean }) {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return <div className="empty-symbol" aria-hidden="true" data-active={active && visible}>
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 8 4 4-4 4" /><path className="empty-cursor" d="M13 16h5" /></svg>
  </div>;
}

/** The hero for a tab whose stream is queued behind other deck tabs' streams
 *  (#830). Not the server: the server is fine, and the other deck tabs in this
 *  browser are live. Said as what to do, because the browser connects this tab
 *  the moment one of the others closes. */
export function TabCapHero({ reservedRight = 0 }: { reservedRight?: number }) {
  return (
    <div className="empty-stage" style={{ right: reservedRight }}><div className="empty-hero">
      <TerminalSymbol />
      <h2>Too many {PRODUCT} tabs are open</h2>
      <p>
        This browser keeps at most six live connections to one address, and
        other <code>{PRODUCT}</code> tabs are holding them. Close one and this
        tab connects on its own.
      </p>
    </div></div>
  );
}

export function EmptyHero({ live, everConnected, providers, workspace, onTour, reservedRight = 0 }: {
  live: boolean; everConnected: boolean; providers: Providers; workspace: string | null;
  onTour: () => void; reservedRight?: number;
}) {
  const offline = !live;
  return (
    <div className="empty-stage" style={{ right: reservedRight }}><div className="empty-hero">
      <TerminalSymbol active={live} />
      {offline ? (
        <>
          <h2>{everConnected ? "Disconnected from server" : "Server unreachable"}</h2>
          {/* In the reader's words, not the route's (#832): `/events` is the
              stream's endpoint and means nothing to somebody who typed
              `npx ccdeck`. What they need is which of the two happened and
              where to look. */}
          <p>
            {everConnected ? "This page lost its connection to " : "This page cannot reach "}
            <code>{PRODUCT}</code>. Check that it is still running in your terminal —
            the page picks up again on its own.
          </p>
        </>
      ) : agentNoneCopy(providers, workspace)}
      {/* THE WAY BACK TO THE TOUR, on the one screen a person who has not yet
          seen anything is looking at. It is a control on a hero that is
          pointer-transparent by design (a drag starting here still pans), so
          the sheet gives this one element its pointer back. Offline, the hero
          is about the server, and the tour would be a promise about a canvas
          that cannot fill. */}
      {!offline && (
        <button type="button" className="btn empty-tour" onClick={onTour}>Take the tour</button>
      )}
      {!offline && <FilmLink film="tour" />}
    </div></div>
  );
}

function agentNoneCopy(providers: Providers, workspace: string | null) {
  // THE SCOPE SENTENCE BELONGS HERE, not only in the detail rail (#802). This
  // hero said "run it in any folder" whatever the deck was watching, and the
  // one user for whom the canvas stays empty is exactly the one who started it
  // with --scope or --workspace and then ran an agent outside that tree. They
  // were told to do the thing that will not work, and then sent to inspect
  // ~/.claude/settings.json and $CODEX_HOME for a filter they had set
  // themselves. scope.ts's own header says it exists because "the one piece of
  // text that appears when nothing shows up told that user scope could not be
  // the cause" — and it still did, for anyone who had not opened the rail,
  // which is closed on a fresh install.
  const scope = emptyScope(workspace);
  return (
    <>
      <h2>Waiting for Claude Code or Codex</h2>
      {scope.kind === "scoped" ? (
        <p>
          {scope.lead} <code>{scope.workspace}</code>{scope.tail}
        </p>
      ) : (
        <p>
          Run <code>claude</code> or <code>codex</code> in any folder. As soon as
          a session sends an event, a node appears here and grows as subagents
          fork and tools are called.
        </p>
      )}
      {/* This used to be one sentence for both CLIs, and it sent Codex users to
          install `~/.codex/hooks.json` and grant it `/hooks` trust — work the
          deck stopped doing before it ever shipped, on a file it opens only to
          uninstall (#404). One line per capture path now, each naming what that
          path really depends on, and each able to say the deck is not watching
          that CLI at all. The words live in provider-copy.ts so the branches can
          be tested without a DOM. */}
      {/* No "make sure ccdeck is running" line (#831). This copy renders only
          while the stream is live — the offline branch has its own words — so
          it told a connected reader to check the one thing the page already
          knew. What can really keep the canvas empty is a capture path, and
          each of those says so below. */}
      <details className="empty-help"><summary>Session not showing up?</summary>
      {captureHints(providers).map(hint => (
        <p className="hint-row" key={hint.provider}>
          {hint.spans.map((span, i) =>
            span.code
              ? <code key={i}>{span.text}</code>
              : <span key={i}>{span.text}</span>,
          )}
        </p>
      ))}</details>
    </>
  );
}
