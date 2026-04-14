#!/bin/bash
# Quick deploy script — builds locally, pushes image, deploys to Cloud Run
# Usage: ./deploy.sh

set -e

# Load secrets from .env (not committed to git)
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

IMAGE="us-central1-docker.pkg.dev/atlas-bound/cloud-run-source-deploy/atlas-bound:latest"

echo "🔨 Building Docker image locally..."
docker build --platform linux/amd64 -t "$IMAGE" .

echo "📤 Pushing image to Artifact Registry..."
docker push "$IMAGE"

echo "🚀 Deploying to Cloud Run..."

# Write env vars to a temporary YAML file (avoids exposing secrets in shell history)
ENV_FILE=$(mktemp)
cat > "$ENV_FILE" <<ENVEOF
NODE_ENV: production
BASE_URL: https://kbrt.ai
CORS_ORIGINS: https://kbrt.ai
DISCORD_CLIENT_ID: ${DISCORD_CLIENT_ID}
DISCORD_CLIENT_SECRET: ${DISCORD_CLIENT_SECRET}
GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
PGPASSWORD: ${PGPASSWORD}
CLOUD_SQL_CONNECTION_NAME: atlas-bound:us-central1:atlas-bound-db
ENVEOF

gcloud run deploy atlas-bound \
  --image "$IMAGE" \
  --project atlas-bound \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 3 \
  --session-affinity \
  --timeout 3600 \
  --add-cloudsql-instances atlas-bound:us-central1:atlas-bound-db \
  --env-vars-file "$ENV_FILE"

# Clean up temporary env file
rm -f "$ENV_FILE"

echo "✅ Deployed! https://kbrt.ai"
