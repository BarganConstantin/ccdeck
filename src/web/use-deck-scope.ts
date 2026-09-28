// What this deck is allowed to see, as its server reports it: the workspace it
// was scoped to, and which CLIs it watches.
//
// Lifted out of App.tsx's `Inner`, where it sat under a banner about release
// notes it has nothing to do with. One fetch of /api/health answers both, and it
// is re-asked whenever the event stream reconnects, because that is the far end
// of a restart — the only point either answer can have changed.
//
// Both setters are private now. Nothing outside this hook ever wrote either
// value; now nothing can.
import { useEffect, useState, type MutableRefObject } from "react";

import { ASSUMED, readProviders, type Providers } from "./providers";
import { useMirroredRef } from "./use-mirrored-ref";

export interface DeckScope {
  /** "" for machine-wide, a path under --workspace/--scope, null until known. */
  workspace: string | null;
  providers: Providers;
  /** For the keydown handler, which is bound once and must see today's answer. */
  providersRef: MutableRefObject<Providers>;
}

/** @param live Whether the event stream is connected; a reconnect re-asks. */
export function useDeckScope(live: boolean): DeckScope {
  // Which sessions this deck is even allowed to see — "" for machine-wide, a
  // path when it was started with --workspace/--scope. Null until health
  // answers, and null forever against a server too old to report it; the empty
  // state says nothing about scope in that case rather than guessing, which is
  // how it came to claim a dead `--all` flag in the first place. Re-asked when
  // the stream reconnects, because that is the far end of a restart and the
  // only point the answer can have changed.
  const [workspace, setWorkspace] = useState<string | null>(null);
  // Which CLIs this deck watches, from the same request. Claude-only surfaces
  // are drawn only when Claude Code is here and Codex-only surfaces only when
  // Codex is — see providers.ts, which also owns what to believe when the
  // server does not say. Re-asked on reconnect with the scope, because a
  // restart is exactly when --no-claude or a newly installed CLI takes effect.
  const [providers, setProviders] = useState<Providers>(ASSUMED);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (cancelled) return;
        // Read before the workspace guard below, not after: `workspace` is a
        // separate field with its own reason to be missing, and letting it
        // decide whether providers are read would hide the panels of anyone
        // whose deck reports one and not the other.
        setProviders(readProviders(d));
        if (!d || typeof d.workspace !== "string") return;
        setWorkspace(d.workspace);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [live]);
  // The keydown handler below is bound once and reads its world through refs;
  // `A` has to see today's answer rather than the one that shipped with the
  // first render, when nothing had come back from /api/health yet.
  const providersRef = useMirroredRef(providers);

  return { workspace, providers, providersRef };
}
