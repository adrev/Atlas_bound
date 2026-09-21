# Scale-zero forward port to main

This worktree is an integration candidate, not a production release. No cloud
resources were changed, no image was deployed, and no PR was created or merged.

## Inputs

- Main base: `5b0f2c62d0c33ded278587692b81575595483eff`.
- Production persistence change: `41eea57928f80c5c99e193c90c5d7fce67993d3c`.
- Docker source exclusion: `a0d7d92ced587af4e5a0f640f77c6a1c3cdc34df`.
- Fully hoisted dependency directory fix: `ffe5d2289835151dacd45b001e8c11937e295075`.
- Branch: `codex/scale-zero-main`.

## Resolution policy

Main's SQL-backed XP, Wild Shape, Lucky, Ki, Sorcery Points, racial charges,
Channel Divinity, version guards, and private stat/sheet fanout remain
authoritative. Legacy feature namespaces are retained as stored data, not used
to override those implementations. Remaining process-local feature pools use
the production transaction-scoped persistence implementation.

Generation-aware reconnects and snapshots retain main's redaction metadata and
private character-cache replacement. A legacy zero cursor still skips history;
new clients may poll zero only after acquiring an authoritative snapshot baseline.
Pending opportunity-attack claims preserve their original ID and issuance time,
including consumption and TTL checks; old production snapshots have no claims.
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

- Full combined suite: 163 files, 2,057 tests passed, zero skipped.
- Production build passed for shared, client, and server.
- ESLint passed with zero warnings.
- No cloud, OAuth, external storage, or production smoke testing was performed.

The added integration regressions cover SQL resource precedence over stale legacy
namespaces, nested XP savepoint commits with swallowed-error rollback/no delivery,
REST character edit serialization, cold combat/stat recovery, privacy refresh,
pending OA identity/expiry/consumption, and persisted replay redaction metadata.

## Future main rollout gate

Do not treat a green integration build as approval to deploy unreleased main.
The production branch and main intentionally have different resource models.
Before a future main rollout, inventory any populated legacy `xp`, `wildShape`,
`luckPoints`, or Ki/Sorcery point-pool namespaces in `character_feature_runtime`
and reconcile them with `characters.experience`, `characters.wild_shape`, and
server-managed `characters.features` under a reviewed cutover plan.

This merge does not auto-copy legacy pools into SQL: doing that on hydration
could restore spent resources or overwrite a newer authoritative sheet. An
active legacy Wild Shape also lacks the trusted compendium identity required by
main and cannot safely be converted just by renaming JSON keys. If these legacy
namespaces are populated, migration or explicit DM reconciliation is a rollout
blocker, not a reason to reinstate the old handlers. Their presence in production
was not inspected during this local-only integration.
