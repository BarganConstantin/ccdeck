// The engine's install as one card sees it: the deck's status, read again
// while an install runs, the job this tab started, and the one screen the card
// shows for all of that (engineView). The Term pane's card and the Settings
// rows both use it.
//
// ONE INSTALL, MANY TABS. The deck runs one install at a time and every tab
// reads it (engine-install.mjs). The id of the job this tab started is kept
// for the tab's life (sessionStorage, so a reload is still this tab), and a
// job with another id is "installing in another tab", mirrored with its bytes.
//
// A FAILURE IS SHOWN ONLY TO WHO SAW IT. The deck keeps the last outcome; a
// card shows it only for a job it watched, so an old failure from yesterday's
// tab is not today's first screen.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelEngineInstall, engineStatus, installEngine, installEngineFile, olderVersion, removeEngine,
  type EngineFailureCode, type EngineJob, type EngineStatus,
} from "./engine-install-api";

/** How often the status is read while this tab's install runs, and while
 *  another tab's or deck's does. */
export const POLL_MS = 400;
export const POLL_ELSEWHERE_MS = 1500;
/** How often an install that stopped offline is tried again while the card
 *  is open. The deck's machine downloads, not the browser, so the browser's
 *  own online event is a hint at most. */
export const OFFLINE_RETRY_MS = 15_000;
/** The window the speed is measured over. */
const SPEED_WINDOW_MS = 3_000;

const JOB_KEY = "ccdeck.engineInstall.job";

function readJob(): string | null {
  try { return sessionStorage.getItem(JOB_KEY); } catch { return null; }
}
function writeJob(id: string | null) {
  try {
    if (id) sessionStorage.setItem(JOB_KEY, id);
    else sessionStorage.removeItem(JOB_KEY);
  } catch { /* storage refused: the id lives in memory only */ }
}

/** The one screen the card shows. */
export type EngineView =
  | { state: "checking" }
  /** The deck could not say: the stage's own error card stands instead. */
  | { state: "plain" }
  | { state: "ask"; download: boolean; file: boolean; downloadOff: boolean }
  | { state: "downloading"; job: EngineJob }
  | { state: "verifying"; job: EngineJob }
  | { state: "ready"; version: string | null }
  | { state: "offline"; received: number; total: number | null }
  | { state: "permission"; fixPath: string | null }
  | { state: "unsupported" }
  | { state: "unavailable"; file: boolean }
  | { state: "check"; code: "check-failed" | "wrong-machine" | "downgrade"; step: string }
  | { state: "update"; installed: string; pinned: string; download: boolean; file: boolean }
  | { state: "elsewhere"; job: EngineJob | null }
  | { state: "recovered"; version: string }
  | { state: "start-failed" }
  | { state: "no-space" }
  | { state: "failed"; step: string };

export interface ViewInput {
  /** undefined while the first read is on its way; null when the deck cannot say. */
  status: EngineStatus | null | undefined;
  /** The engine's refusal that brought the card up (terminal-api's PANEL_UNAVAILABLE). */
  code?: string | null;
  /** The job this tab started. */
  mine: string | null;
  /** Every job this card has seen run, to show their outcomes and no older one. */
  watched: ReadonlySet<string>;
  /** The card has already asked the stage to try again once for an engine
   *  that verifies: a second refusal is a start that failed. */
  retried?: boolean;
}

const CHECK_CODES = new Set(["check-failed", "wrong-machine", "downgrade"]);

/** Which screen, from the deck's status and what this card has seen. */
export function engineView({ status, code, mine, watched, retried = false }: ViewInput): EngineView {
  if (status === undefined) return { state: "checking" };
  if (status === null) return { state: "plain" };
  const { job, last } = status;
  if (job) {
    if (job.id !== mine) return { state: "elsewhere", job };
    return job.phase === "downloading" ? { state: "downloading", job } : { state: "verifying", job };
  }
  if (status.elsewhere) return { state: "elsewhere", job: null };
  if (last && watched.has(last.id)) {
    // Installed and asked again once already: refused once more, it is the
    // start that fails, not the install.
    if (last.outcome === "done") return retried ? { state: "start-failed" } : { state: "ready", version: last.version };
    if (last.outcome === "failed") {
      const failure: EngineFailureCode = last.code;
      if (failure === "offline") return { state: "offline", received: last.received ?? 0, total: last.total ?? null };
      if (failure === "no-permission") return { state: "permission", fixPath: status.fixPath };
      if (CHECK_CODES.has(failure)) return { state: "check", code: failure as "check-failed", step: last.step };
      if (failure === "no-space") return { state: "no-space" };
      if (failure === "not-published") return { state: "unavailable", file: status.canInstallFile };
      if (failure === "elsewhere") return { state: "elsewhere", job: null };
      return { state: "failed", step: last.step };
    }
  }
  if (!status.supported || code === "unsupported") return { state: "unsupported" };
  const download = status.blocked === null;
  const file = status.canInstallFile;
  if (status.installed) {
    if (status.recovered) return { state: "recovered", version: status.installed.version };
    if (code === "failed" || retried) return { state: "start-failed" };
    if (status.pinned && olderVersion(status.installed.version, status.pinned)) {
      return { state: "update", installed: status.installed.version, pinned: status.pinned, download, file };
    }
    // Here and verified, though the stage was refused: installed a moment
    // ago, by another tab or deck. The stage asks again.
    return { state: "ready", version: status.installed.version };
  }
  if (status.blocked === "no-keys" || status.blocked === "not-published" || status.blocked === "unsupported") {
    return { state: "unavailable", file };
  }
  return { state: "ask", download, file, downloadOff: status.blocked === "download-disabled" };
}

