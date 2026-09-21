#!/bin/bash
# Existing-service candidate deployment. Never reads .env or promotes traffic.
# Usage: ./deploy.sh [--image IMAGE] [--env-updates changes.json]
# New services must be initialized separately with explicit configuration.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
ENV_UPDATES="-"
IMAGE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --image|--env-updates)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 1; }
      if [ "$1" = "--image" ]; then IMAGE="$2"; else ENV_UPDATES="$2"; fi
      shift 2 ;;
    *) echo "Usage: $0 [--image IMAGE] [--env-updates changes.json]" >&2; exit 1 ;;
  esac
done

PROJECT_ID="${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-${GCLOUD_PROJECT:-atlas-bound-personal}}}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${CLOUD_RUN_SERVICE:-atlas-bound}"
ARTIFACT_REPOSITORY="${ARTIFACT_REGISTRY_REPOSITORY:-cloud-run-source-deploy}"
IMAGE_NAME="${CLOUD_RUN_IMAGE_NAME:-$SERVICE_NAME}"
TEMP_DIR=$(mktemp -d -t atlas-deploy.XXXXXX)
trap 'rm -rf "$TEMP_DIR"' EXIT
BEFORE="$TEMP_DIR/before.json"
describe_service() {
  gcloud run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format=json
}
# Permission/network errors MUST NOT fall back to guessed new-service settings.
describe_service > "$BEFORE"
node scripts/deploy-config.mjs plan "$BEFORE" "$ENV_UPDATES" "$TEMP_DIR/flags.json"
echo "Candidate target: service=$SERVICE_NAME project=$PROJECT_ID region=$REGION"
echo "Preserving existing environment (including Secret Manager references), resources, identity, SQL, affinity and timeout."
echo "No traffic promotion. Main legacy adoption requires a separately reviewed, quiescent cutover."

if [ -z "$IMAGE" ]; then
  IMAGE_TAG="${CLOUD_RUN_IMAGE_TAG:-$(git rev-parse --short HEAD)}"
  IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$ARTIFACT_REPOSITORY/$IMAGE_NAME:$IMAGE_TAG"
  docker build --platform linux/amd64 -t "$IMAGE" .
  docker push "$IMAGE"
fi

# Abort if another operator changed configuration or traffic during the build.
describe_service > "$TEMP_DIR/predeploy.json"
node scripts/deploy-config.mjs unchanged "$BEFORE" "$TEMP_DIR/predeploy.json" -
# Omission, not an allowlist copy, preserves unknown env keys and valueFrom
# references. Only explicit JSON updates produce environment mutation flags.
gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --min 0 \
  --min-instances 0 \
  --cpu-throttling \
  --no-traffic \
  --flags-file "$TEMP_DIR/flags.json"
describe_service > "$TEMP_DIR/after.json"
node scripts/deploy-config.mjs deployed "$BEFORE" "$TEMP_DIR/after.json" "$ENV_UPDATES"
echo "Candidate deployed with configuration verified and existing traffic retained. Promotion is a separate reviewed action."
