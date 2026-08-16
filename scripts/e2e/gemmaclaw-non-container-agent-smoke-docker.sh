#!/usr/bin/env bash
# Runs the Gemmaclaw --no-container live smoke inside an outer Docker container.
# This validates the direct-host execution path without giving it Frank's real
# host as the host.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="${GEMMACLAW_NON_CONTAINER_AGENT_SMOKE_IMAGE:-node:22-bookworm}"
BACKEND="${GEMMACLAW_LOCAL_AGENT_SMOKE_BACKEND:-llama-cpp}"
MODEL="${GEMMACLAW_LOCAL_AGENT_SMOKE_MODEL:-gemma-4-26B-A4B-it-Q4_K_M}"
OLLAMA_URL="${GEMMACLAW_LOCAL_AGENT_SMOKE_OLLAMA_URL:-http://127.0.0.1:11434}"
LLAMA_CPP_URL="${GEMMACLAW_LOCAL_AGENT_SMOKE_LLAMA_CPP_URL:-http://127.0.0.1:8080}"
REQUIRED="${GEMMACLAW_LOCAL_AGENT_SMOKE_REQUIRED:-0}"
ALLOW_DURING_BENCHMARK="${GEMMACLAW_LOCAL_AGENT_SMOKE_ALLOW_DURING_BENCHMARK:-0}"

skip_or_fail() {
  local message="$1"
  if [ "$REQUIRED" = "1" ]; then
    echo "FAIL: $message" >&2
    exit 1
  fi
  echo "SKIP: $message"
  exit 0
}

if ! command -v docker >/dev/null 2>&1; then
  skip_or_fail "Docker is required for the non-container outer smoke"
fi
if ! docker info >/dev/null 2>&1; then
  skip_or_fail "Docker daemon is not reachable"
fi

if [ "$ALLOW_DURING_BENCHMARK" != "1" ]; then
  if pgrep -af 'pnpm benchmark agent|src/gemmaclaw/benchmark/cli-standalone.ts agent' >/dev/null 2>&1; then
    skip_or_fail "an Ollama/Gemmaclaw benchmark is active; local-model smoke would disturb the loaded model"
  fi
fi

HOST_BACKEND="$BACKEND" HOST_OLLAMA_URL="$OLLAMA_URL" HOST_LLAMA_CPP_URL="$LLAMA_CPP_URL" HOST_MODEL="$MODEL" node <<'NODE' || skip_or_fail "${BACKEND} model ${MODEL} is not ready"
const backend = process.env.HOST_BACKEND;
const base = backend === "llama-cpp" ? process.env.HOST_LLAMA_CPP_URL : process.env.HOST_OLLAMA_URL;
const model = process.env.HOST_MODEL;
const endpoint = backend === "llama-cpp" ? `${base}/v1/models` : `${base}/api/tags`;
const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
if (!res.ok) {
  throw new Error(`${backend} model listing failed: HTTP ${res.status}`);
}
const data = await res.json();
const names = backend === "llama-cpp"
  ? new Set((data.data ?? []).map((m) => m.id))
  : new Set((data.models ?? []).map((m) => m.name));
if (!names.has(model) && !names.has(`${model}:latest`)) {
  throw new Error(`Model not found: ${model}`);
}
NODE

HOST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gemmaclaw-non-container-host.XXXXXX")"
HOST_SENTINEL="$HOST_ROOT/sentinel.txt"
HOST_MARKER="$HOST_ROOT/container-write-marker.txt"
NODE_MODULES_DIR="$(readlink -f "$ROOT_DIR/node_modules")"
printf 'HOST_SENTINEL_ORIGINAL\n' > "$HOST_SENTINEL"

if [ ! -d "$NODE_MODULES_DIR" ]; then
  skip_or_fail "repository dependencies are missing. Run pnpm install before the smoke"
fi

cleanup() {
  local status=$?
  if command -v docker >/dev/null 2>&1; then
    local uid gid
    uid="$(id -u)"
    gid="$(id -g)"
    docker run --rm -v "$ROOT_DIR:/repo" debian:bookworm-slim \
      sh -lc "chown -R $uid:$gid /repo/dist /repo/dist-runtime /repo/.artifacts 2>/dev/null || true" \
      >/dev/null 2>&1 || true
  fi
  if [ "$status" -eq 0 ]; then
    rm -rf "$HOST_ROOT"
  else
    echo "Preserving failed host sentinel artifacts at $HOST_ROOT" >&2
  fi
}
trap cleanup EXIT

docker run --rm -i \
  --add-host=host.docker.internal:host-gateway \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_FLOW=non-container \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_REQUIRED="$REQUIRED" \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_BACKEND="$BACKEND" \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_MODEL="$MODEL" \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_OLLAMA_URL=http://host.docker.internal:11434 \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_LLAMA_CPP_URL=http://host.docker.internal:8080 \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_HOST_SENTINEL_PATH="$HOST_SENTINEL" \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_HOST_MARKER_PATH="$HOST_MARKER" \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_SKIP_BENCHMARK_GUARD=1 \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_TIMEOUT="${GEMMACLAW_LOCAL_AGENT_SMOKE_TIMEOUT:-1200}" \
  -e GEMMACLAW_LOCAL_AGENT_SMOKE_THINKING="${GEMMACLAW_LOCAL_AGENT_SMOKE_THINKING:-off}" \
  -v "$ROOT_DIR:/repo" \
  -v "$NODE_MODULES_DIR:/repo/node_modules:ro" \
  -w /repo \
  "$IMAGE" \
  bash -lc 'printf '"'"'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n'"'"' > /etc/apt/apt.conf.d/99gemmaclaw-network-retries; printf '"'"'#!/bin/sh\napt-get "$@"\nstatus=$?\nif [ "$status" -eq 0 ]; then exit 0; fi\nexec apt-get -o Acquire::ForceIPv4=true "$@"\n'"'"' > /usr/local/bin/apt-get-retry; chmod 755 /usr/local/bin/apt-get-retry; apt-get-retry update >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get-retry install -y ca-certificates curl git >/dev/null && corepack enable >/dev/null 2>&1 || true; bash scripts/e2e/gemmaclaw-local-agent-smoke.sh'

if [ "$(cat "$HOST_SENTINEL")" != "HOST_SENTINEL_ORIGINAL" ]; then
  echo "FAIL: outer-host sentinel was modified" >&2
  exit 1
fi
if [ -e "$HOST_MARKER" ]; then
  echo "FAIL: non-container inner flow wrote outside the mounted repo into the outer host" >&2
  exit 1
fi

echo "==> Gemmaclaw non-container outer-Docker smoke passed."
