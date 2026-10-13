# Windows update shutdown investigation

Date: 2026-10-13. Baseline: `development` at `84576941`.
Branch: `fix/windows-update-shutdown`. Fix: `ce2a8007`.

## Report and scope

A private Windows report shows the NSIS message “ccdeck cannot be closed.
Please close it manually and click Retry to continue.” The reporter says no
windows were open and several retries eventually allowed installation.
The attachments remain private and are not included in this report.

Closing the ccdeck window deliberately leaves its tray and server running.
Read-only Windows inspection confirmed a main process, Electron helpers and
an owned deck supervisor/worker under the installed application's executable.
This is expected background operation, not evidence of duplicate applications.

The report does not establish whether installation was launched manually or
through “Restart to update”. Those paths must not be treated as equivalent.

## Confirmed defect

`desktop/updater.mjs` called `auto.quitAndInstall(false, true)` on Windows.
In the installed `electron-updater@6.8.9`, `BaseUpdater.quitAndInstall()` calls
`install()` first and schedules `app.quit()` afterward. Meanwhile, ccdeck's
`before-quit` handler prevents that quit while `stopOwnDeck()` asynchronously
stops the owned deck. Consequently, the installer starts before this cleanup.

The new regression test failed on the original implementation:

```text
NSIS must not race the owned deck's shutdown: expected true to be false
Tests: 1 failed | 7 passed
```

The pinned `app-builder-lib@26.15.3` NSIS template
`templates/nsis/include/allowOnlyOneInstallerInstance.nsh` performs process
detection and termination, then displays `appCannotBeClosed` when processes
remain after its retry loop. It checks executable paths when its PowerShell
branch is available and falls back to executable-name/user filtering otherwise.
An early installer therefore competes with ccdeck's own shutdown instead of
letting it finish first. This is a verified race, but does not prove every
possible cause of the reporter's dialog.

The dependency implementations were inspected from their exact npm packages,
not inferred from an unpinned upstream branch. Electron documents the relevant
[before-quit and will-quit lifecycle](https://www.electronjs.org/docs/latest/api/app#event-before-quit).

## Fix

Windows “Restart to update” now records relaunch intent and requests a normal
quit. The existing `will-quit` hook starts the verified installer after the
owned-deck cleanup. Repeated restart requests do not request another quit
while the initial cleanup is pending.

The installer remains interactive and relaunches after a restart request.
Ordinary Quit still installs silently without relaunching. Signature checks,
download handling and macOS/Linux installation mechanisms are preserved.
No blanket process-name termination or new polling has been introduced.

## Verification

| Check | Result |
| --- | --- |
| Regression on original updater | Failed as expected, before fix |
| `node node_modules/vitest/vitest.mjs run 'src/web/__tests__/desktop-'` on Node 22.14 | 377 tests / 40 files passed |
| `npm run typecheck` | Exit 0 |
| `npm run build` | Exit 0; existing bundle-size warning |
| Six focused desktop suites on Windows / Node 22.23.3 | 46 tests / 6 files passed |
| Controlled native Electron lifecycle on Windows | Baseline unsafe; fixed ordering safe |
| `git diff --check` | Exit 0 |

The Windows focused suites cover quit installation, updater state, offered
versions, Linux package restart, owned-deck tree termination and deck restart.
They used an isolated detached worktree at `84576941` with the exact two-file
fix applied, matching local commit `ce2a8007`.

The native probe used Electron **42.11.6**, the real application's `before-quit`
handler, real updater method bodies, `BaseUpdater@6.8.9`, and a real disposable
child process using `stopChild()`. It injected a ready state and replaced only
the installer handoff with an observation, so no installer or download ran.
It waited for the child to report readiness before testing either flow.

```text
Baseline:
  installer-start (owned child running)
  cleanup-start → owned-child-exit → cleanup-end → will-quit

Fixed:
  cleanup-start → owned-child-exit → cleanup-end → will-quit
  installer-start (owned child stopped)
```

Both native runs confirmed successful child termination. Both recorded the
same installer options: `isSilent: false`, `isForceRunAfter: true`, and
`isAdminRightsRequired: false`.

The native probe is a diagnostic harness, not a packaged-installer end-to-end
test. The committed regression test covers the production updater seam.
The user's installed application was neither stopped nor updated.

## Remaining verification

- The exact Retry dialog has not been reproduced in a real NSIS installation.
- A manually launched Setup bypasses ccdeck's updater ordering; this fix does
  not change the installer's independent process-closing logic.
- Elevated processes, locked files, restricted PowerShell policies and the
  installer's fallback branch remain unverified explanations for that path.
- The existing owned-deck shutdown has a bounded kill fallback; completion of
  cleanup is not a universal guarantee that Windows permitted termination.

The focused fix is ready for review. Full incident resolution still requires
an isolated packaged-update exercise or a read-only diagnostic trace from the
affected installation. No release or merge into `development` was performed.
