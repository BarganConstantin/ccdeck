// Rows on their way, in an integration panel (#2178, #2179).
//
//   <IntegrationSkeleton label="Reading the board" rows={6} variant="rows" | "lines" />
//
// One loading shape for Jira and the forges, which had two (900 ms and
// 1200 ms, one of them pulsing under reduced motion). Grey bars at a list
// row's height ("rows") or a paragraph's ("lines"), that stay out of sight
// for the first 300 ms, so a read that answers quickly never flashes them,
// then fade in and pulse at the deck's one ambient beat (--pulse-live). Under
// reduced motion they appear without the pulse. A screen reader hears `label`
// once, as a status; the bars are hidden from it.
export default function IntegrationSkeleton({ label, rows = 6, variant = "rows" }: {
  /** What is being read, said to a screen reader: "Reading the board". */
  label: string;
  rows?: number;
  variant?: "rows" | "lines";
}) {
  return (
    <div className="ig-skeleton" data-variant={variant} role="status">
      <span className="vis-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => <i key={i} aria-hidden />)}
    </div>
  );
}
