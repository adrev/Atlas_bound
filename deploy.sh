#!/bin/bash
# Quick deploy script — builds locally, pushes image, deploys to Cloud Run
# Usage: ./deploy.sh
#
# SECRETS HANDLING
# ----------------
# The PREFERRED long-term approach is to store every secret in Google Secret
# Manager and reference them via `--set-secrets`, which keeps plaintext values
# out of both shell history and the Cloud Run revision spec. Example:
#
#   gcloud run deploy atlas-bound \
#     --set-secrets \
#       "DISCORD_CLIENT_SECRET=discord-client-secret:latest,\
#        GOOGLE_CLIENT_SECRET=google-client-secret:latest,\
#        PGPASSWORD=pg-password:latest" \
#     ...
#
# Until secrets are migrated, we load values from .env and hand them to
# gcloud via a temporary YAML file consumed by `--env-vars-file`. This avoids
# embedding secrets directly on the gcloud command line (where they'd be
# visible in shell history, `ps` output, and CI logs) and also avoids the
# brittle `export $(... | xargs)` pattern (which mangles values containing
# spaces, quotes, `=`, `#`, etc).

set -euo pipefail

# -----------------------------------------------------------------------------
# Safer .env loader: read line-by-line, strip surrounding single/double quotes,
# skip comments and blanks, and do NOT eval anything.
# -----------------------------------------------------------------------------
load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip a leading 'export '
    line="${line#export }"
    # Skip blank lines and comments
    case "$line" in
      ''|'#'*) continue ;;
    esac
    # Must look like KEY=VALUE
    case "$line" in
      *=*) : ;;
      *) continue ;;
    esac
    local key="${line%%=*}"
    local value="${line#*=}"
    # Trim whitespace from the key
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    # Reject keys with characters that aren't valid identifiers
    case "$key" in
      *[!A-Za-z0-9_]*|'') continue ;;
    esac
    # Strip matching surrounding quotes from the value
    if [ "${value#\"}" != "$value" ] && [ "${value%\"}" != "$value" ]; then
      value="${value#\"}"
      value="${value%\"}"
    elif [ "${value#\'}" != "$value" ] && [ "${value%\'}" != "$value" ]; then
      value="${value#\'}"
      value="${value%\'}"
    fi
    # Let explicitly exported shell values win over .env so one-off deploys
    # can target another account/project without editing secret files.
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < "$file"
}

load_env_file .env

# Deployment target. Defaults match the live personal production service.
# Every account/project-specific value can still be overridden from .env or
# the shell before running the script.
PROJECT_ID="${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-${GCLOUD_PROJECT:-atlas-bound-personal}}}"
REGION="${GCP_REGION:-us-central1}"
SERVICE_NAME="${CLOUD_RUN_SERVICE:-atlas-bound}"
ARTIFACT_REPOSITORY="${ARTIFACT_REGISTRY_REPOSITORY:-cloud-run-source-deploy}"
IMAGE_NAME="${CLOUD_RUN_IMAGE_NAME:-$SERVICE_NAME}"
CLOUD_SQL_INSTANCE="${CLOUD_SQL_INSTANCE_NAME:-atlas-bound-db}"
CLOUD_SQL_CONNECTION="${CLOUD_SQL_CONNECTION_NAME:-$PROJECT_ID:$REGION:$CLOUD_SQL_INSTANCE}"
LIVE_SERVICE_JSON=""

load_live_service_json() {
  command -v gcloud >/dev/null 2>&1 || return 0
  LIVE_SERVICE_JSON=$(gcloud run services describe "$SERVICE_NAME" \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --format=json 2>/dev/null || true)
}

live_env_value() {
  local key="$1"
  [ -n "$LIVE_SERVICE_JSON" ] || return 0
  LIVE_SERVICE_JSON="$LIVE_SERVICE_JSON" ENV_KEY="$key" node <<'NODE'
const service = JSON.parse(process.env.LIVE_SERVICE_JSON || '{}');
const key = process.env.ENV_KEY || '';
const env = service.spec?.template?.spec?.containers?.[0]?.env || [];
const found = env.find((entry) => entry.name === key);
process.stdout.write(typeof found?.value === 'string' ? found.value : '');
NODE
}

env_or_live() {
  local key="$1"
  local default_value="${2:-}"
  if [ -n "${!key+x}" ]; then
    printf '%s' "${!key}"
    return
  fi
  local live_value
  live_value="$(live_env_value "$key")"
  if [ -n "$live_value" ]; then
    printf '%s' "$live_value"
    return
  fi
  printf '%s' "$default_value"
}

load_live_service_json

