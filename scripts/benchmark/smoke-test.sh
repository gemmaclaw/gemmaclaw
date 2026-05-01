#!/usr/bin/env bash
# Reusable benchmark smoke test.
# Runs a single easy task (memory_log) to verify the harness works end-to-end.
#
# Usage:
#   bash scripts/benchmark/smoke-test.sh              # mock mode (instant, no model)
#   bash scripts/benchmark/smoke-test.sh --real        # real mode with gemmaclaw gateway
#   bash scripts/benchmark/smoke-test.sh --task email_summarize  # different task
#
# Requires: Node 22+, pnpm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_DIR"

# Parse args
MODE="mock"
TASK="memory_log"
EXTRA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --real) MODE="real" ;;
    --task) shift; TASK="${1:-memory_log}" ;;
    *) EXTRA_ARGS+=("$arg") ;;
  esac
  shift 2>/dev/null || true
done

OUTPUT_DIR="/tmp/gemmaclaw-bench-smoke-$(date +%s)"

echo "========================================="
echo "  Gemmaclaw Benchmark Smoke Test"
echo "========================================="
echo "Mode:   $MODE"
echo "Task:   $TASK"
echo "Output: $OUTPUT_DIR"
echo ""

if [ "$MODE" = "mock" ]; then
  echo "[1/2] Running mock benchmark..."
  pnpm benchmark agent --mock --task "$TASK" --output-dir "$OUTPUT_DIR" "${EXTRA_ARGS[@]}"
else
  echo "[1/2] Checking Ollama..."
  if ! curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "ERROR: No Ollama at 127.0.0.1:11434."
    exit 1
  fi

  echo "[2/2] Running real benchmark (gemmaclaw agent --local, no gateway needed)..."
  pnpm benchmark agent --task "$TASK" --output-dir "$OUTPUT_DIR" \
    --idle-timeout 60 --task-timeout 300 "${EXTRA_ARGS[@]}"
fi

echo ""
echo "========================================="
echo "  Smoke Test Results"
echo "========================================="

# Check output files exist
RESULTS_OK=true
for f in runs/*/metadata.json runs/*/results.json runs/*/RESULTS.md runs/*/transcripts/*.txt evaluations/*/*.json; do
  MATCH=$(find "$OUTPUT_DIR" -path "*/$f" 2>/dev/null | head -1)
  if [ -n "$MATCH" ]; then
    echo "  OK  $f"
  else
    echo "  MISSING  $f"
    RESULTS_OK=false
  fi
done

echo ""
if [ "$RESULTS_OK" = true ]; then
  echo "SMOKE TEST PASSED"
  # Show summary
  cat "$OUTPUT_DIR"/runs/*/RESULTS.md 2>/dev/null | head -20
else
  echo "SMOKE TEST FAILED - missing output files"
  # Show logs if available
  if ls "$OUTPUT_DIR"/../benchmark-results/.logs/*.log >/dev/null 2>&1; then
    echo ""
    echo "Dispatch logs:"
    cat "$REPO_DIR"/benchmark-results/.logs/*.log 2>/dev/null | tail -20
  fi
  exit 1
fi
