# Scale-to-Zero Preflight: Hold Deployment

Date: September 21, 2026. Target: project `atlas-bound-personal`, service
`atlas-bound`, region `us-central1`.

## Decision

Do not enable scale-to-zero yet. The requested prerequisite, preservation of
important state across instance shutdown, is not satisfied by the deployed
application. No Cloud Run configuration, traffic, image, database schema, or
Cloud SQL setting was changed. A prerequisite persistence release needs to be
implemented and restart-tested before lowering the minimum.

The live image is based on `a0e4afd`, not current main `5b0f2c6`. Unmerged PR #208
is also not live. Changing only scaling would not deploy the newer persistence
fixes. This work used an isolated worktree at the deployed source so production
risks were not incorrectly assessed against newer code.

## Verified Live Configuration

| Setting | Observed value | Requested handling |
| --- | --- | --- |
| Serving revision | `atlas-bound-00064-kzr`, 100% traffic | Leave until prerequisites pass |
| Image | `us-central1-docker.pkg.dev/atlas-bound-personal/cloud-run-source-deploy/atlas-bound:a0e4afd` | No unrelated feature bundle |
| Service minimum | Unset, effective default 0 | Explicit 0 on safe rollout |
| Revision minimum | 1 | Change to 0 on safe rollout |
| Service maximum | 20 | Preserve |
| Revision maximum | 3 | Preserve |
| CPU / memory | 1 CPU / 1 GiB | Preserve |
| Concurrency / request timeout | 80 / 3600 seconds | Preserve |
| CPU throttling / billing | Default throttling, request-based | Explicit `--cpu-throttling`, preserve |
| Session affinity / startup boost | Enabled / enabled | Preserve |
| Chronicle backend | `vertex` | Must make execution durable/request-bound |
| Upload storage | GCS bucket `atlas-bound-data-personal` | Preserve |
| Cloud SQL | `atlas-bound-db`, RUNNABLE, activationPolicy ALWAYS | Leave running and unchanged |

No traffic tags or additional serving revisions were present in service status.
Older immutable revisions still have minimum 1 but have no serving traffic or
tags. Do not delete historical revisions to change their immutable settings;
keep them untagged and inactive after a future successful rollout.

## Confirmed Blockers

### Gameplay State

`server/src/utils/roomState.ts` deletes the room when its last socket leaves,
without saving its runtime state. A local execution against the deployed source
confirmed loss of spent action/movement/reaction budgets, class resource pools,
condition metadata, legendary resistance, music selection, and the event cursor
(500 becomes 0). This loss occurs even without terminating the process.

Cold join in `server/src/socket/sessionEvents.ts` reads basic combat rows but
does not restore these fields. It recreates the current actor's action budget
with unused actions and base-speed movement.

Additional module-local state is lost on process exit: XP, Wild Shape pools,
Arcane Ward, Lucky, Portent dice, class-use counters, Echo Knight state, mount
links and underwater mode. These are not included in a RoomState-only snapshot.

Primary campaign records, character sheets, map assets, tokens, fog, walls,
notes and chat have Postgres/GCS storage. This does not make all gameplay state
durable. Some combat/condition writes are fire-and-forget, and permanent-drawing
write failures are swallowed before successful-looking broadcasts.

### Reconnect And Shutdown

`client/src/hooks/useSocket.ts` rejoins after connection loss but keeps its old
cursor. Newly created server rooms reset the cursor to zero; replay does not
reject ahead-of-server cursors, so snapshots can remain suppressed until the
server catches up. Add an explicit room generation and full resynchronization.

Cold room hydration is not single-flight and complete before actions are
admitted. Ready-check timers can retain an evicted room and later act on a
replacement room with the same ID. No SIGTERM draining exists. A shutdown-only
save is insufficient; Cloud Run gives a bounded shutdown window and can restart
instances even with minimum instances enabled.

### Background Work

Production uses Vertex Chronicle generation. `server/src/routes/chronicle.ts`
starts it with an unawaited promise after returning HTTP 202. Request-based CPU
allocation can stop before model execution or result persistence finishes.
Interrupted `pending`/`generating` rows have no recovery path; the retry route
only accepts `failed`. Model/database failures can escape the floating promise.

