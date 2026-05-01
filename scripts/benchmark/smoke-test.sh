#!/usr/bin/env bash
# Reusable benchmark smoke test.
# Tests mock mode, Ollama backend, and llama.cpp backend.
#
# Usage:
#   bash scripts/benchmark/smoke-test.sh              # mock only (instant, no model)
#   bash scripts/benchmark/smoke-test.sh --real        # mock + ollama + llama.cpp
#   bash scripts/benchmark/smoke-test.sh --ollama      # mock + ollama only
#   bash scripts/benchmark/smoke-test.sh --llamacpp    # mock + llama.cpp only
#
# Requires: Node 22+, pnpm, Ollama (for --real/--ollama), llama-server (for --real/--llamacpp)
# Run this after any benchmark harness changes to verify nothing broke.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_DIR"

MODE="mock"
TASK="memory_log"
OLLAMA_MODEL="gemma4:e4b"
LLAMACPP_MODEL="gemma3:1b"
PASSED=0
FAILED=0

for arg in "$@"; do
  case "$arg" in
    --real) MODE="all" ;;
    --ollama) MODE="ollama" ;;
    --llamacpp|--llama-cpp) MODE="llamacpp" ;;
  esac
done

check_results() {
  local dir="$1"
  local label="$2"
  local ok=true
  for pattern in "runs/*/metadata.json" "runs/*/results.json" "runs/*/RESULTS.md" "runs/*/transcripts/*.txt" "evaluations/*/*.json"; do
    if ! find "$dir" -path "*/$pattern" 2>/dev/null | grep -q .; then
      echo "    MISSING $pattern"
      ok=false
    fi
  done
  if $ok; then
    echo "  PASS: $label"
    PASSED=$((PASSED + 1))
  else
    echo "  FAIL: $label"
    FAILED=$((FAILED + 1))
  fi
}

echo "========================================="
echo "  Gemmaclaw Benchmark Smoke Test"
echo "========================================="
echo "Mode: $MODE"
echo ""

# ── 1. Mock mode (always runs) ──────────────────────────────────────────
echo "[mock] Running mock benchmark..."
OUT_MOCK="/tmp/gemmaclaw-smoke-mock-$$"
pnpm benchmark agent --mock --task "$TASK" --output-dir "$OUT_MOCK" 2>&1 | tail -5
check_results "$OUT_MOCK" "mock mode"

# ── 2. Ollama backend ───────────────────────────────────────────────────
if [ "$MODE" = "all" ] || [ "$MODE" = "ollama" ]; then
  echo ""
  echo "[ollama] Checking Ollama at 127.0.0.1:11434..."
  if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    OUT_OLLAMA="/tmp/gemmaclaw-smoke-ollama-$$"
    echo "[ollama] Running with $OLLAMA_MODEL..."
    pnpm benchmark agent --task "$TASK" --model "$OLLAMA_MODEL" \
      --output-dir "$OUT_OLLAMA" --idle-timeout 15 --task-timeout 180 2>&1 | tail -10
    check_results "$OUT_OLLAMA" "ollama ($OLLAMA_MODEL)"

    # Show transcript
    TRANSCRIPT=$(find "$OUT_OLLAMA" -name "${TASK}.txt" 2>/dev/null | head -1)
    if [ -n "$TRANSCRIPT" ]; then
      echo "    Transcript:"
      sed 's/^/      /' "$TRANSCRIPT" | head -10
    fi
  else
    echo "  SKIP: Ollama not available"
  fi
fi

# ── 3. llama.cpp backend ────────────────────────────────────────────────
if [ "$MODE" = "all" ] || [ "$MODE" = "llamacpp" ]; then
  echo ""
  echo "[llama.cpp] Checking llama-server at 127.0.0.1:8080..."

  LLAMACPP_STARTED=false
  if curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "  llama-server already running"
    LLAMACPP_STARTED=false  # don't kill it
  elif which llama-server >/dev/null 2>&1; then
    # Try to start llama-server with gemma3:1b
    MODELPATH=$(ollama show "$LLAMACPP_MODEL" --modelfile 2>/dev/null | grep "^FROM /" | awk '{print $2}')
    if [ -n "$MODELPATH" ] && [ -f "$MODELPATH" ]; then
      echo "  Starting llama-server with $LLAMACPP_MODEL..."
      llama-server -m "$MODELPATH" --port 8080 --n-gpu-layers 99 -c 4096 > /tmp/llama-server-smoke.log 2>&1 &
      LLAMA_PID=$!
      for i in $(seq 1 30); do
        if curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; then
          echo "  llama-server ready after ${i}s"
          LLAMACPP_STARTED=true
          break
        fi
        sleep 1
      done
      if ! $LLAMACPP_STARTED; then
        echo "  SKIP: llama-server failed to start"
        echo "  Last log: $(tail -3 /tmp/llama-server-smoke.log)"
        kill $LLAMA_PID 2>/dev/null
      fi
    else
      echo "  SKIP: model $LLAMACPP_MODEL not found for llama-server"
    fi
  else
    echo "  SKIP: llama-server not installed"
  fi

  if curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; then
    OUT_LLAMACPP="/tmp/gemmaclaw-smoke-llamacpp-$$"
    echo "[llama.cpp] Running with $LLAMACPP_MODEL..."
    pnpm benchmark agent --task "$TASK" --model "$LLAMACPP_MODEL" \
      --backend llama-cpp --llama-cpp-url http://127.0.0.1:8080 \
      --output-dir "$OUT_LLAMACPP" --idle-timeout 15 --task-timeout 60 2>&1 | tail -10
    check_results "$OUT_LLAMACPP" "llama.cpp ($LLAMACPP_MODEL)"

    TRANSCRIPT=$(find "$OUT_LLAMACPP" -name "${TASK}.txt" 2>/dev/null | head -1)
    if [ -n "$TRANSCRIPT" ]; then
      echo "    Transcript:"
      sed 's/^/      /' "$TRANSCRIPT" | head -10
    fi
  fi

  # Clean up if we started llama-server
  if $LLAMACPP_STARTED; then
    kill $LLAMA_PID 2>/dev/null || true
    echo "  Stopped llama-server"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────────
echo ""
echo "========================================="
echo "  Summary: $PASSED passed, $FAILED failed"
echo "========================================="

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
