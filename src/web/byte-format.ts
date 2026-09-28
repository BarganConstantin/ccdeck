// Byte counts in the deck's voice: "0 B", "812.0 B", "1.5 KB", "725.0 MB",
// "2.4 GB".
//
// Three of these lived in the tree, and no two printed the same value the same
// way (#1128). The process list's `fmtBytes` gave three significant figures
// and went down to bytes; the machine panel's `bytes` gave gigabytes one
// decimal, megabytes and kilobytes none, and never said bytes at all; the
// context modal's `fmtKB` gave kilobytes one decimal and megabytes two. So one
// mebibyte read "1.0 MB", "1 MB" and "1.00 MB" depending on the panel, and an
// idle swap read "0 KB" in the machine panel where the process list would have
// said "0 B".
//
// The owner chose one format for all three: one decimal place at every unit,
// bytes included, and "0 B" for zero — nothing, said plainly, rather than a
// precision a count of nothing does not have.
//
// Binary units under the short names, because that is what `ps`, /proc/meminfo
// and every process viewer on the three platforms report, and it is what all
// three copies already did. Built from `toFixed` rather than `toLocaleString`
// for token-format.ts's reason: a grouping separator that changes with the
// host's locale would change a padded column's width with it.

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * A byte count at one decimal place, in the largest unit it fills.
 *
 * The unit is chosen on the ROUNDED figure, so 1,048,575 bytes reads "1.0 MB"
 * like the mebibyte it rounds to, not "1024.0 KB". An absent, negative or
 * non-finite count is a reading nobody took, and reads "—" — the process
 * list's column has always said that for a process it could not size.
 */
export function fmtBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  let v = n, i = 0;
  while (i < UNITS.length - 1 && Number(v.toFixed(1)) >= 1024) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${UNITS[i]}`;
}
