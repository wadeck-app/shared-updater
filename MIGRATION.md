# Migration: interrupted-install recovery

Cause: an updater killed inside `npm install -g` left the old package removed, no state, a dead-pid lock, and no log.

## What changed (without-daemon strategy)

- `update-state.json` gets `status: 'applying'` (plus `pid`, `previousVersion`, `targetVersion`) BEFORE npm runs. `shared-cli` `UpdateManager` already knows this value and does not clear it. No new status value was added.
- Every run, right after the lock and before `autoUpdate` / throttle checks, a leftover `applying` state is repaired (dead pid, or older than 15 min): keep the target if fully installed and self-check passes, else reinstall the previous version. Result is `rolled-back` (repaired) or `failed` (with a `Fix manually: npm install -g ...` command). Repair then ends the run.
- Failed install, version mismatch after install, and failed self-check all restore the previous version and write a state. A failed self-check rollback used to write nothing.
- The installed version is read from `<npm root -g>/<pkg>/package.json` after install; npm's exit code alone is no longer trusted. If `npm root -g` cannot be resolved, a warning is logged and the install is kept.
- SIGINT/SIGTERM/SIGBREAK/exit release the lock and log. Node only runs them between sync steps, so a signal during npm is delivered after npm returns. Hard kills (SIGKILL, Windows `process.kill`, job-object kill) run no handler: the `applying` state covers them.
- Lock: created atomically (`wx`); `EPERM` from `process.kill(pid, 0)` now means alive (was "dead").
- `update-state.json` is written via temp file + rename.
- Leftover npm temp dirs (`.<name>-XXXX` beside the package) are logged, never deleted.

## New exports

`verifyInstalled(pkgName, expectedVersion?)`, `findLeftoverTempDirs`, `repairInterruptedInstall`, `ensureVersion`, `isPidAlive`, type `InstalledCheck`. `UpdateState.status` adds `'applying'`; `UpdateState.pid` added. No new required config.

## Consumer actions

1. Rebuild the updater bundle (`*-updater.cjs`) and publish; the fix lives in the bundled code.
2. A launcher/scheduler that finds its CLI missing cannot run the updater from that CLI: call `verifyInstalled(pkgName)` and, if `ok` is false while a state of `applying` exists, run the updater (it repairs).
3. UI reading `update-state.json`: `applying` with a dead `pid` means an interrupted install, not a running one. `shared-cli` comment "shared-updater no longer writes it" is now outdated.

## Known limits

- Hard-killing the updater does not kill its npm child. Observed in CI (Linux): after the kill, `sh` and `npm install @te...` were still alive ("Terminate orphan process" in the post-job cleanup), because without `npm-cli.js` beside node, `execNpm` runs npm through `sh`. That orphan can finish or half-write the global dir while the next run repairs. Not handled in code: `execNpm` is synchronous and never learns the npm pid. Follow-up: spawn npm asynchronously, record its pid in the `applying` state, and have repair wait for or kill that pid first.
- Not verified on a real Windows kill with a real half-removed package.
- `with-daemon` strategy is unchanged (it never installs).
- The legacy `update-log.txt` is not written by this package; all decisions go to `logs/<date>.ndjson`.
