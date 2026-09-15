// A load average of exactly zero was reported as "no reading" (#1028).
//
// ── what was observed ────────────────────────────────────────────────────────
//
//   const hasLoad = process.platform !== "win32" && load.some(n => n > 0);
//
// The platform test is correct and sufficient on its own: Node documents
// `os.loadavg()` as always `[0, 0, 0]` on Windows, so nothing but a real
// reading ever gets past it. The `.some(n => n > 0)` beside it reads as belt
// and braces and is not — it cannot reject a non-reading that the platform test
// did not already reject, and it CAN reject a reading that is real.
//
// `/proc/loadavg` on a genuinely quiet Linux box says `0.00 0.00 0.00`. A
// machine that has finished what it was doing therefore reported no load
// average at all, and `MachinePanel.tsx` gates the whole section on
// `{loadavg && …}` — so the section vanished from under the reader at exactly
// the moment the answer was "nothing is queued", which is a fact about the
// machine and not an absence of one. The same clause sits on the `record`
// beside it, so "Queued work" also collected no points through every quiet
// minute and the chart afterwards read as though the deck had been switched off
// through them.
//
// ── what this file drives, and what it does not ──────────────────────────────
//
// `os.loadavg` is forced to three zeros rather than waited for, because a
// suite's own machine is never reliably idle and a case that needed it to be
// would be a case that passes for the wrong reason on a busy runner.
//
// `process.platform` is NOT forced — there is no honest way to, and the
// module's rule is written against it — so the Windows leg asserts the Windows
// half of the same rule: three zeros there are still not a reading, and this
// change must not have turned them into one. Nothing is skipped on any leg.
//
// The matching `record("load:1m", …)` in `sampleCpu` takes the identical edit
// and is deliberately not driven here. It is reachable only from the sampler's
// three-second timer, and starting that timer also starts the memory and
// thermal probes, which spawn real children on two of the three platforms — a
// price this rule does not need paying, since what a reader loses when it is
// wrong is the chart fed by the snapshot below.
import { describe, it, expect, vi } from "vitest";
import { liveReadings } from "../machine-live";

// Only `loadavg`. Everything else in node:os stays real: this module reads
// `cpus()`, `totalmem()` and `platform()` on the same call and a wholesale fake
// would be measuring the fake.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const zeroed = { ...actual, loadavg: () => [0, 0, 0] };
  return { ...zeroed, default: zeroed };
});

// @ts-expect-error — a plain .mjs module, no types
const { systemSnapshot, stopSystemMetrics } = await import("../../server/system-metrics.mjs");

describe("a quiet machine", () => {
  it("reports its load average of zero as the reading it is", () => {
    stopSystemMetrics();
    const snap = systemSnapshot();

    if (process.platform === "win32") {
      // Node never gives Windows anything but [0, 0, 0], so there is no reading
      // to report and the panel must go on omitting the section. The repair
      // must not have made three zeros into data here.
      expect(snap.loadavg).toBeNull();
      return;
    }
    expect(snap.loadavg).toEqual([0, 0, 0]);
  });

  it("keeps the section on screen, which is what the reader actually lost", () => {
    // MachinePanel draws the whole load section under `{loadavg && …}`, so null
    // is not a missing number — it is a missing section, gone at the moment the
    // answer became "nothing is queued". And `liveReadings` is the strip's own
    // half of the same snapshot: it keys on `sys.loadavg?.length`, so a null
    // took the `load:1m` cell out with it.
    stopSystemMetrics();
    const snap = systemSnapshot();
    const live = liveReadings(snap);

    if (process.platform === "win32") {
      expect("load:1m" in live).toBe(false);
      return;
    }
    expect(live["load:1m"]).toBe(0);
  });
});
