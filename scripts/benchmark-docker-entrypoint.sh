#!/bin/bash
set -euo pipefail

echo "========================================"
echo "  Gemmaclaw Benchmark (Docker)"
echo "========================================"
echo ""

export GEMMACLAW_BENCHMARK_CONTAINER=1
OLLAMA_PID=""

# Extract --model from args, default gemma3:1b.
MODEL="${BENCHMARK_MODEL:-gemma3:1b}"
prev_was_model=0
for arg in "$@"; do
  if [ "$prev_was_model" = "1" ]; then
    MODEL="$arg"
    break
  fi
  prev_was_model=0
  if [ "$arg" = "--model" ]; then
    prev_was_model=1
  fi
done

IS_AGENT=0
for arg in "$@"; do
  if [ "$arg" = "agent" ]; then
    IS_AGENT=1
    break
  fi
done

# ---------------------------------------------------------------------------
# 1. Start Ollama
# ---------------------------------------------------------------------------
if [ "$IS_AGENT" != "1" ]; then
  echo "[1/3] Starting Ollama server..."
  ollama serve &
  OLLAMA_PID=$!

  echo "[2/3] Waiting for Ollama..."
  for i in $(seq 1 60); do
    if curl -s http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      echo "  Ollama ready after ${i}s"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "ERROR: Ollama failed to start after 60s"
      exit 1
    fi
    sleep 1
  done
else
  echo "[1/3] Agent mode: using host Ollama, not container-local Ollama"
  echo "[2/3] Skipping container-local Ollama startup"
fi

# ---------------------------------------------------------------------------
# 2. Pull model for local benchmark modes only. Agent mode must use the host
# model cache so one-container-per-task runs do not redownload large models.
# ---------------------------------------------------------------------------
if [ "$IS_AGENT" != "1" ]; then
  echo "[3/3] Pulling model: $MODEL"
  ollama pull "$MODEL"
else
  echo "[3/3] Agent mode: skipping container-local model pull for $MODEL"
fi

cleanup_ollama() {
  if [ -n "${OLLAMA_PID:-}" ]; then
    kill "$OLLAMA_PID" 2>/dev/null || true
  fi
}

fix_results_owner() {
  if [ -n "${GEMMACLAW_BENCHMARK_HOST_UID:-}" ] && [ -n "${GEMMACLAW_BENCHMARK_HOST_GID:-}" ]; then
    chown -R "$GEMMACLAW_BENCHMARK_HOST_UID:$GEMMACLAW_BENCHMARK_HOST_GID" /results 2>/dev/null || true
  fi
}

trap fix_results_owner EXIT

# ---------------------------------------------------------------------------
# 3. Sandbox mode: read the user-supplied file
# ---------------------------------------------------------------------------
if [ "${BENCHMARK_SANDBOX:-0}" = "1" ]; then
  BENCHMARK_FILE="${BENCHMARK_FILE:-}"
  if [ -z "$BENCHMARK_FILE" ]; then
    echo "ERROR: BENCHMARK_FILE must be set in sandbox mode"
    exit 1
  fi
  if [ ! -f "$BENCHMARK_FILE" ]; then
    echo "ERROR: File not found: $BENCHMARK_FILE"
    echo "  (files in /workspace:)"
    ls -la /workspace/ 2>/dev/null || true
    exit 1
  fi

  echo ""
  echo "========================================"
  echo "  Sandbox Mode"
  echo "========================================"
  echo "  Reading: $BENCHMARK_FILE"
  echo "  Model:   $MODEL"
  if [ -n "${GEMINI_API_KEY:-}" ]; then
    echo "  Gemini:  ${GEMINI_MODEL:-gemini-2.5-pro} (API key provided)"
  fi
  echo ""

  FILE_CONTENT=$(cat "$BENCHMARK_FILE")

  PROMPT="Read and analyze the following file content. Provide a structured evaluation covering: accuracy, completeness, potential issues, and a summary.\n\n--- FILE: $(basename "$BENCHMARK_FILE") ---\n${FILE_CONTENT}\n--- END FILE ---"

  MOCK_FLAG=""
  if [ "${BENCHMARK_MOCK:-0}" = "1" ]; then
    MOCK_FLAG="--mock"
  fi

  EXTRA_ARGS=(--local --model "$MODEL" --output-dir /results)
  if [ -n "$MOCK_FLAG" ]; then
    EXTRA_ARGS+=($MOCK_FLAG)
  fi

  if [ -n "${GEMINI_API_KEY:-}" ]; then
    EXTRA_ARGS+=(--gemini-api-key "$GEMINI_API_KEY")
  fi
  if [ -n "${GEMINI_MODEL:-}" ]; then
    EXTRA_ARGS+=(--gemini-model "$GEMINI_MODEL")
  fi

  if [ -f /app/dist/entry.js ]; then
    BENCHMARK_SANDBOX_PROMPT="$PROMPT" node /app/gemmaclaw.mjs benchmark "${EXTRA_ARGS[@]}" "$@"
  else
    BENCHMARK_SANDBOX_PROMPT="$PROMPT" npx tsx /app/src/gemmaclaw/benchmark/cli-standalone.ts "${EXTRA_ARGS[@]}" "$@"
  fi

  EXIT_CODE=$?

  if [ "${BENCHMARK_KEEP:-0}" = "1" ]; then
    echo ""
    echo "Container kept alive. Use 'docker exec -it <id> bash' to inspect."
    echo "Sleeping indefinitely..."
    sleep infinity
  fi

  cleanup_ollama
  exit ${EXIT_CODE:-0}
