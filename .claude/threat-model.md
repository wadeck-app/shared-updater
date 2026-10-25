# Threat Model — shared-updater

## Reliability

| Risk | Mitigation |
|---|---|
| Concurrent updater runs corrupting state | File-based mutex with PID liveness + timestamp stale detection (10-min threshold) |
| Bad update breaks the CLI | Self-check via `UPDATER_SELF_CHECK_CMD` post-install; rollback to `currentVersion` on failure |
| Rollback failure | Logged to NDJSON; state file records `rolled-back`; process continues |
| npm install hanging | 5-minute timeout on `npm install -g`; same timeout on rollback; the whole npm process tree is stopped |
| Registry fetch blocking | `fetchLatestVersion` is synchronous with 30s timeout — a slow registry blocks the caller thread |
| Corrupt state/cache files | Silently ignored (returns `null`) — intentional fail-open |

## Security

- **Health token auth** — POST `/quit` uses `Authorization: Bearer <token>` read from `health_token` file on disk in `configDir` (plaintext at rest).
- **`UPDATER_SELF_CHECK_CMD`** — passed to `execSync` as a raw string from environment; not user input, but unconstrained; ensure callers set this to a fixed, known-safe command.
- **npm install runs as current user** — no privilege isolation; update is trusted by design.
- **`process.kill(pid, 0)` for stale lock detection** — POSIX behaviour; Windows behaviour may differ (not fully tested in `lock.test.ts`).
- **No cryptographic verification of downloaded package** — trust model is npm registry auth only.

## Interrupted install

| Risk | Mitigation |
|---|---|
| Updater killed inside `npm install -g` (old package already removed) | `applying` state + repair on next run (`repairInterruptedInstall`) |
| Updater hard-killed: npm (and `sh` on POSIX) keeps running as an orphan (seen in CI) | npm pid + spawn time journaled in `applying`; repair waits (`orphanNpmWaitMs`), stops the tree, then reinstalls. Signals stop the tree. Windows: npm dies with the updater (libuv job object) |
| Pid reuse: repair stops an unrelated process | Only if journal < 6 min old and start time within 15 s of the recorded spawn (when readable); otherwise age bound only |
| Updater killed between `spawn()` and the journal write, or npm descendant outside its process group | Not covered (narrow); repair still verifies the disk and reinstalls, and may race that process |
| Leftover `.<name>-XXXX` dir after crash | Logged only, never deleted (may hold the previous version) |
| Dead-pid lock | Taken over immediately; live pid respected for 10 min; `EPERM` counts as alive |
