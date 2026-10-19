# Local read activity

Mode: Operate. Quota History, Processes and Sensor History preserve their
existing modal shells, API reads, polling intervals, errors and empty states.

`ReadActivity` supplies three decorative waiting illustrations: saved quota
readings, a process list scan and recorded sensor history. Only one small accent
mark moves, using transform/opacity, with a 1200–1600ms indeterminate cadence.
The artwork conveys reading, never a measured percentage or fabricated sample.
Process and sensor artwork appears after 150ms to avoid a fast-read flash; text
is immediate, and data is never held back for the animation.

Hidden documents pause the loop. Reduce Motion uses a static mark and no result
fade. Quota and sensor results use a single 120ms opacity arrival. Polls retain
the existing content; live values, sorting and chart paths do not animate.
No dependency, layout animation, shadow effect or brand artwork is introduced.

Verified with isolated browser fixtures in Rider Black and White Contrast at
1440, 390 and 320px, plus Reduce Motion, alongside the existing modal and data
regression tests. See docs/features/animation-opportunities.md for the audit.