fi

# ---------------------------------------------------------------------------
# 4. Agent mode: start gateway + mock gog, run E2E agentic benchmarks
# ---------------------------------------------------------------------------
if [ "$IS_AGENT" = "1" ]; then
  echo ""
  echo "========================================"
  echo "  Agent Benchmark Mode (E2E)"
  echo "========================================"
  echo ""

  # Seed mock gog state
  echo "[agent] Seeding mock gog state..."
  python3 /app/scripts/benchmark/seed-mock-gog.py

  # Start gemmaclaw gateway in the background
  echo "[agent] Starting gemmaclaw gateway..."
  export OPENCLAW_HOME="/root/.openclaw"
  mkdir -p "$OPENCLAW_HOME"

  # Determine Ollama URL. Real agent benchmarks must use host Ollama so each
  # per-task container starts clean without downloading or serving models.
  OLLAMA_TARGET="${OLLAMA_URL:-}"
  if [ -z "$OLLAMA_TARGET" ]; then
    OLLAMA_TARGET="http://host.docker.internal:11434"
  fi

  if curl -sf "$OLLAMA_TARGET/api/tags" >/dev/null 2>&1; then
    echo "[agent] Using host/configured Ollama at $OLLAMA_TARGET"
  else
    echo "ERROR: Agent benchmarks require a reachable host/configured Ollama at $OLLAMA_TARGET"
    echo "       Start host Ollama or pass OLLAMA_URL. Container-local Ollama is disabled for agent benchmarks."
    exit 1
  fi

  # Create minimal gemmaclaw config
  cat > "$OPENCLAW_HOME/openclaw.json" << GCEOF
{
  "provider": "ollama",
  "model": "$MODEL",
  "ollamaUrl": "$OLLAMA_TARGET",
  "sandbox": { "mode": "off" },
  "tools": { "exec": { "host": "gateway" } },
  "security": "full",
  "ask": "off"
}
GCEOF

  if [ -f /app/dist/entry.js ]; then
    GEMMACLAW_CMD="node /app/gemmaclaw.mjs"
  else
    GEMMACLAW_CMD="npx tsx /app/src/entry.ts"
  fi

  export GEMMACLAW_BIN="$GEMMACLAW_CMD"

  # Start gateway in the foreground inside the container. "gateway start" is
  # the service-manager command and is intentionally unavailable in benchmark
  # containers.
  $GEMMACLAW_CMD gateway run --port 3001 --bind loopback --auth none --allow-unconfigured &
  GATEWAY_PID=$!

  echo "[agent] Waiting for gateway..."
  for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
      echo "  Gateway ready after ${i}s"
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo "ERROR: Gateway failed to start after 30s"
      cleanup_ollama
      exit 1
    fi
    sleep 1
  done

  # Run the benchmark
  HAS_OUTPUT_DIR=0
  for arg in "$@"; do
    if [ "$arg" = "--output-dir" ]; then
      HAS_OUTPUT_DIR=1
      break
    fi
  done

  EXTRA_ARGS=(--model "$MODEL" --gateway-url http://127.0.0.1:3001 --ollama-url "$OLLAMA_TARGET")
  if [ "$HAS_OUTPUT_DIR" = "0" ]; then
    EXTRA_ARGS+=(--output-dir /results)
  fi

  node --import tsx /app/src/gemmaclaw/benchmark/cli-standalone.ts "$@" "${EXTRA_ARGS[@]}"

  EXIT_CODE=$?

  # Cleanup
  kill $GATEWAY_PID 2>/dev/null || true
  cleanup_ollama

  exit ${EXIT_CODE:-0}
fi

# ---------------------------------------------------------------------------
# 5. Standard mode: run benchmark, forwarding all host-supplied args
# ---------------------------------------------------------------------------
echo ""

HAS_OUTPUT_DIR=0
for arg in "$@"; do
  if [ "$arg" = "--output-dir" ]; then
    HAS_OUTPUT_DIR=1
    break
  fi
done

EXTRA_ARGS=()
if [ "$HAS_OUTPUT_DIR" = "0" ]; then
  EXTRA_ARGS+=(--output-dir /results)
fi

if [ -f /app/dist/entry.js ]; then
  node /app/gemmaclaw.mjs benchmark --local --model "$MODEL" "${EXTRA_ARGS[@]}" "$@"
else
  npx tsx /app/src/gemmaclaw/benchmark/cli-standalone.ts --local --model "$MODEL" "${EXTRA_ARGS[@]}" "$@"
fi

EXIT_CODE=$?

cleanup_ollama

exit ${EXIT_CODE:-0}
