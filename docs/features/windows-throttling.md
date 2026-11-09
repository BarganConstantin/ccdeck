# Windows CPU performance limits

The Windows thermal reader previously returned `throttle: null` on every path,
including machines where Windows exposes processor performance constraints.
The Machine panel therefore omitted the throttling row regardless of those
constraints.

The reader now collects `PercentPerformanceLimit` from
`Win32_PerfFormattedData_Counters_ProcessorInformation` in its existing
PowerShell invocation. CIM class and property names are not localized. The
lowest valid processor value represents the strongest reported constraint;
aggregate entries cannot hide a more limited individual processor.

This is guaranteed performance relative to nominal performance, as described
by Windows' built-in Processor Information / % Performance Limit counter help.
Policy, firmware, power budgets and heat can all affect it. It does not identify
the cause, detect every hardware-level thermal event, or measure lost turbo
boost. The source tag preserves that distinction in both the row and the
attention flag. Values above nominal are displayed as no reduction below
nominal. Missing or invalid readings remain unknown, not zero.

No new dependency, driver, elevation, outbound request or persisted setting is
needed. Existing temperature sources, Linux time-based throttling and macOS
thermal speed limits retain their behavior. The percentage still feeds the
existing history, strip and terminal display.

## Verification

- Physical Windows machine, standard unelevated process: real reader and
  `/api/system` return a tagged 100% nominal performance limit even without a
  CPU temperature sensor. The Machine panel displays a 0% reduction.
- Five regression cases cover temperature-free sampling, worst-core/zero/boost
  handling, absent or invalid counters, simultaneous temperatures and caps,
  and UI text that avoids claiming thermal causation or maximum turbo speed.
- 312 focused tests passed across Windows thermal sources, thermal sampling,
  terminal readings, machine rows/strip, section history and translations.
  The affected row/attention tests were rerun after the final text correction.
- TypeScript check and production build passed on Node 24.13.0.
- Isolated headless Brave UI: real counter; simulated 62% nominal ceiling
  renders 38% reduction; desktop, 390px and 320px; dark and light themes.
  Reduced-cap UI checks use synthetic input, not a real induced thermal event.
- No heating stress test, power-policy change, Linux/macOS execution, public
  push, release publication or installed-desktop replacement was performed.

Local development preview uses a separate loopback port and state directory;
the installed desktop copy is unchanged. A release still follows the repository
release workflow and owner approvals.