BASE_URL_VALUE="${BASE_URL:-https://dnd.kbrt.ai}"
CORS_ORIGINS_VALUE="${CORS_ORIGINS:-$BASE_URL_VALUE}"
UPLOAD_GCS_BUCKET_VALUE="$(env_or_live UPLOAD_GCS_BUCKET "atlas-bound-data-personal")"
DISCORD_CLIENT_ID_VALUE="$(env_or_live DISCORD_CLIENT_ID)"
DISCORD_CLIENT_SECRET_VALUE="$(env_or_live DISCORD_CLIENT_SECRET)"
GOOGLE_CLIENT_ID_VALUE="$(env_or_live GOOGLE_CLIENT_ID)"
GOOGLE_CLIENT_SECRET_VALUE="$(env_or_live GOOGLE_CLIENT_SECRET)"
APPLE_CLIENT_ID_VALUE="$(env_or_live APPLE_CLIENT_ID)"
APPLE_TEAM_ID_VALUE="$(env_or_live APPLE_TEAM_ID)"
APPLE_KEY_ID_VALUE="$(env_or_live APPLE_KEY_ID)"
APPLE_PRIVATE_KEY_VALUE="$(env_or_live APPLE_PRIVATE_KEY)"
PGPASSWORD_VALUE="$(env_or_live PGPASSWORD)"
ADMIN_USER_IDS_VALUE="$(env_or_live ADMIN_USER_IDS)"
DISCORD_FEEDBACK_WEBHOOK_URL_VALUE="$(env_or_live DISCORD_FEEDBACK_WEBHOOK_URL)"
DISCORD_RELEASES_WEBHOOK_URL_VALUE="$(env_or_live DISCORD_RELEASES_WEBHOOK_URL)"
CHRONICLER_BACKEND_VALUE="$(env_or_live CHRONICLER_BACKEND "vertex")"
CHRONICLE_WORKER_TOKEN_VALUE="$(env_or_live CHRONICLE_WORKER_TOKEN)"

case "$BASE_URL_VALUE" in
  http://localhost*|http://127.*|http://0.0.0.0*|http://\[::1\]*)
    echo "Refusing to deploy with local BASE_URL=$BASE_URL_VALUE" >&2
    echo "Export BASE_URL to the Cloud Run/custom-domain URL before deploying." >&2
    exit 1
    ;;
  https://kbrt.ai|https://kbrt.ai/)
    echo "Refusing to deploy with legacy root BASE_URL=$BASE_URL_VALUE" >&2
    echo "Production OAuth uses https://dnd.kbrt.ai. Export BASE_URL intentionally if this changes." >&2
    exit 1
    ;;
esac

IMAGE_TAG="${CLOUD_RUN_IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || printf 'latest')}"
IMAGE="$REGION-docker.pkg.dev/$PROJECT_ID/$ARTIFACT_REPOSITORY/$IMAGE_NAME:$IMAGE_TAG"

echo "Deploy target: service=$SERVICE_NAME project=$PROJECT_ID region=$REGION"
echo "Image: $IMAGE"
echo "Cloud SQL: $CLOUD_SQL_CONNECTION"
echo "Base URL: $BASE_URL_VALUE"
echo "Upload bucket: ${UPLOAD_GCS_BUCKET_VALUE:-local filesystem fallback}"

# Refuse accidental secret rotation. Local .env files are convenient, but a
# stale .env can overwrite the currently working Cloud Run secrets and create a
# dead revision. Set ALLOW_ENV_SECRET_ROTATION=1 only when intentionally
# changing these values.
check_secret_drift() {
  [ "${ALLOW_ENV_SECRET_ROTATION:-0}" = "1" ] && return 0
  [ -n "$LIVE_SERVICE_JSON" ] || return 0

  local drift
  drift=$(LIVE_SERVICE_JSON="$LIVE_SERVICE_JSON" node <<'NODE'
const service = JSON.parse(process.env.LIVE_SERVICE_JSON || '{}');
const env = service.spec?.template?.spec?.containers?.[0]?.env || [];
const live = Object.fromEntries(env.map((entry) => [entry.name, entry.value || '']));
const keys = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'PGPASSWORD',
  'ADMIN_USER_IDS',
  'DISCORD_FEEDBACK_WEBHOOK_URL',
  'DISCORD_RELEASES_WEBHOOK_URL',
  'CHRONICLE_WORKER_TOKEN',
];
const changed = keys.filter((key) =>
  live[key] && Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] !== live[key]
);
process.stdout.write(changed.join('\n'));
NODE
)

  if [ -n "$drift" ]; then
    echo "Refusing deploy: local env differs from the current Cloud Run secret/config values:" >&2
    echo "$drift" | sed 's/^/  - /' >&2
    echo "Unset stale local values, update .env from the source of truth, or set ALLOW_ENV_SECRET_ROTATION=1 for an intentional rotation." >&2
    exit 1
  fi
}

check_secret_drift

if [ -z "$PGPASSWORD_VALUE" ]; then
  echo "Refusing deploy: PGPASSWORD is missing locally and was not found on the live Cloud Run service." >&2
  echo "Set PGPASSWORD, restore live env access, or complete Secret Manager migration before deploying." >&2
  exit 1
