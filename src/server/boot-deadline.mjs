// The boot has a deadline, and the jobs under it do not get to decide it.
//
// #742. Two people on two operating systems reported the same thing: `npx
// ccdeck`, the wordmark, four rows, then a spinner at "checking claude-swap…"
// and nothing — no "server ready", no browser, no way to tell a slow machine
// from a dead one. The port was open the whole time. What they were watching
// was `reportStartup` awaiting `ensureCswap`, which on a machine that has
// neither claude-swap nor a Python toolchain downloads a uv binary under a
// 120-second deadline and then runs `uv tool install claude-swap` under a
// 180-second one. Five minutes, worst case, before the line that says where to
// point a browser — for a panel that is optional and that nobody asked for
// during that boot.
//
// The install itself is not the bug and is not cancelled here. What was wrong
// is that the boot waited for it. So every job whose failure is not fatal is
// given a slice of the boot rather than the whole of it, and a job that is
// still working when its slice runs out is SAID SO and left running. The row it
// would have printed is printed later, when it settles, which is the same
// contract the deck already has with its background upgrade.
//
// bin/deck.js's `update` job has raced a timer since it was written — this is
// that idea, given a name and the one thing the inline race could not do: tell
// "the job answered null" apart from "the job did not answer", which for
// claude-swap is the difference between "not installed" and "still installing".

/** How long the whole report may spend waiting on jobs that are not fatal.
 *
 *  Eight seconds is chosen from the two ends it sits between. Below it are the
 *  probes a normal boot really does pay — `cswap --version`, `uv --version`,
 *  a PyPI lookup — which finish in well under a second on a warm machine and in
 *  two or three on a cold one behind a slow DNS; a deadline under that would
 *  turn every honest boot into a background one and the rows would stop being
 *  where a reader looks for them. Above it is the only thing the deadline
 *  exists to bound, and that one is measured in minutes, so there is no value
 *  in the middle that anybody would notice being wrong. */
export const BOOT_DEADLINE_MS = 8_000;

/**
 * The deadline, as the environment may override it.
 *
 * Tests need a boot they can watch inside a test budget, and a test that has to
 * wait eight real seconds to prove the deadline works is a test that costs the
 * suite eight seconds forever. Read from the environment rather than passed
 * down through four call sites for one caller that is not the product.
 *
 * Anything unparseable, negative, or absent is the default. Zero is honoured —
 * "give the jobs nothing" is a coherent thing for a test to ask for, and the
 * timer path below still runs, so it exercises the same code the product does.
 */
export function bootDeadlineMs(env = process.env) {
  const raw = env.AGENTS_DECK_BOOT_DEADLINE_MS;
  if (raw === undefined || raw === "") return BOOT_DEADLINE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : BOOT_DEADLINE_MS;
}

/**
 * Await `work`, but never past `ms`.
 *
 * Answers `{ done: true, value }` or `{ done: false, value: undefined }`. A
 * shape rather than a sentinel value, because three of the jobs this wraps
 * resolve to `null` on purpose — "not attempted" is a real answer and must not
 * read as "ran out of time".
 *
 * A rejection is a settled job, not a timeout: `{ done: true, value: undefined
 * }`. Every caller here already attached its own rejection handler at the point
 * the promise was created, so the throw has been dealt with and what is left to
 * decide is only whether to keep waiting. Re-throwing would turn a job that
 * failed politely into a boot that died.
 *
 * The timer is cleared the moment the job settles, so a boot whose jobs all
 * answer at once does not hold the event loop for the rest of the deadline.
 *
 * It is deliberately NOT unref'd. An unref'd deadline is a deadline that does
 * not fire when the only thing left in the process is the deadline itself —
 * which is exactly the shape of a test that awaits nothing else, and would have
 * made this function pass by exiting rather than by working. The cost of
 * keeping it is at most one deadline's worth of a process that was about to
 * end, against a deck that runs until Ctrl+C.
 */
export function within(work, ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  return new Promise(resolve => {
    let answered = false;
    const timer = setTimer(() => {
      if (answered) return;
      answered = true;
      resolve({ done: false, value: undefined });
    }, ms);
    Promise.resolve(work).then(
      value => {
        if (answered) return;
        answered = true;
        clearTimer(timer);
        resolve({ done: true, value });
      },
      () => {
        if (answered) return;
        answered = true;
        clearTimer(timer);
        resolve({ done: true, value: undefined });
      },
    );
  });
}

/**
 * A deadline shared by everything that draws on it, in the order they are
 * awaited.
 *
 * One budget for the whole report rather than one each, because the rows are
 * awaited in sequence and per-job deadlines would multiply: four jobs at eight
 * seconds is a thirty-two second boot that every individual deadline would call
 * within its budget. What a reader was promised is that the deck is ready
 * within the deadline, and that promise is about the sum.
 *
 * `left()` never goes below zero, so a job reached after the budget is spent is
 * given a zero-length slice and reported as still working — which it is.
 */
export function budget(ms, now = Date.now) {
  const started = now();
  return {
    left: () => Math.max(0, ms - (now() - started)),
    spent: () => now() - started,
    /** Await `work` against whatever is left. */
    within: (work, deps) => within(work, Math.max(0, ms - (now() - started)), deps),
  };
}
