#!/usr/bin/env bash
# Required pre-merge live smoke for Gemmaclaw setup/runtime PRs.
#
# Runs two local-model flows:
#   1. container: setup with Gemmaclaw Docker tool sandbox enabled.
#   2. non-container: setup --no-container inside an outer Docker container.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

export GEMMACLAW_LOCAL_AGENT_SMOKE_REQUIRED="${GEMMACLAW_LOCAL_AGENT_SMOKE_REQUIRED:-1}"
export GEMMACLAW_LOCAL_AGENT_SMOKE_BACKEND="${GEMMACLAW_LOCAL_AGENT_SMOKE_BACKEND:-llama-cpp}"
export GEMMACLAW_LOCAL_AGENT_SMOKE_MODEL="${GEMMACLAW_LOCAL_AGENT_SMOKE_MODEL:-gemma-4-26B-A4B-it-Q4_K_M}"

echo "==> Building current Gemmaclaw source for setup live smoke"
pnpm build

echo "==> Gemmaclaw setup live smoke: container flow"
GEMMACLAW_LOCAL_AGENT_SMOKE_FLOW=container \
  bash scripts/e2e/gemmaclaw-local-agent-smoke.sh

echo "==> Gemmaclaw setup live smoke: non-container flow inside outer Docker"
bash scripts/e2e/gemmaclaw-non-container-agent-smoke-docker.sh

echo "==> Gemmaclaw setup live smoke complete."