fi

echo "Building Docker image locally..."
docker build --platform linux/amd64 -t "$IMAGE" .

echo "Pushing image to Artifact Registry..."
docker push "$IMAGE"

echo "Deploying to Cloud Run..."

# Write env vars to a temp YAML file so secrets never appear on the gcloud
# command line (and therefore never in shell history). The trap cleans up
# even on failure.
ENV_FILE=$(mktemp -t atlas-env.XXXXXX)
# Restrict to the current user in case mktemp default perms are looser.
chmod 600 "$ENV_FILE"
trap 'rm -f "$ENV_FILE"' EXIT

# gcloud's --env-vars-file expects a flat YAML map: KEY: "value"
# All values are single-line strings; quote-and-escape defensively.
emit_env() {
  local key="$1"
  local value="${2:-}"
  # Escape backslashes and double quotes for YAML double-quoted strings.
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s: "%s"\n' "$key" "$value" >> "$ENV_FILE"
}

: > "$ENV_FILE"
emit_env NODE_ENV               "production"
emit_env BASE_URL                "$BASE_URL_VALUE"
emit_env CORS_ORIGINS            "$CORS_ORIGINS_VALUE"
emit_env DISCORD_CLIENT_ID       "$DISCORD_CLIENT_ID_VALUE"
emit_env DISCORD_CLIENT_SECRET   "$DISCORD_CLIENT_SECRET_VALUE"
emit_env GOOGLE_CLIENT_ID        "$GOOGLE_CLIENT_ID_VALUE"
emit_env GOOGLE_CLIENT_SECRET    "$GOOGLE_CLIENT_SECRET_VALUE"
emit_env APPLE_CLIENT_ID         "$APPLE_CLIENT_ID_VALUE"
emit_env APPLE_TEAM_ID           "$APPLE_TEAM_ID_VALUE"
emit_env APPLE_KEY_ID            "$APPLE_KEY_ID_VALUE"
emit_env APPLE_PRIVATE_KEY       "$APPLE_PRIVATE_KEY_VALUE"
emit_env PGPASSWORD              "$PGPASSWORD_VALUE"
emit_env CLOUD_SQL_CONNECTION_NAME "$CLOUD_SQL_CONNECTION"
emit_env GCP_PROJECT_ID          "$PROJECT_ID"
emit_env UPLOAD_GCS_BUCKET       "$UPLOAD_GCS_BUCKET_VALUE"
# ADMIN_USER_IDS: comma-separated list of user ids/emails allowed to hit
# admin-only endpoints (compendium sync/upload). Empty in production refuses
# admin access — set this before deploying if admin endpoints are needed.
emit_env ADMIN_USER_IDS          "$ADMIN_USER_IDS_VALUE"
# DISCORD_FEEDBACK_WEBHOOK_URL: when set, every successful POST to
# /api/feedback fires a Discord embed to this webhook. Optional — if
# unset the notifier silently no-ops and feedback still lands in the DB.
emit_env DISCORD_FEEDBACK_WEBHOOK_URL "$DISCORD_FEEDBACK_WEBHOOK_URL_VALUE"

# DISCORD_RELEASES_WEBHOOK_URL: when an admin publishes a patch-kind
# Tiding via /admin/tidings, an embed is posted to this webhook (a
# dedicated #releases forum). Patch tidings include back-links to any
# user-feedback threads they reference. Optional; the lobby Tidings
# rail still publishes when this is unset.
emit_env DISCORD_RELEASES_WEBHOOK_URL "$DISCORD_RELEASES_WEBHOOK_URL_VALUE"

# CHRONICLER_BACKEND: which inference path Chronicle uses.
#   'vertex' (default) → inline Vertex AI Gemini 2.5 Flash-Lite call
#   'ollama'           → route is a no-op; the on-prem dgx-worker
#                        polls /api/internal/chronicle/jobs/claim and
#                        runs gemma4:26b locally on the GB10
emit_env CHRONICLER_BACKEND "$CHRONICLER_BACKEND_VALUE"

# CHRONICLE_WORKER_TOKEN: shared secret used by the on-prem
# dgx-worker to authenticate against /api/internal/chronicle/*.
# Must match the value in worker.env on the DGX. Empty = internal
# endpoints return 503 (failsafe — no anonymous worker access).
emit_env CHRONICLE_WORKER_TOKEN "$CHRONICLE_WORKER_TOKEN_VALUE"

gcloud run deploy "$SERVICE_NAME" \
  --image "$IMAGE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 3 \
  --session-affinity \
  --timeout 3600 \
  --add-cloudsql-instances "$CLOUD_SQL_CONNECTION" \
  --env-vars-file "$ENV_FILE"

echo "Deployed! $BASE_URL_VALUE"
