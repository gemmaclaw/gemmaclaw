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

  # Determine which provider/backend the host caller asked for. Default is
  # ollama. llama-cpp uses an OpenAI-compatible base URL, so the provider
  # prefix differs.
  BENCHMARK_BACKEND="ollama"
  prev_was_backend=0
  for arg in "$@"; do
    if [ "$prev_was_backend" = "1" ]; then
      BENCHMARK_BACKEND="$arg"
      prev_was_backend=0
      continue
    fi
    if [ "$arg" = "--backend" ]; then
      prev_was_backend=1
    fi
  done
  case "$BENCHMARK_BACKEND" in
    ollama)         PROVIDER_PREFIX="ollama" ;;
    llama-cpp)      PROVIDER_PREFIX="openai" ;;
    openai-codex)   PROVIDER_PREFIX="openai-codex" ;;
    *)              PROVIDER_PREFIX="$BENCHMARK_BACKEND" ;;
  esac
  EXPECTED_AGENT_MODEL="${PROVIDER_PREFIX}/${MODEL}"

  # Seed mock gog state
  echo "[agent] Seeding mock gog state..."
  python3 /app/scripts/benchmark/seed-mock-gog.py

  # Start gemmaclaw gateway in the background. The gemmaclaw binary resolves
  # its state directory via GEMMACLAW_HOME first, then OPENCLAW_STATE_DIR,
  # then ~/.gemmaclaw (see src/gemmaclaw/home.ts). OPENCLAW_HOME is NOT a
  # supported override and was the source of an earlier bug where the gateway
  # silently fell back to /root/.gemmaclaw/openclaw.json (default
  # openai/gpt-5.4) instead of the entrypoint-written config.
  echo "[agent] Starting gemmaclaw gateway..."
  export GEMMACLAW_HOME="/root/.gemmaclaw"
  export OPENCLAW_STATE_DIR="$GEMMACLAW_HOME"
  unset OPENCLAW_HOME
  mkdir -p "$GEMMACLAW_HOME"

  # Determine Ollama URL. Real agent benchmarks must use host Ollama so each
  # per-task container starts clean without downloading or serving models.
  OLLAMA_TARGET="${OLLAMA_URL:-}"
  if [ -z "$OLLAMA_TARGET" ]; then
    OLLAMA_TARGET="http://host.docker.internal:11434"
  fi

  if curl -sf "$OLLAMA_TARGET/api/tags" >/dev/null 2>&1; then
    echo "[agent] Using host/configured Ollama at $OLLAMA_TARGET"
  else
    echo "FAIL: Agent benchmarks require a reachable host/configured Ollama at $OLLAMA_TARGET"
    echo "      Start host Ollama or pass OLLAMA_URL. Container-local Ollama is disabled for agent benchmarks."
    exit 1
  fi

  # Verify the requested model exists on host Ollama before starting the
  # gateway. A missing model is a hard fail; we do not fall back to a
  # different model silently.
  if [ "$BENCHMARK_BACKEND" = "ollama" ]; then
    if ! curl -sf "$OLLAMA_TARGET/api/tags" \
        | python3 -c "import json,sys; tags=json.load(sys.stdin).get('models',[]); names=[m.get('name','') for m in tags]; sys.exit(0 if '$MODEL' in names else 1)"; then
      echo "FAIL: model $MODEL is not present on host Ollama at $OLLAMA_TARGET. Run 'ollama pull $MODEL' on the host before running benchmarks."
      exit 1
    fi
    echo "[agent] Confirmed host Ollama has model: $MODEL"
  fi

  # Write the gateway config in the canonical schema. The OUTER gateway is
  # primarily used by per-task agents for tools.exec.host=gateway, but its
  # configured agent model is also the diagnostic source of truth for
  # "what is this benchmark actually running?". Use the same schema the
  # benchmark agent-runner writes for its isolated per-task config.
  cat > "$GEMMACLAW_HOME/openclaw.json" << GCEOF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "${EXPECTED_AGENT_MODEL}"
      },
      "llm": { "idleTimeoutSeconds": 0 }
    }
  },
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "${OLLAMA_TARGET}",
        "api": "ollama",
        "models": [
          {
            "id": "${MODEL}",
            "name": "${MODEL}",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 262144,
            "maxTokens": 8192,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  },
  "tools": { "exec": { "host": "gateway", "security": "full", "ask": "off" } }
}
GCEOF

  # Provide a minimal auth profile so the gateway can boot without prompting
  # (the inner per-task agent writes its own isolated profile).
  mkdir -p "$GEMMACLAW_HOME/agents/main/agent"
  cat > "$GEMMACLAW_HOME/agents/main/agent/auth-profiles.json" << GCEOF
{
  "ollama:default": {
    "type": "token",
    "provider": "ollama",
    "token": "benchmark-dummy-key"
  }
}
GCEOF

  if [ -f /app/dist/entry.js ]; then
    GEMMACLAW_CMD="node /app/gemmaclaw.mjs"
  else
    GEMMACLAW_CMD="npx tsx /app/src/entry.ts"
  fi

  export GEMMACLAW_BIN="$GEMMACLAW_CMD"

  GATEWAY_LOG="/tmp/gemmaclaw-gateway-startup.log"
  : > "$GATEWAY_LOG"

  # Start gateway in the foreground inside the container. "gateway start" is
  # the service-manager command and is intentionally unavailable in benchmark
  # containers. Redirect stdout+stderr to a grep-able log file so the
  # entrypoint can verify the resolved agent model after startup. (The
  # container's own stdout already reports the entrypoint's echoes; the
  # gateway's verbose log is not needed on container stdout.)
  $GEMMACLAW_CMD gateway run --port 3001 --bind loopback --auth none --allow-unconfigured \
    >> "$GATEWAY_LOG" 2>&1 &
  GATEWAY_PID=$!

  echo "[agent] Waiting for gateway..."
  for i in $(seq 1 60); do
    if curl -s http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
      echo "  Gateway ready after ${i}s"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "FAIL: Gateway failed to start after 60s"
      cleanup_ollama
      exit 1
    fi
    sleep 1
  done

  # Verify gateway picked up our config: the most recent "agent model:" log
  # line must match EXPECTED_AGENT_MODEL. The gateway sometimes emits this
  # line twice (once on initial start, once after a restart triggered by a
  # config-recovery write). We use the LAST occurrence.
  echo "[agent] Verifying gateway resolved agent model = $EXPECTED_AGENT_MODEL"
  for i in $(seq 1 30); do
    if grep -E "\[gateway\] agent model: " "$GATEWAY_LOG" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  ACTUAL_AGENT_MODEL="$(grep -E "\[gateway\] agent model: " "$GATEWAY_LOG" | tail -1 | sed -E 's/.*\[gateway\] agent model: //' | tr -d '\r' | awk '{print $1}')"
  if [ -z "$ACTUAL_AGENT_MODEL" ]; then
    echo "FAIL: Gateway did not log an 'agent model:' line within 30s. Gateway log:"
    tail -40 "$GATEWAY_LOG"
    kill $GATEWAY_PID 2>/dev/null || true
    cleanup_ollama
    exit 1
  fi
  if [ "$ACTUAL_AGENT_MODEL" != "$EXPECTED_AGENT_MODEL" ]; then
    echo "FAIL: gateway agent model is '$ACTUAL_AGENT_MODEL', expected '$EXPECTED_AGENT_MODEL'."
    echo "      Last 60 gateway log lines:"
    tail -60 "$GATEWAY_LOG"
    kill $GATEWAY_PID 2>/dev/null || true
    cleanup_ollama
    exit 1
  fi
  echo "[agent] PREFLIGHT OK: gateway agent model = $ACTUAL_AGENT_MODEL"
  echo "[agent] Gateway log captured at $GATEWAY_LOG"

  # Warm host Ollama so the model is loaded into VRAM before the agent
  # dispatch starts. Without this, the first task can spend several minutes
  # waiting for the model to load while the activity-based watchdog ticks.
  if [ "$BENCHMARK_BACKEND" = "ollama" ]; then
    echo "[agent] Warming host Ollama with $MODEL (keep_alive=30m)"
    if ! curl -sf -X POST "$OLLAMA_TARGET/api/generate" \
        -H "Content-Type: application/json" \
        -d "{\"model\":\"$MODEL\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":\"30m\",\"options\":{\"num_predict\":1}}" \
        >/tmp/ollama-warmup.json 2>&1; then
      echo "FAIL: host Ollama warmup for $MODEL failed."
      cat /tmp/ollama-warmup.json 2>/dev/null | tail -20
      kill $GATEWAY_PID 2>/dev/null || true
      cleanup_ollama
      exit 1
    fi
    LOADED_MODELS="$(curl -sf "$OLLAMA_TARGET/api/ps" 2>/dev/null \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(m.get('name','') for m in d.get('models',[])))" 2>/dev/null)"
    if ! echo "$LOADED_MODELS" | tr ',' '\n' | grep -Fxq "$MODEL"; then
      echo "FAIL: after warmup, host Ollama /api/ps does not show $MODEL loaded. Loaded: $LOADED_MODELS"
      kill $GATEWAY_PID 2>/dev/null || true
      cleanup_ollama
      exit 1
    fi
    echo "[agent] Host Ollama loaded models: $LOADED_MODELS"
  fi

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

  # Post-task verification: the host Ollama process must show the requested
  # model loaded after the benchmark dispatch. If the dispatch silently
  # routed to a different model, /api/ps will say so.
  if [ "$BENCHMARK_BACKEND" = "ollama" ]; then
    POST_LOADED="$(curl -sf "$OLLAMA_TARGET/api/ps" 2>/dev/null \
      | python3 -c "import json,sys; d=json.load(sys.stdin); print(','.join(m.get('name','') for m in d.get('models',[])))" 2>/dev/null)"
    if echo "$POST_LOADED" | tr ',' '\n' | grep -Fxq "$MODEL"; then
      echo "[agent] POST-TASK OK: host Ollama still has $MODEL loaded ($POST_LOADED)"
    else
      echo "WARN: after benchmark, host Ollama /api/ps does not show $MODEL. Loaded: $POST_LOADED"
      echo "      This may be a timing race (model unloaded after task finished) or a model-selection bug."
    fi
  fi

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