External-worker mode is not configured live. Its five-second polling would
prevent sustained idle-zero if enabled, and claims need leases/result retry
protection. No worker-poll traffic appeared in the preceding hour's request
logs; the only observed request in that interval was the preflight health check.

Compendium seeding is detached from startup and has an incomplete-catalog
completion check. Feedback/release Discord webhooks also execute after HTTP
responses; their primary DB records survive but notification delivery is
best-effort. These lifetimes must be handled explicitly, not silently described
as durable background jobs.

## Minimum Safe Prerequisite Release

1. Add versioned, explicitly scoped Postgres runtime persistence. Cover action
   economies, complete condition metadata, monster/class resource budgets,
   turn/round hooks, Mobile targets, and other gameplay fields. Preserve existing
   rule/reset semantics; do not serialize sockets, timers or pending promises.
2. Persist character-scoped XP, forms, wards and feature-use state independently
   of conflicting session snapshots. Reuse/backport already-merged authoritative
   implementations where appropriate. Do not silently invent missing legacy
   counters; specify reconciliation for pre-existing volatile state.
3. Order mutations and await important writes before announcing success. Reject
   stale writers; test DB failure and last-tab disconnect during a save. Preserve
   the requested maxima rather than hiding cross-instance races by reducing them.
4. Use one complete hydration path and a room-generation protocol. Restore spent
   budgets without rerolling/refilling, cancel obsolete timers, and force full
   reconciliation across a cold room or process restart.
5. Make Vertex generation bounded and request-bound, or use durable task delivery
   with attempt-fenced results/recovery. Do not leave model work running solely
   on CPU available after a 202 response. Handle startup/notification work too.
6. Add bounded shutdown draining as a backup, not the persistence mechanism.
7. Prove full state round-trips through a fresh process against real Postgres,
   including concurrent writes/joins, privacy filtering, cursor reset, job
   interruption and no successful acknowledgement after failed writes.

Related existing backlog: Chronicle reliability #205, authoritative actions
#206, distributed session authority #207. Preserve other Cloud Run limits.

## Eventual Configuration And Verification

After the prerequisites pass, update `deploy.sh` and the service with explicit
`--min=0 --min-instances=0 --cpu-throttling`. Retain CPU, memory, maxima,
concurrency, timeout, affinity, environment, service identity and SQL connection.
Deploy only the reviewed image and verify the complete before/after configuration.

Active WebSockets count as active requests: an open game tab is not an idle
service. Keep the one-hour timeout and test reconnect/rehydration. Don't disconnect
players merely to make a scale-down graph look successful.

For the idle test, close only QA sockets and stop app health polling. Observe
both `active` and `idle` container instance counts through the Monitoring API,
which does not wake the application. Require current zero samples for every
serving/tagged revision, then issue one timed application request and verify a
new instance becomes ready with the stored game intact. Stop requests again
and confirm a second idle-zero period. Keep SQL RUNNABLE throughout.

## Verification This Pass

- Live `/api/health` returned ready, DB OK, compendium ready.
- Live `/readyz` returned HTTP 200; one warm request took about 0.95 seconds
  from this laptop. This is not a cold-start measurement or latency benchmark.
- Monitoring at 10:28 UTC showed active=0, idle=1, consistent with revision min1.
- Local controlled lifecycle probe reproduced runtime state loss at final
  disconnect. Shared package compiled successfully on Node 24.
- Background-worker source probes reproduced fixed idle polling and failed
  result-delivery handling using mocked network calls, not a live worker.
- No deployment, live restart, scale-down or cold-wake test was performed because
  the safety precondition failed. Cold-start impact remains unmeasured. Expect
  additional startup latency for schema/catalog checks and runtime hydration;
  measure it after the safe release rather than guessing a number.

## References

- [Minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances)
- [WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets)
- [Request-based billing](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
- [Container shutdown contract](https://docs.cloud.google.com/run/docs/container-contract)
