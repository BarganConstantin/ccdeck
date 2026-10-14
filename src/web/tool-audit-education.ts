/** Teaching copy describes existing measurements, never execution claims. */
export const auditExplanations = {
  median: 'Half of the measured containing-call intervals were this long or shorter.',
  p95: 'Approximately 95% of measured containing-call intervals were this long or shorter. The slowest 5% may take longer.',
  p95Example: 'If P95 is 3 seconds, approximately 95 out of 100 measured calls completed within 3 seconds.',
  sample: 'ccdeck displays P95 after 20 valid measurements. This is a minimum sample rule, not the definition of P95 or a confidence guarantee.',
  intervals: 'These intervals include the whole containing call, including possible waits; they are not isolated inner-command runtimes.',
  cumulative: 'Adds measured call intervals. Some calls overlap, so this is not elapsed wall-clock time. Operation totals may share the same intervals.',
  failures: 'Failures are reported outcomes of containing calls. They do not prove that every inner command independently failed.',
  failureRate: 'Failure rate divides reported failed calls by completed observed outcomes. Missing outcomes are excluded. Rate comparisons require at least 20 outcomes.',
  coverage: 'Calls with a valid measured interval divided by observed calls. Missing timing is unknown, not zero or failure.',
  freshness: 'Snapshot is the report cut-off when local history is read. Refresh can advance it without new activity. Observed starts show the first and latest recorded call starts in the selection, not continuous recording coverage.',
} as const;
export const auditReadingGuide = [
  ['Observed tool calls', 'Distinct recorded tool-call starts in the selected provider and period.'],
  ['Containing calls / Most used', 'Calls in which an operation was detected. One call can contain several operations, so operation counts cannot be added together.'],
  ['Cumulative intervals', auditExplanations.cumulative],
  ['Median', auditExplanations.median],
  ['P95', `${auditExplanations.p95} ${auditExplanations.sample}`],
  ['Timing coverage', auditExplanations.coverage],
  ['Reported failures / Failure rate', 'Recorded failed containing-call outcomes, divided by completed observed outcomes for the rate. This does not prove every inner operation failed. Rate comparisons require 20 outcomes.'],
  ['Shared intervals', 'Several detected operations inherit the same containing-call interval and outcome; this does not measure each command separately.'],
  ['Dates and clocks', 'Requested period is the filter. Observed starts are recorded endpoints, not continuous coverage. Snapshot is the report cut-off. Claude hook and Codex rollout clocks are different timing sources, not speed benchmarks.'],
] as const;
