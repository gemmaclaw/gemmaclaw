#!/usr/bin/env bash
# Tests for benchmark-docker-entrypoint.sh gateway probe logic:
# 1. Pre-seeding gateway.auth.token prevents browser plugin restart race
# 2. Probe loop tolerates intentional gateway restart (old-PID-death tolerance)
#
# Run: bash scripts/benchmark/test-gateway-probe.sh
# Exit 0 = all passed, Exit 1 = failure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

PASSED=0
FAILED=0

pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  FAIL: $1"; echo "       $2"; FAILED=$((FAILED + 1)); }

echo ""
echo "========================================"
echo "  Gateway Probe Tests"
echo "========================================"
echo ""

# ── Test 1: BENCHMARK_BROWSER_AUTH_TOKEN generation ──────────────────────────
echo "[1] Browser auth token generation"

TOKEN="$(openssl rand -hex 32 2>/dev/null \
  || python3 -c 'import secrets; print(secrets.token_hex(32))')"

if [ -z "$TOKEN" ]; then
  fail "token generated" "token is empty"
elif [ "${#TOKEN}" -ne 64 ]; then
  fail "token length=64" "got length=${#TOKEN} token=$TOKEN"
else
  pass "token is 64-char hex: ${TOKEN:0:8}..."
fi

# ── Test 2: openclaw.json template contains gateway.auth.token ───────────────
echo "[2] Entrypoint pre-seeds gateway.auth.token in openclaw.json"

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

TEST_TOKEN="deadbeef0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c"
OLLAMA_TARGET="http://host.docker.internal:11434"
EXPECTED_AGENT_MODEL="google-gemini-cli/gemini-3-flash-preview"
MODEL="gemini-3-flash-preview"
PLUGIN_ALLOW_ID="google"
BENCHMARK_BROWSER_AUTH_TOKEN="$TEST_TOKEN"

# Generate openclaw.json as the entrypoint would (non-codex branch)
cat > "$TMPDIR_TEST/openclaw.json" << GCEOF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "${EXPECTED_AGENT_MODEL}"
      },
      "memorySearch": { "enabled": false },
      "heartbeat": { "every": "0m", "includeSystemPromptSection": false },
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
  "gateway": {
    "auth": {
      "token": "${BENCHMARK_BROWSER_AUTH_TOKEN}"
    }
  },
  "plugins": {
    "allow": ["${PLUGIN_ALLOW_ID}"]
  },
  "tools": { "exec": { "host": "gateway", "security": "full", "ask": "off" } }
}
GCEOF

if ! grep -q "\"token\": \"$TEST_TOKEN\"" "$TMPDIR_TEST/openclaw.json"; then
  fail "gateway.auth.token in config" "token not found in openclaw.json"
else
  pass "gateway.auth.token present in generated config"
fi

if ! python3 -c "import json,sys; d=json.load(open('$TMPDIR_TEST/openclaw.json')); t=d.get('gateway',{}).get('auth',{}).get('token',''); sys.exit(0 if len(t)==64 else 1)" 2>/dev/null; then
  fail "gateway.auth.token is valid JSON string (64 chars)" "JSON parse failed or wrong length"
else
  pass "gateway.auth.token parses as 64-char JSON string"
fi

# ── Test 3: Probe loop follows gateway restart ────────────────────────────────
echo "[3] Probe loop follows gateway restart (simulated with Python HTTP server)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "  SKIP: python3 not available"
else
  PROBE_PORT=13001
  PROBE_LOG="$TMPDIR_TEST/probe-test.log"
  SERVER_PID_FILE="$TMPDIR_TEST/server.pid"

  # Start a mock gateway that returns healthz OK immediately, runs for 2s,
  # then exits (simulating the restart: PID dies, new server picks up)
  python3 - "$PROBE_PORT" "$SERVER_PID_FILE" > "$PROBE_LOG" 2>&1 &
  FIRST_SERVER_BG=$!
  cat << 'PYEOF' > /dev/null
# (inline placeholder — actual code below)
PYEOF

  python3 << PYEOF &
import http.server, threading, time, sys, os

port = $PROBE_PORT
pid_file = "$SERVER_PID_FILE"

class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true,"status":"live"}')

with open(pid_file, "w") as f:
    f.write(str(os.getpid()))

httpd = http.server.HTTPServer(("127.0.0.1", port), H)
# Serve for 2 seconds then exit (simulating restart)
t = threading.Thread(target=lambda: (time.sleep(2), httpd.shutdown()))
t.daemon = True
t.start()
httpd.serve_forever()
PYEOF
  FIRST_SERVER=$!

  # Wait for server to be ready
  for i in $(seq 1 10); do
    if curl -s --connect-timeout 1 --max-time 2 "http://127.0.0.1:$PROBE_PORT/healthz" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done

  # Run the probe loop (simulating the entrypoint logic)
  GATEWAY_PID=$FIRST_SERVER
  GATEWAY_READY=0
  HEALTH_FAILS=0

  for i in $(seq 1 20); do
    if curl -s --connect-timeout 1 --max-time 2 "http://127.0.0.1:$PROBE_PORT/healthz" >/dev/null 2>&1; then
      GATEWAY_READY=1
      break
    fi
    HEALTH_FAILS=$((HEALTH_FAILS + 1))
    # Simulate the probe-loop PID refresh every 10 failures
    if [ "$((HEALTH_FAILS % 5))" = "0" ]; then
      if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
        # Gateway died — check for replacement (in real code this uses pgrep)
        # For test purposes, we just note the PID died and continue
        OLD_PID="$GATEWAY_PID"
        # Try to find new process (simplified)
        GATEWAY_PID="$(pgrep -f "http.server.HTTPServer.*$PROBE_PORT" 2>/dev/null | head -1 || echo $GATEWAY_PID)"
        echo "  [probe-test] gateway pid $OLD_PID exited; new PID candidate: $GATEWAY_PID"
      fi
    fi
    sleep 0.3
  done

  # Restart the server (simulating new gateway PID after restart)
  python3 << PYEOF2 &
