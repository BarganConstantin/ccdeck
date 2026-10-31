// The stage's hold on the older session hosts (older-hosts.ts): read on
// Windows as the stage opens and each time it moves to another session, and
// the Review dialog's state — open, the End in flight, the sentence it says.
//
// Read again on a move rather than on a timer: a refused launch, the moment a
// reader most needs the line, is always a move (a launch is a subject), and a
// host only changes when someone ends or starts sessions.
import { useEffect, useRef, useState } from "react";
import type { OlderHost } from "../../terminal-api";
import {
  HOSTS_API,
  endHost,
  hostsFingerprint,
  hostsLine,
  readHosts,
  reviewable,
  type HostsApi,
  type HostsView,
} from "./older-hosts";

export interface OlderHosts {
  /** The keys bar's line, or null. */
  line: string | null;
  /** There are sessions to review: the line offers Review. */
  canReview: boolean;
  open: boolean;
  view: HostsView | null;
  /** The generation whose End is in flight. */
  busy: number | null;
  /** The dialog's sentence after a refused End. */
  said: string | null;
  review(): void;
  keep(): void;
  cancel(): void;
  end(host: OlderHost): void;
}

export function useOlderHosts(
  windows: boolean,
  subject: string,
  onAnnounce?: (sentence: string) => void,
  api: HostsApi = HOSTS_API,
): OlderHosts {
  const [view, setView] = useState<HostsView | null>(null);
  const [keptFor, setKeptFor] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const announce = useRef(onAnnounce);
  announce.current = onAnnounce;
  const gone = useRef(false);
  useEffect(() => () => { gone.current = true; }, []);

  useEffect(() => {
    if (!windows) { setView(null); return; }
    let stale = false;
    void readHosts(api).then(v => { if (!stale) setView(v); });
    return () => { stale = true; };
  }, [windows, subject, api]);

  const close = () => { setOpen(false); setSaid(null); };
  const kept = keptFor !== null && keptFor === hostsFingerprint(view);
  return {
    line: hostsLine(view, kept),
    canReview: reviewable(view),
    open: open && reviewable(view),
    view,
    busy,
    said,
    review: () => { setSaid(null); setOpen(true); },
    keep: () => { setKeptFor(hostsFingerprint(view)); close(); },
    cancel: close,
    end: host => {
      if (busy !== null) return;
      setBusy(host.generation);
      setSaid(null);
      void endHost(api, host).then(outcome => {
        if (gone.current) return;
        setBusy(null);
        if (outcome.view !== undefined) setView(outcome.view);
        if (outcome.ended) announce.current?.(`Ended ${outcome.ended === 1 ? "1 session" : `${outcome.ended} sessions`} on an older session host.`);
        if (outcome.view !== undefined && !reviewable(outcome.view)) close();
        else setSaid(outcome.said);
      });
    },
  };
}
