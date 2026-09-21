# Scale-zero forward port to main

This worktree is an integration candidate, not a production release. No cloud
resources were changed, no image was deployed, and no PR was merged. Publishing
the requested draft PR does not authorize deployment or the data cutover.

## Inputs

- Main base: `5b0f2c62d0c33ded278587692b81575595483eff`.
- Production persistence change: `41eea57928f80c5c99e193c90c5d7fce67993d3c`.
- Docker source exclusion: `a0d7d92ced587af4e5a0f640f77c6a1c3cdc34df`.
- Fully hoisted dependency directory fix: `ffe5d2289835151dacd45b001e8c11937e295075`.
- Condition-source hydration, superiority die, and scaling gate follow-up: `f37c6cb9e401c765d940702ced9c3984d7d25095`.
- Branch: `codex/scale-zero-main`.

## Resolution policy

Main's SQL-backed XP, Wild Shape, Lucky, Ki, Sorcery Points, racial charges,
Channel Divinity, version guards, and private stat/sheet fanout remain
authoritative. Legacy feature namespaces are retained for audit and adopted once
only at the explicit, gated cutover described below; existing canonical values
win. Remaining process-local feature pools use
the production transaction-scoped persistence implementation.

Generation-aware reconnects and snapshots retain main's redaction metadata and
private character-cache replacement. A legacy zero cursor still skips history;
new clients may poll zero only after acquiring an authoritative snapshot baseline.
Pending opportunity-attack claims preserve their original ID and issuance time,
including consumption and TTL checks; old production snapshots have no claims.
Encounter start/end now clears outstanding claims so a cold restore cannot carry
an encounter-A prompt into encounter B. Hydration and encounter initialization
share the same Tough/exhaustion HP calculation, without double-applying DDB Tough.
Privacy settings reload from SQL instead of staying local to the join process.

Main's sheet-edit fanout needed an additional integration adaptation. Runtime
transactions lock referenced character rows in stable ID order, then reconcile
derived combat stats from SQL. This prevents a stale checkpoint from overwriting
a newer REST edit, including a crash between the edit and fanout. Cross-room
fanout goes through each room's transaction and rereads current SQL state. Socket
follow-up fanout is scheduled after commit without awaiting another room while
holding the originating room queue. A failed follow-up logs and remains repairable
by normal authoritative hydration; it cannot undo the committed character row.

## Verification

Using local Node 24.19.0 and the loopback-only PostgreSQL QA container with
per-suite disposable schemas:

- Full combined suite: 167 files, 2,106 tests passed, zero skipped.
- Production build passed for shared, client, and server.
- ESLint passed with zero warnings.
- Chronicle worker protocol: 8/8 tests passed separately.
- No cloud, OAuth, external storage, or production smoke testing was performed.

One full run during concurrent build activity had a transient socket hangup in
the existing Chronicle token-gate test. The complete final rerun passed without
source changes to that test. Independent read-only review found no remaining
blocker in the requested runtime and deploy-verification areas; that reviewer
did not independently rerun tests.

The added integration regressions execute real XP, Wild Shape, Lucky, Ki, SP,
racial, and superiority commands concurrently across sessions and cold processes.
They cover SQL resource precedence over stale legacy namespaces, nested XP
savepoint commits with swallowed-error rollback/no delivery,
REST character edit serialization, cold combat/stat recovery, privacy refresh,
pending OA identity/expiry/consumption/encounter boundaries, and replay redaction.
Eighteen real-PG upgrade cases cover schema provenance, ordinary-startup refusal,
concurrent adoption, canonical zero/inactive/counter precedence, late first
writers, rollback, strict superiority schema, trusted Moon/CR/movement eligibility,
and unknown Wild Shape history remaining exhausted until an actual normal rest.

Deploy-only commits `bb85337`, `3d1e7e1`, and `932e5e2` contain no runtime changes
and can be cherry-picked in that order independently. Their 18 tests include isolated mock
CLI execution with actual JSON map/list flags, env/reference preservation,
unchanged traffic, and pre/postdeploy candidate image/revision rejection. Tags
are pinned to immutable digests, and both the deploy response and final service
read must match the explicit expected revision and image. Installed
gcloud help confirmed flags-file JSON syntax; no real service was deployed.

## Future main rollout gate

Do not treat a green integration build as approval to deploy unreleased main.
The production branch and main intentionally have different resource models.
No-traffic is not database isolation. Normal main startup refuses an existing
`character_feature_runtime` table without explicit quiesced-cutover approval,
even if the table is empty or contains no retired keys. No column defaults or
completion marker are committed on that refusal.

The controlled upgrade captures XP/Wild Shape column presence before schema DDL,
then adopts validated legacy values under one transaction and advisory lock.
Pre-existing XP (including zero), Wild Shape (including NULL/inactive), and
explicit feature counters win. The completion marker prevents re-adoption after
canonical clear. Original legacy JSON remains intact for audit. A database
INSERT/UPDATE fence rejects further legacy XP/form/Lucky/Ki/SP/racial writes,
including a late first writer; retained features such as superiority still work.

Active legacy forms must identify exactly one trusted Beast and match its saved
max HP/AC/speed, Druid eligibility, Moon CR cap, and swim/fly restrictions. Spent
form HP is preserved. Invalid/ambiguous forms, unsupported XP, missing Lucky feat,
or incompatible resource state abort the entire upgrade for explicit repair.
Eligible legacy Druids with unknown charge history get zero uses until a normal
rest, including reverted/depleted forms and characters without a runtime row.
This is deliberate conservative reconciliation, not an assertion of known usage.

Required future release procedure, **not authorized or executed by this task**:

1. Review the migration independently and test against an isolated restored
   database copy. Run `node server/dist/scripts/legacyFeatureCutover.js --preflight`
   with that copy's explicit DB configuration. It exercises DDL/adoption/fence and
   rolls everything back. It takes locks: do not run it against live writers.
2. Resolve every incompatible row under a reviewed data-reconciliation plan.
   Preserve a verified backup and a reverse-migration/rollback plan.
3. Drain and stop ALL legacy revisions, tagged URLs, sockets, background jobs,
   and other writers. Maintenance is required; overlapping resource writers are
   not supported. The post-cutover fence is a safety net, not a traffic switch.
4. In a standalone operator process only, run
   `ATLAS_LEGACY_FEATURE_CUTOVER=quiesced-v1 node server/dist/scripts/legacyFeatureCutover.js --apply`.
   Never persist this approval in the service env. The deploy script refuses it.
5. Start/review the main candidate, compare configuration and traffic, run the
   approved QA, and make a separate promotion decision. An old image is NOT a
   safe rollback after canonical mutations: its retired writes are fenced and
   its stored legacy values are intentionally no longer current.

Main remains a draft integration candidate until independent review and that
operational cutover are approved. No live data inventory or reconciliation was
performed. The production branch continues independently.
