#!/usr/bin/env bash
# Build (or reuse) the Gemmaclaw onboarding e2e image and run the suite of
# wizard scenarios inside it. The actual scenarios live in
# scripts/e2e/onboard-gemma-cases.sh and execute against a freshly built CLI
# in dry-run mode (no model downloads, no gateway start).
#
# Usage:
#   bash scripts/e2e/onboard-gemma-docker.sh                 # all cases
#   bash scripts/e2e/onboard-gemma-docker.sh local-default
#   bash scripts/e2e/onboard-gemma-docker.sh gemini-non-interactive
#
# Env:
#   OPENCLAW_ONBOARD_GEMMA_E2E_IMAGE  override docker tag (default
#                                     gemmaclaw-onboard-gemma-e2e:local)
#   OPENCLAW_ONBOARD_GEMMA_SKIP_BUILD if "1", reuse existing image without
#                                     rebuilding (CI sometimes caches images)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${OPENCLAW_ONBOARD_GEMMA_E2E_IMAGE:-gemmaclaw-onboard-gemma-e2e:local}"

if [ "${OPENCLAW_ONBOARD_GEMMA_SKIP_BUILD:-0}" != "1" ]; then
  echo "==> Building $IMAGE_NAME from test/e2e/Dockerfile.onboard-gemma..."
  docker build -f "$ROOT_DIR/test/e2e/Dockerfile.onboard-gemma" -t "$IMAGE_NAME" "$ROOT_DIR"
fi

cases=("$@")
if [ "${#cases[@]}" -eq 0 ]; then
  cases=("all")
fi

echo "==> Running onboarding e2e cases: ${cases[*]}"
docker run --rm -i \
  -e OPENCLAW_SETUP_DRY_RUN=1 \
  -e CI=1 \
  "$IMAGE_NAME" "${cases[@]}"

echo "==> Onboarding e2e complete."
