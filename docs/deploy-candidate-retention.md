# Candidate deployment configuration contract

`deploy.sh` now updates **existing single-container services only** and always
passes `--no-traffic`. New services require a separate explicit initialization.
It never reads `.env`, changes IAM, promotes traffic, or approves data migration.
Target selection still accepts explicitly exported project/region/service values.

The default operation changes the image and enforces service minimum 0, revision
minimum 0, and request-based CPU allocation. It omits all environment/resource
replacement flags, preserving unknown environment keys, literal values, Secret
Manager reference identity, CPU/memory/max-instance limits, Cloud SQL attachments,
service identity, session affinity, concurrency, and timeout.

Use `--env-updates changes.json` only for reviewed, intentional updates. The file
is a JSON object: a string sets one literal value, `{ "secret": "name", "version":
"7" }` sets a same-project Secret Manager reference, and `null` removes that key.
Unlisted entries are preserved. Values are passed in a restricted temporary
flags file, not shell arguments. Neither script nor verifier prints values.
Local `.env` content is never an implicit rotation instruction.

`--image IMAGE` uses an already-built image; otherwise the script builds and
pushes locally. Tags are resolved through Artifact Registry to an immutable
digest before deploying. An explicit unique revision suffix binds this run to
one candidate; both the deployment response and final service read must match
that exact revision and digest, including when another no-traffic candidate
has identical configuration. Before build, immediately before deploy, and after deploy, it
reads service configuration. A changed baseline aborts before deploy. Unexpected
post-deploy environment/reference/resource/traffic differences fail verification
without promotion. Fingerprints and changed sections, not secrets, are logged.
Cloud Run's resolved revision traffic must remain unchanged. Review IAM policy
separately if other operators may mutate it; this script makes no IAM calls.

No-traffic is not a database isolation boundary. A main image can start against
the production database before receiving traffic. The main compatibility
migration therefore fails closed on any pre-existing legacy runtime table until
a separately reviewed quiescent cutover. The candidate script refuses both new
and inherited `ATLAS_LEGACY_FEATURE_CUTOVER` environment settings. Never use this
script to approve that migration or treat a green candidate as approval to ship
unreleased main. Promotion and main cutover remain separate human decisions.

Verification is local: configuration-fixture regression tests, shell syntax,
and installed gcloud flag documentation. No Cloud Run deployment was performed
for this change. A future release still needs actual before/after verification.
