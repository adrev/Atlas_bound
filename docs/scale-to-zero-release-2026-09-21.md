# Scale-to-Zero Persistence Release

Target: `atlas-bound-personal / us-central1 / atlas-bound`.

This release implements the prerequisites identified in
`scale-to-zero-preflight-2026-09-21.md`. It is based on the deployed `a0e4afd`,
not the newer, unreleased main branch. The preflight hold describes the state
before this implementation and is retained as historical evidence.

## Changes

- Versioned Postgres runtime snapshots preserve combat budgets, condition
  metadata, music, DM map previews, hooks, event cursors and ready-check data.
- Character feature resources have independent durable records. Per-session
  advisory locks and ordered character locks serialize concurrent instances.
- Socket.IO uses the PostgreSQL adapter. Gameplay writes commit before success
  broadcasts; failed transactions restore the local cache. Presence is rebuilt
  from live transports and SQL membership, not saved as permanent state.
- Reconnects establish a fresh client request lifetime and authoritative snapshot;
  stale responses, replay cursors and generations cannot overwrite that state.
- Ready-check timers are re-created from durable deadlines after commit. Timer
  retries are bounded and cancelled checks cannot trigger a later encounter.
- Chronicle work has persisted leases and attempt-fenced results. Vertex work
  is bounded and request-bound; expired jobs become visibly retryable. External
  workers use adaptive idle polling and must be upgraded with the server.
- Required catalog initialization finishes before serving. Discord notifications
  are awaited with their existing timeout and remain best-effort, not a durable
  notification outbox. Shutdown drains admitted gameplay work for up to 9 seconds.
- Deployment explicitly sets service/revision minimums to zero and retains
  request-based CPU allocation. No Cloud SQL shutdown or sizing change.

## Compatibility

Previously lost memory-only counters cannot be reconstructed. Existing campaigns
may need one-time DM reconciliation of XP and feature uses. Legacy combat without
a runtime checkpoint restores unknown turn budgets as spent, not free actions;
advance the turn or reconcile explicitly. Rules and newer unreleased main changes
are not silently bundled into this operational release.

The SQL changes are additive. Do not remove runtime or Chronicle lease columns
when rolling back. An old server does not maintain these snapshots: after gameplay
on an old revision, an operator must reconcile the checkpoints before re-enabling
this release. Never run old and new revisions concurrently against an active game.

## Local Verification

- Full suite with explicit loopback PostgreSQL: 120 files, 1,441 tests passed.
- Production build and zero-warning ESLint passed; dependency audit reported
  zero vulnerabilities. Worker protocol tests passed 8/8.
- Real PostgreSQL tests cover fresh Node process restoration, concurrent writers,
  failed commits, feature resources, ready checks and Chronicle lease recovery.
- Two-process WebSocket suite passed 14/14: cross-instance movement, chat/music,
  privacy filtering, room switches, multi-tab disconnects, process kill, cold
  REST hydration and rejoin. These are local integration tests, not a claim that
  real players or production OAuth were exercised.

## Rollout Record

Pre-release SQL backup operation `0a3a5509-8d1f-493e-9e70-d42000000032`
completed successfully at `2026-09-21T11:33:31.730Z`.

Candidate deployment, traffic promotion, measured cold-start latency and explicit
idle-zero observations are recorded below only after they have actually happened.
Until then, production remains on `atlas-bound-00064-kzr`.

Rollback baseline: `atlas-bound-00064-kzr` (revision minimum 1). Route traffic back
only if no active game can be split across versions. Keep the additive schema and
the pre-release backup; investigate/reconcile durable runtime state before retry.
