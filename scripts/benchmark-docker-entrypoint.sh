#!/bin/bash
set -euo pipefail

echo "========================================"
echo "  Gemmaclaw Benchmark (Docker)"
echo "========================================"
echo ""

# ---------------------------------------------------------------------------
# 1. Start Ollama
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 2. Pull model (extract --model from args, default gemma3:1b)
# ---------------------------------------------------------------------------
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

echo "[3/3] Pulling model: $MODEL"
ollama pull "$MODEL"

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

  kill $OLLAMA_PID 2>/dev/null || true
  exit ${EXIT_CODE:-0}
fi

# ---------------------------------------------------------------------------
# 4. Standard mode: run benchmark, forwarding all host-supplied args
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

kill $OLLAMA_PID 2>/dev/null || true

exit ${EXIT_CODE:-0}
