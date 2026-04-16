#!/usr/bin/env bash
# Generate JPEG thumbnails for every prebuilt map and upload them to GCS.
#
# Why a separate thumbnail tier? The full map PNGs are 1.2-3 MB each.
# The PrebuiltMapGallery + Scene Manager sidebar render them at
# 260x160 (gallery card) or 68x46 (Scene Manager row). Loading the
# full PNG just for a tiny thumbnail wastes ~30+ MB of bandwidth on a
# fresh gallery view. 480x270 JPEGs land at ~40 KB each, so 80 maps is
# 3.2 MB total — a 10x reduction.
#
# Run this once after uploading new map artwork. The script:
#   1. Downloads each PNG from gs://atlas-bound-data/maps/ to a temp dir
#   2. Generates a 480-pixel-wide JPEG (quality 80) using sips
#   3. Uploads to gs://atlas-bound-data/maps/thumbnails/{id}.jpg
#
# Requires: macOS (sips), gsutil, curl

set -euo pipefail

BUCKET="gs://atlas-bound-data/maps"
THUMBS_PREFIX="${BUCKET}/thumbnails"
TMP_DIR="$(mktemp -d -t map-thumbs.XXXXXX)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "→ Listing source maps in ${BUCKET}/"
mapfile -t SOURCES < <(gsutil ls "${BUCKET}/*.png" | sort)

echo "→ Found ${#SOURCES[@]} maps. Generating thumbnails..."

for src in "${SOURCES[@]}"; do
  filename="$(basename "${src}")"
  id="${filename%.png}"
  thumb_path="${TMP_DIR}/${id}.jpg"
  echo "  ${id}"
  # Download → resize to 480 wide (sips preserves aspect) → JPEG quality 80
  gsutil -q cp "${src}" "${TMP_DIR}/${id}.png"
  sips --setProperty format jpeg \
       --setProperty formatOptions 80 \
       --resampleWidth 480 \
       "${TMP_DIR}/${id}.png" \
       --out "${thumb_path}" >/dev/null
  rm -f "${TMP_DIR}/${id}.png"
done

echo "→ Uploading ${#SOURCES[@]} thumbnails to ${THUMBS_PREFIX}/"
# rsync deletes thumbnails for maps that no longer exist on GCS so the
# tier doesn't drift over time.
gsutil -m -q rsync -d -j jpg "${TMP_DIR}" "${THUMBS_PREFIX}/"

echo "✓ Done. Verify at:"
echo "  https://storage.googleapis.com/atlas-bound-data/maps/thumbnails/forest-fork.jpg"
