// How the Projects report loads: two reads, and only one of them gates it.
//
// Kept out of the component so the ordering rules can be tested without React
// or a DOM, the reason latest.ts and usage-view.ts live out here too.
//
// The report is ccdeck's own tally (/api/account-projects), incremental and
// cheap by design. Its dollars are reconciled against ccusage (/api/ccusage),
// which walks the whole Claude log tree, queues behind any other ccusage run
// and may take its full ninety-second deadline on a cold cache. The modal used
// to wait for both through one Promise.all, so a best-effort enrichment held the
// whole report on `Loading…` long after the tally had answered (#1317). Now
// each read lands on its own: the report draws the moment it arrives, priced by
// pricing.ts, and ccusage's answer reconciles those dollars in place when it
// comes — or, when it fails, leaves them as the estimate they already were.
// Nothing is cancelled and nothing is given up on early: a slow ccusage still
// gets to be the dollar authority, it just no longer decides when the report
// may be read.
//
// Every write carries the request that asked for it, and only the newest
// request may write, so a range's late answer — its report or its ccusage run
// — can never land on the range the user has moved on to.

/** ccusage's part of a report on screen. `running` and `failed` both draw
 *  pricing.ts's estimate; only `running` says it is about to move. */
export type CostState =
  | { phase: "running" }
  | { phase: "failed" }
  | { phase: "ready"; range: unknown };

const RUNNING: CostState = { phase: "running" };
const FAILED: CostState = { phase: "failed" };

/** A report that landed, tagged with the request that asked for it. */
export interface ShownReport<R> {
  gen: number;
  /** The window it covers, which the pressed chip may already have left. */
  days: number;
  data: R;
  cost: CostState;
}

export interface ProjectsLoad<R> {
  /** The newest request. Nothing an older one sends may be written. */
  gen: number;
  /** The last report that landed. It stays up, dimmed, while a newer one loads,
   *  and keeps the dollars it was reconciled against while it does. */
  report: ShownReport<R> | null;
  /** Why the newest request's report failed, or null. */
  error: string | null;
  /** ccusage's answer to the newest request when it beat that request's report
   *  here — a cached range answers at once — held to pair with it. */
  early: { gen: number; cost: CostState } | null;
}

export type ProjectsEvent<R> =
  | { type: "start"; gen: number }
  | { type: "report"; gen: number; days: number; data: R }
  | { type: "reportFailed"; gen: number; message: string }
  | { type: "cost"; gen: number; cost: CostState };

/** Before the first request: nothing on screen, and nothing has failed. */
export const INITIAL_LOAD: ProjectsLoad<never> = { gen: 0, report: null, error: null, early: null };

export function projectsLoad<R>(s: ProjectsLoad<R>, e: ProjectsEvent<R>): ProjectsLoad<R> {
  // The generation guard the modal's reqId always was, now on every write
  // rather than on the one Promise.all that used to be the only write.
  if (e.type !== "start" && e.gen !== s.gen) return s;
  switch (e.type) {
    case "start":
      return { ...s, gen: e.gen, error: null, early: null };
    case "report": {
      const cost = s.early?.gen === e.gen ? s.early.cost : RUNNING;
      return { ...s, report: { gen: e.gen, days: e.days, data: e.data, cost }, early: null };
    }
    case "reportFailed":
      // The report on screen belongs to a window the chip has already left, so
      // it goes rather than standing under the failure as if it answered it.
      return { ...s, report: null, error: e.message, early: null };
    case "cost":
      if (s.report?.gen === e.gen) return { ...s, report: { ...s.report, cost: e.cost } };
      return { ...s, early: { gen: e.gen, cost: e.cost } };
  }
}

/** Whether the newest request's report is still out. This alone is the modal's
 *  `Loading…` — ccusage has no say in it (#1317). */
export function reportLoading(s: ProjectsLoad<unknown>): boolean {
  return s.report?.gen !== s.gen && s.error === null;
}

/** ccusage's body as the report's cost. One that says `ok: false` — a timeout, a
 *  CLI that would not install — is a failure the same as no body at all. */
export function costFrom(body: unknown): CostState {
  const range = body as { ok?: unknown } | null;
  return range && range.ok !== false ? { phase: "ready", range } : FAILED;
}

/** Format a local date as the `YYYYMMDD` /api/ccusage insists on. */
function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** The two reads for one account and window. */
export function projectsUrls(num: number, days: number, now: number = Date.now()): { report: string; ccusage: string } {
  // The window the tally used: today back N-1 days (60 for "all", matching
  // the rollup's retention). ccusage is asked for the same span so the two
  // agree day-for-day.
  const span = days === 0 ? 60 : days;
  const since = ymd(new Date(now - (span - 1) * 86_400_000));
  const until = ymd(new Date(now));
  return {
    report: `/api/account-projects?num=${num}&days=${days}`,
    ccusage: `/api/ccusage?since=${since}&until=${until}`,
  };
}

/** The part of `fetch` the loader uses, so a test can hand it a slow server. */
export type Get = (url: string, init: { credentials: "same-origin" }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Start both reads for request `gen`. Each one dispatches when it settles, on
 * its own — neither waits for the other.
 */
export function loadProjects<R>({ num, days, gen, dispatch, get = (url, init) => fetch(url, init), now = Date.now() }: {
  num: number;
  days: number;
  gen: number;
  dispatch: (e: ProjectsEvent<R>) => void;
  get?: Get;
  now?: number;
}): void {
  const urls = projectsUrls(num, days, now);
  const init = { credentials: "same-origin" } as const;
  get(urls.report, init)
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(
      data => dispatch({ type: "report", gen, days, data: data as R }),
      (err: Error) => dispatch({ type: "reportFailed", gen, message: err?.message || "Could not load" }),
    );
  // Best-effort: a failure leaves the report on pricing.ts rather than
  // blocking it on a subprocess.
  get(urls.ccusage, init)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null)
    .then(body => dispatch({ type: "cost", gen, cost: costFrom(body) }));
}