/** Runs `fire` once, `ms` after `active` turns on, if it stays on. `fire` is
 *  read when the time is out: the stage hands the card a new onRetry with
 *  every render and the status is read every POLL_MS, so as a dependency it
 *  restarted the hold before it ran out, and a ready card said "Starting your
 *  terminal…" forever (found in the browser pass). */
export function useHoldThen(active: boolean, ms: number, fire: () => void): void {
  const latest = useRef(fire);
  useEffect(() => { latest.current = fire; });
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => latest.current(), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
}

/** Bytes a second over the last few seconds, from the samples a card took. */
export function speedOf(samples: readonly { at: number; received: number }[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.at - first.at;
  if (span < 500) return null;
  return Math.max(0, (last.received - first.received) / (span / 1000));
}

export interface EngineInstall {
  status: EngineStatus | null | undefined;
  mine: string | null;
  watched: ReadonlySet<string>;
  /** Bytes a second while this tab's download runs, once it can say. */
  speed: number | null;
  /** An action is on its way to the deck. */
  pending: boolean;
  /** Why the deck refused the last action, when it did. */
  refused: string | null;
  refresh(): Promise<EngineStatus | null>;
  install(): Promise<void>;
  installFile(file: Blob): Promise<void>;
  cancel(): Promise<void>;
  remove(): Promise<boolean>;
}

/** The deck's engine install, read while `active`. */
export function useEngineInstall(active = true): EngineInstall {
  const [status, setStatus] = useState<EngineStatus | null | undefined>(undefined);
  const [mine, setMine] = useState<string | null>(() => readJob());
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const watched = useRef(new Set<string>());
  const samples = useRef<{ at: number; received: number }[]>([]);
  const [speed, setSpeed] = useState<number | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const take = useCallback((next: EngineStatus | null) => {
    if (!alive.current) return;
    const job = next?.job;
    if (job) {
      watched.current.add(job.id);
      if (job.phase === "downloading") {
        const now = Date.now();
        samples.current = [...samples.current.filter((s) => now - s.at <= SPEED_WINDOW_MS), { at: now, received: job.received }];
        setSpeed(speedOf(samples.current));
      }
    } else {
      samples.current = [];
      setSpeed(null);
    }
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const next = await engineStatus();
    take(next);
    return next;
  }, [take]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  // Read again while something installs.
  const running = !!status && (!!status.job || status.elsewhere);
  const fast = !!status?.job && status.job.id === mine;
  useEffect(() => {
    if (!active || !running) return;
    const timer = setTimeout(() => { void refresh(); }, fast ? POLL_MS : POLL_ELSEWHERE_MS);
    return () => clearTimeout(timer);
  }, [active, running, fast, status, refresh]);

  const start = useCallback(async (go: () => Promise<{ ok: true; id?: string } | { ok: false; code: string }>) => {
    setPending(true);
    setRefused(null);
    const answer = await go();
    if (!alive.current) return;
    if (answer.ok && answer.id) {
      watched.current.add(answer.id);
      setMine(answer.id);
      writeJob(answer.id);
    } else if (!answer.ok) {
      setRefused(answer.code);
    }
    await refresh();
    if (alive.current) setPending(false);
  }, [refresh]);

  const install = useCallback(() => start(() => installEngine()), [start]);
  const installFile = useCallback((file: Blob) => start(() => installEngineFile(file)), [start]);
  const cancel = useCallback(async () => {
    setPending(true);
    await cancelEngineInstall();
    await refresh();
    if (alive.current) setPending(false);
  }, [refresh]);
  const remove = useCallback(async () => {
    setPending(true);
    setRefused(null);
    const answer = await removeEngine();
    if (!answer.ok && alive.current) setRefused(answer.code);
    await refresh();
    if (alive.current) setPending(false);
    return answer.ok;
  }, [refresh]);

  return { status, mine, watched: watched.current, speed, pending, refused, refresh, install, installFile, cancel, remove };
}