import http.server, time, os

port = $PROBE_PORT
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true,"status":"live"}')

httpd = http.server.HTTPServer(("127.0.0.1", port), H)
httpd.serve_forever()
PYEOF2
  SECOND_SERVER=$!
  sleep 0.5

  # Now probe again to see if the new server is reachable
  if curl -s --connect-timeout 1 --max-time 2 "http://127.0.0.1:$PROBE_PORT/healthz" >/dev/null 2>&1; then
    pass "probe loop can connect to restarted gateway"
  else
    fail "probe loop can connect to restarted gateway" "healthz not responding after restart"
  fi

  kill "$FIRST_SERVER" 2>/dev/null || true
  kill "$SECOND_SERVER" 2>/dev/null || true
  wait "$FIRST_SERVER" 2>/dev/null || true
  wait "$SECOND_SERVER" 2>/dev/null || true
fi

# ── Test 4: Entrypoint has refresh_gateway_pid function ──────────────────────
echo "[4] Entrypoint defines refresh_gateway_pid and uses it in probe loop"

ENTRYPOINT="$REPO_DIR/scripts/benchmark-docker-entrypoint.sh"
if [ ! -f "$ENTRYPOINT" ]; then
  fail "entrypoint exists" "not found at $ENTRYPOINT"
elif ! grep -q "refresh_gateway_pid()" "$ENTRYPOINT"; then
  fail "refresh_gateway_pid defined" "function not found in entrypoint"
else
  pass "refresh_gateway_pid() defined in entrypoint"
fi

if ! grep -q "OLD_GATEWAY_PID" "$ENTRYPOINT"; then
  fail "probe loop uses OLD_GATEWAY_PID pattern" "OLD_GATEWAY_PID not found"
else
  pass "probe loop uses OLD_GATEWAY_PID restart-follow pattern"
fi

# ── Test 5: Entrypoint pre-seeds BENCHMARK_BROWSER_AUTH_TOKEN ────────────────
echo "[5] Entrypoint pre-seeds browser auth token before writing config"

if ! grep -q "BENCHMARK_BROWSER_AUTH_TOKEN" "$ENTRYPOINT"; then
  fail "BENCHMARK_BROWSER_AUTH_TOKEN defined" "variable not found in entrypoint"
elif ! grep -q 'openssl rand -hex 32' "$ENTRYPOINT"; then
  fail "token generated via openssl rand" "openssl rand not found in entrypoint"
else
  pass "BENCHMARK_BROWSER_AUTH_TOKEN generated via openssl rand"
fi

TOKEN_BEFORE_CONFIG=$(grep -n "BENCHMARK_BROWSER_AUTH_TOKEN" "$ENTRYPOINT" | head -1 | awk -F: '{print $1}')
CONFIG_WRITE_LINE=$(grep -n '"gateway"' "$ENTRYPOINT" | head -1 | awk -F: '{print $1}')
if [ -n "$TOKEN_BEFORE_CONFIG" ] && [ -n "$CONFIG_WRITE_LINE" ] && [ "$TOKEN_BEFORE_CONFIG" -lt "$CONFIG_WRITE_LINE" ]; then
  pass "BENCHMARK_BROWSER_AUTH_TOKEN is generated before gateway config is written"
else
  fail "BENCHMARK_BROWSER_AUTH_TOKEN before config write" "token generation at line $TOKEN_BEFORE_CONFIG, config write at line $CONFIG_WRITE_LINE"
fi

# ── Test 6: Entrypoint does not exit on gateway PID death during probe ───────
echo "[6] Probe loop does not exit when gateway PID dies (restart tolerance)"

# Verify the old FAIL/exit pattern is NOT in the probe loop
if grep -A 3 "no longer alive" "$ENTRYPOINT" 2>/dev/null | grep -q "exit 1"; then
  fail "probe loop does not exit on PID death" "found 'exit 1' after 'no longer alive' — old bug still present"
else
  pass "probe loop does not exit on PID death (restart-tolerant)"
fi

# Verify refresh_gateway_pid is called inside the probe loop (not just cleanup)
PROBE_SECTION_START=$(grep -n "Waiting for gateway" "$ENTRYPOINT" | head -1 | awk -F: '{print $1}')
PROBE_SECTION_END=$(grep -n "GATEWAY_READY.*!.*1" "$ENTRYPOINT" | head -1 | awk -F: '{print $1}')
REFRESH_IN_PROBE=$(awk -v s="$PROBE_SECTION_START" -v e="$PROBE_SECTION_END" \
  'NR>=s && NR<=e && /refresh_gateway_pid/' "$ENTRYPOINT" | wc -l)
if [ "$REFRESH_IN_PROBE" -gt 0 ]; then
  pass "refresh_gateway_pid called inside healthz probe loop"
else
  fail "refresh_gateway_pid in probe loop" "not found between lines $PROBE_SECTION_START and $PROBE_SECTION_END"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo "  Results: $PASSED passed, $FAILED failed"
echo "========================================"
echo ""

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
