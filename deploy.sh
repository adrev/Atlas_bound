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
    export "$key=$value"
  done < "$file"
}

load_env_file .env

IMAGE="us-central1-docker.pkg.dev/atlas-bound-personal/cloud-run-source-deploy/atlas-bound:latest"

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
emit_env BASE_URL                "https://dnd.kbrt.ai"
emit_env CORS_ORIGINS            "https://dnd.kbrt.ai"
emit_env DISCORD_CLIENT_ID       "${DISCORD_CLIENT_ID:-}"
emit_env DISCORD_CLIENT_SECRET   "${DISCORD_CLIENT_SECRET:-}"
emit_env GOOGLE_CLIENT_ID        "${GOOGLE_CLIENT_ID:-}"
emit_env GOOGLE_CLIENT_SECRET    "${GOOGLE_CLIENT_SECRET:-}"
emit_env PGPASSWORD              "${PGPASSWORD:-}"
emit_env CLOUD_SQL_CONNECTION_NAME "atlas-bound-personal:us-central1:atlas-bound-db"
# ADMIN_USER_IDS: comma-separated list of user ids/emails allowed to hit
# admin-only endpoints (compendium sync/upload). Empty in production refuses
# admin access — set this before deploying if admin endpoints are needed.
emit_env ADMIN_USER_IDS          "${ADMIN_USER_IDS:-}"
# DISCORD_FEEDBACK_WEBHOOK_URL: when set, every successful POST to
# /api/feedback fires a Discord embed to this webhook. Optional — if
# unset the notifier silently no-ops and feedback still lands in the DB.
emit_env DISCORD_FEEDBACK_WEBHOOK_URL "${DISCORD_FEEDBACK_WEBHOOK_URL:-}"

# DISCORD_RELEASES_WEBHOOK_URL: when an admin publishes a patch-kind
# Tiding via /admin/tidings, an embed is posted to this webhook (a
# dedicated #releases forum). Patch tidings include back-links to any
# user-feedback threads they reference. Optional; the lobby Tidings
# rail still publishes when this is unset.
emit_env DISCORD_RELEASES_WEBHOOK_URL "${DISCORD_RELEASES_WEBHOOK_URL:-}"

# CHRONICLER_BACKEND: which inference path Chronicle uses.
#   'vertex' (default) → inline Vertex AI Gemini 2.5 Flash-Lite call
#   'ollama'           → route is a no-op; the on-prem dgx-worker
#                        polls /api/internal/chronicle/jobs/claim and
#                        runs gemma4:26b locally on the GB10
emit_env CHRONICLER_BACKEND "${CHRONICLER_BACKEND:-vertex}"

# CHRONICLE_WORKER_TOKEN: shared secret used by the on-prem
# dgx-worker to authenticate against /api/internal/chronicle/*.
# Must match the value in worker.env on the DGX. Empty = internal
# endpoints return 503 (failsafe — no anonymous worker access).
emit_env CHRONICLE_WORKER_TOKEN "${CHRONICLE_WORKER_TOKEN:-}"

gcloud run deploy atlas-bound \
  --image "$IMAGE" \
  --project atlas-bound-personal \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 3 \
  --session-affinity \
  --timeout 3600 \
  --add-cloudsql-instances atlas-bound-personal:us-central1:atlas-bound-db \
  --env-vars-file "$ENV_FILE"

echo "Deployed! https://dnd.kbrt.ai"
