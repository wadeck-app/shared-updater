# Migration: interrupted-install recovery

Cause: an updater killed inside `npm install -g` left the old package removed, no state, a dead-pid lock, and no log.

## What changed (without-daemon strategy)

- `update-state.json` gets `status: 'applying'` (plus `pid`, `previousVersion`, `targetVersion`) BEFORE npm runs. `shared-cli` `UpdateManager` already knows this value and does not clear it. No new status value was added.
- Every run, right after the lock and before `autoUpdate` / throttle checks, a leftover `applying` state is repaired (dead pid, or older than 15 min): keep the target if fully installed and self-check passes, else reinstall the previous version. Result is `rolled-back` (repaired) or `failed` (with a `Fix manually: npm install -g ...` command). Repair then ends the run.
- Failed install, version mismatch after install, and failed self-check all restore the previous version and write a state. A failed self-check rollback used to write nothing.
- The installed version is read from `<npm root -g>/<pkg>/package.json` after install; npm's exit code alone is no longer trusted. If `npm root -g` cannot be resolved, a warning is logged and the install is kept.
- SIGINT/SIGTERM/SIGBREAK/exit stop the npm process tree this updater owns, release the lock and log (npm is now asynchronous, so the signal is handled at once; the cut install is repaired by the next run). Hard kills (SIGKILL, Windows `process.kill`, job-object kill) run no handler: the `applying` state covers them.
- `npm install -g` (update, rollback, repair) runs through `runNpmAsync` (spawn): same command line and error text as before; a timeout stops the whole tree. POSIX: npm is spawned `detached` (own process group) and the group is stopped with SIGKILL. Windows: `taskkill /T /F`. `execNpm` stays synchronous for `npm view` / `npm root -g`.
- The npm pid and spawn time (`npmPid`, `npmStartedAt`) are written to the `applying` state right after spawn and cleared when npm ends.
- Repair, before touching the global dir: if `npmPid` is still running, wait up to `orphanNpmWaitMs` (default 30 s), then stop its tree (logged at error level) and only then reinstall. If it cannot be stopped, the state stays `applying` (the next run retries) and nothing is reinstalled.
- Lock: created atomically (`wx`); `EPERM` from `process.kill(pid, 0)` now means alive (was "dead").
- `update-state.json` is written via temp file + rename.
- Leftover npm temp dirs (`.<name>-XXXX` beside the package) are never deleted. Logged as `warn` (may hold the previous version) when the previous version is being restored, as `info` when the complete new version is kept.

## New exports

`verifyInstalled(pkgName, expectedVersion?)`, `findLeftoverTempDirs`, `repairInterruptedInstall`, `ensureVersion`, `isPidAlive`, `runNpmAsync`, `installGlobal`, `reapOrphanNpm`, `isProcessRunning`, `killProcessTree`, type `InstalledCheck`. `UpdateState.status` adds `'applying'`; `UpdateState` adds `pid`, `npmPid`, `npmStartedAt`. New optional config `orphanNpmWaitMs`.

**Breaking:** `ensureVersion` now returns a `Promise`.

## Consumer actions

1. Rebuild the updater bundle (`*-updater.cjs`) and publish; the fix lives in the bundled code.
2. A launcher/scheduler that finds its CLI missing cannot run the updater from that CLI: call `verifyInstalled(pkgName)` and, if `ok` is false while a state of `applying` exists, run the updater (it repairs).
3. UI reading `update-state.json`: `applying` with a dead `pid` means an interrupted install, not a running one. `shared-cli` comment "shared-updater no longer writes it" is now outdated.

## Known limits

- Hard-killing the updater orphans its npm on POSIX (seen in CI: `sh` + `npm install` alive after the kill). The next run now finds it through `npmPid`, waits, stops its group, then repairs. Residual:
  - Kill between `spawn()` and the journal write (microseconds): no pid recorded, orphan not found.
  - Pid reuse: a live pid is stopped only if the journal is younger than 6 min and, when `ps` / PowerShell can report it, the process started within 15 s of the recorded spawn. Where the start time is unreadable (busybox `ps`, no PowerShell, access denied) only the 6 min bound protects an unrelated process that recycled the pid.
  - A descendant that left npm's process group (`setsid`), or on Windows whose parent already died, is not reached.
  - Linux zombies count as dead; elsewhere an unreaped zombie would make the repair report "STILL running".
- Windows, observed with real npm (updater hard-killed without the tree option while npm ran a postinstall): npm and its `cmd /c` parent died but the postinstall `node.exe` grandchild survived with a dead parent, and the repair does not stop it. Not fixed on purpose: only `npmPid` is journaled, the grandchild's parent chain is dead (those pids can be reused) and its command line carries no marker tying it to the install. Stopping it would need name or guessed-path matching, which can end an unrelated process. If it holds the package dir, stop it manually (find it by its script path).
- Windows: libuv puts non-detached children in a kill-on-close job object, so npm dies with a hard-killed updater (observed: a child of a terminated node was gone 1.5 s later). The orphan path is covered there only by unit tests with real processes; the real-npm integration test exercises it on POSIX only.
- Not verified on Linux/macOS locally (CI only), nor on a real Windows kill with a real half-removed package.
- `with-daemon` strategy is unchanged (it never installs).
- The legacy `update-log.txt` is not written by this package; all decisions go to `logs/<date>.ndjson`.
