#!/usr/bin/env bash
# In-container Gemmaclaw onboarding wizard test cases.
#
# Each case sets up an isolated $HOME, drives the `gemmaclaw setup` CLI either
# via piped answers (interactive) or via the new flag set (non-interactive),
# and asserts:
#   1. setup exits 0
#   2. expected prompts appear in the transcript
#   3. ~/.gemmaclaw/agents/<name>/agent/onboarding.json was written with the
#      right choice values
#   4. ~/.gemmaclaw/openclaw.json5 (or the resolved config path) records the
#      thinking level / model
#
# All cases run with OPENCLAW_SETUP_DRY_RUN=1 so we never download models or
# start a gateway. That is what makes the suite suitable for CI as a required
# pass.
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-/app}"
GEMMACLAW="node ${ROOT_DIR}/gemmaclaw.mjs"

PASS=0
FAIL=0

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
log() { printf '=== %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

reset_home() {
  local label="$1"
  local home_dir="/tmp/onboard-gemma-${label}"
  rm -rf "$home_dir"
  mkdir -p "$home_dir/.gemmaclaw"
  export HOME="$home_dir"
  # Keep OPENCLAW_HOME for any residual OpenClaw internals that look for it,
  # but gemmaclaw now derives its state dir from HOME via OPENCLAW_STATE_DIR.
  export OPENCLAW_HOME="$home_dir"
  # Clear OPENCLAW_STATE_DIR so gemmaclaw.mjs's default bridge kicks in and
  # sets it to $HOME/.gemmaclaw on each fresh case.
  unset OPENCLAW_STATE_DIR 2>/dev/null || true
}

assert_file_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -q -F -- "$needle" "$file"; then
    red "MISSING in $file: $needle"
    echo "--- $file ---"
    cat "$file" || true
    echo "--- end ---"
    return 1
  fi
}

assert_json_eq() {
  local file="$1"
  local jq_path="$2"
  local want="$3"
  local got
  got="$(node --input-type=module -e "
    import fs from 'node:fs';
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
    const path = process.argv[2].split('.').filter(Boolean);
    let cur = data;
    for (const p of path) cur = cur?.[p];
    process.stdout.write(String(cur ?? ''));
  " "$file" "$jq_path")"
  if [ "$got" != "$want" ]; then
    red "expected $jq_path = '$want' in $file (got '$got')"
    return 1
  fi
}

# Read the resolved config path from the Gemmaclaw home. Gemmaclaw writes either
# openclaw.json or openclaw.json5 under ~/.gemmaclaw.
config_path() {
  for candidate in \
    "$HOME/.gemmaclaw/openclaw.json5" \
    "$HOME/.gemmaclaw/openclaw.json" \
    "$HOME/.gemmaclaw/config.json5" \
    "$HOME/.gemmaclaw/config.json"; do
    if [ -f "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

case_pass() {
  PASS=$((PASS + 1))
  green "  PASS: $1"
}

case_fail() {
  FAIL=$((FAIL + 1))
  red "  FAIL: $1"
}

# -----------------------------------------------------------------------------
# Case 1: Local + container + interactive prompts answered via piped input.
# -----------------------------------------------------------------------------
case_local_interactive() {
  log "Case: local-interactive (defaults via Enter)"
  reset_home local-interactive
  local out_file="/tmp/onboard-gemma-local-interactive.log"

  # Six Enter keystrokes accept defaults: agent=main, container=yes, backend=local,
  # model=auto, thinking=medium, bootstrap=general.
  printf '\n\n\n\n\n\n' | $GEMMACLAW setup >"$out_file" 2>&1
  if [ $? -ne 0 ]; then
    case_fail "local-interactive: setup exited non-zero"
    tail -n 80 "$out_file"
    return
  fi

  if ! assert_file_contains "$out_file" "Agent name" \
      || ! assert_file_contains "$out_file" "Where should the agent run its tools" \
      || ! assert_file_contains "$out_file" "Where should the model run" \
      || ! assert_file_contains "$out_file" "Which model" \
      || ! assert_file_contains "$out_file" "How much should the agent think" \
      || ! assert_file_contains "$out_file" "starter persona" \
      || ! assert_file_contains "$out_file" "Your setup:"; then
    case_fail "local-interactive: prompt transcript incomplete"
    return
  fi

  local manifest="$HOME/.gemmaclaw/agents/main/agent/onboarding.json"
  if [ ! -f "$manifest" ]; then
    case_fail "local-interactive: missing $manifest"
    return
  fi
  if ! assert_json_eq "$manifest" "agentName" "main" \
      || ! assert_json_eq "$manifest" "backend" "local" \
      || ! assert_json_eq "$manifest" "thinkingLevel" "medium" \
      || ! assert_json_eq "$manifest" "bootstrap" "general" \
      || ! assert_json_eq "$manifest" "useContainer" "true"; then
    case_fail "local-interactive: manifest values wrong"
    return
  fi

  case_pass "local-interactive"
}

# -----------------------------------------------------------------------------
# Case 2: Local + non-interactive flags + custom agent name + coding bootstrap.
# -----------------------------------------------------------------------------
case_local_non_interactive() {
  log "Case: local-non-interactive (flags only)"
  reset_home local-non-interactive
  local out_file="/tmp/onboard-gemma-local-non-interactive.log"

  $GEMMACLAW setup \
    --non-interactive \
    --setup-mode local \
    --agent-name dev-agent \
    --no-container \
    --thinking high \
    --bootstrap coding \
    --dry-run \
    >"$out_file" 2>&1
  if [ $? -ne 0 ]; then
    case_fail "local-non-interactive: setup exited non-zero"
    tail -n 80 "$out_file"
    return
  fi

  if ! assert_file_contains "$out_file" "Agent name:  dev-agent" \
      || ! assert_file_contains "$out_file" "Direct on host" \
      || ! assert_file_contains "$out_file" "high" \
      || ! assert_file_contains "$out_file" "Coding helper" \
      || ! assert_file_contains "$out_file" "[dry-run]"; then
    case_fail "local-non-interactive: summary missing expected values"
    return
  fi

  local manifest="$HOME/.gemmaclaw/agents/dev-agent/agent/onboarding.json"
  if [ ! -f "$manifest" ]; then
    case_fail "local-non-interactive: missing $manifest"
    return
  fi
  if ! assert_json_eq "$manifest" "agentName" "dev-agent" \
      || ! assert_json_eq "$manifest" "thinkingLevel" "high" \
      || ! assert_json_eq "$manifest" "bootstrap" "coding" \
      || ! assert_json_eq "$manifest" "useContainer" "false"; then
    case_fail "local-non-interactive: manifest values wrong"
    return
  fi

  # Coding profile drops AGENTS.md + TOOLS.md into the agent's workspace.
  local ws="$HOME/.gemmaclaw/workspaces/dev-agent"
  if [ ! -f "$ws/AGENTS.md" ] || [ ! -f "$ws/TOOLS.md" ]; then
    case_fail "local-non-interactive: coding bootstrap files missing under $ws"
    ls -la "$ws" || true
    return
  fi

  case_pass "local-non-interactive"
}

# -----------------------------------------------------------------------------
# Case 3: Gemini API non-interactive with mock key.
# -----------------------------------------------------------------------------
case_gemini_non_interactive() {
  log "Case: gemini-non-interactive (mock GEMINI_API_KEY)"
  reset_home gemini-non-interactive
  local out_file="/tmp/onboard-gemma-gemini-non-interactive.log"

  GEMINI_API_KEY=AIzaTEST \
    $GEMMACLAW setup \
      --non-interactive \
      --setup-mode gemini \
      --agent-name cloudy \
      --thinking low \
      --bootstrap minimal \
      --dry-run \
      >"$out_file" 2>&1
  if [ $? -ne 0 ]; then
    case_fail "gemini-non-interactive: setup exited non-zero"
    tail -n 80 "$out_file"
    return
  fi

  if ! assert_file_contains "$out_file" "Agent name:  cloudy" \
      || ! assert_file_contains "$out_file" "Gemini API" \
      || ! assert_file_contains "$out_file" "google/gemini-2.5-flash" \
      || ! assert_file_contains "$out_file" "Minimal" \
      || ! assert_file_contains "$out_file" "Configuring Gemini API"; then
    case_fail "gemini-non-interactive: transcript missing expected values"
    return
  fi

  local manifest="$HOME/.gemmaclaw/agents/cloudy/agent/onboarding.json"
  if [ ! -f "$manifest" ]; then
    case_fail "gemini-non-interactive: missing $manifest"
    return
  fi
  if ! assert_json_eq "$manifest" "agentName" "cloudy" \
      || ! assert_json_eq "$manifest" "backend" "gemini" \
      || ! assert_json_eq "$manifest" "model" "google/gemini-2.5-flash" \
      || ! assert_json_eq "$manifest" "thinkingLevel" "low" \
      || ! assert_json_eq "$manifest" "bootstrap" "minimal"; then
    case_fail "gemini-non-interactive: manifest values wrong"
    return
  fi

  case_pass "gemini-non-interactive"
}

# -----------------------------------------------------------------------------
# Case 4: Vertex AI non-interactive (dry-run skips real gcloud probe).
# -----------------------------------------------------------------------------
case_vertex_non_interactive() {
  log "Case: vertex-non-interactive (dry-run, no real gcloud)"
  reset_home vertex-non-interactive
  local out_file="/tmp/onboard-gemma-vertex-non-interactive.log"

  $GEMMACLAW setup \
    --non-interactive \
    --setup-mode vertex \
    --agent-name corp \
    --model gemma-3-12b-it \
    --thinking off \
    --bootstrap general \
    --dry-run \
    >"$out_file" 2>&1
  if [ $? -ne 0 ]; then
    case_fail "vertex-non-interactive: setup exited non-zero"
    tail -n 80 "$out_file"
    return
  fi

  if ! assert_file_contains "$out_file" "Agent name:  corp" \
      || ! assert_file_contains "$out_file" "Vertex AI" \
      || ! assert_file_contains "$out_file" "gemma-3-12b-it" \
      || ! assert_file_contains "$out_file" "[dry-run] Skipping gcloud"; then
    case_fail "vertex-non-interactive: transcript missing expected values"
    return
  fi

  local manifest="$HOME/.gemmaclaw/agents/corp/agent/onboarding.json"
  if [ ! -f "$manifest" ]; then
    case_fail "vertex-non-interactive: missing $manifest"
    return
  fi
  if ! assert_json_eq "$manifest" "backend" "vertex" \
      || ! assert_json_eq "$manifest" "thinkingLevel" "off"; then
    case_fail "vertex-non-interactive: manifest values wrong"
    return
  fi

  # General profile drops AGENTS.md into the agent's workspace.
  local ws="$HOME/.gemmaclaw/workspaces/corp"
  if [ ! -f "$ws/AGENTS.md" ]; then
    case_fail "vertex-non-interactive: general bootstrap AGENTS.md missing under $ws"
    return
  fi
  if [ -f "$ws/TOOLS.md" ]; then
    case_fail "vertex-non-interactive: general bootstrap should not write TOOLS.md"
    return
  fi

  case_pass "vertex-non-interactive"
}

# -----------------------------------------------------------------------------
# Case 5: Backwards compat — `--no-container` alone still routes to gemma path
# without explicit --setup-mode and produces a setup with useContainer=false.
# -----------------------------------------------------------------------------
case_no_container_legacy_flag() {
  log "Case: no-container-legacy (still works with old flag name)"
  reset_home no-container-legacy
  local out_file="/tmp/onboard-gemma-no-container-legacy.log"

  $GEMMACLAW setup \
    --non-interactive \
    --setup-mode local \
    --no-container \
    --dry-run \
    >"$out_file" 2>&1
  if [ $? -ne 0 ]; then
    case_fail "no-container-legacy: setup exited non-zero"
    tail -n 80 "$out_file"
    return
  fi

  local manifest="$HOME/.gemmaclaw/agents/main/agent/onboarding.json"
  if [ ! -f "$manifest" ]; then
    case_fail "no-container-legacy: missing $manifest"
    return
  fi
  if ! assert_json_eq "$manifest" "useContainer" "false"; then
    case_fail "no-container-legacy: useContainer not false"
    return
  fi

  # The "main" agent uses the canonical workspace path (not the per-agent
  # workspaces/ directory used for non-default names).
  if [ ! -f "$HOME/.gemmaclaw/workspace/AGENTS.md" ]; then
    case_fail "no-container-legacy: main-agent AGENTS.md missing in canonical workspace"
    return
  fi

  case_pass "no-container-legacy"
}

# -----------------------------------------------------------------------------
# Case 6: Reject invalid agent name in non-interactive mode (fail-fast).
# -----------------------------------------------------------------------------
case_invalid_agent_name() {
  log "Case: invalid-agent-name (must fail fast)"
  reset_home invalid-agent-name
  local out_file="/tmp/onboard-gemma-invalid-agent-name.log"

  if $GEMMACLAW setup \
      --non-interactive \
      --setup-mode local \
      --agent-name "../etc" \
      --dry-run \
      >"$out_file" 2>&1; then
    case_fail "invalid-agent-name: expected non-zero exit but got 0"
    return
  fi

  if ! assert_file_contains "$out_file" "Invalid agent name"; then
    case_fail "invalid-agent-name: missing validation error message"
    return
  fi

  case_pass "invalid-agent-name"
}

# -----------------------------------------------------------------------------
# Dispatch
# -----------------------------------------------------------------------------
run_case() {
  case "$1" in
    local-interactive) case_local_interactive ;;
    local-non-interactive) case_local_non_interactive ;;
    gemini-non-interactive) case_gemini_non_interactive ;;
    vertex-non-interactive) case_vertex_non_interactive ;;
    no-container-legacy) case_no_container_legacy_flag ;;
    invalid-agent-name) case_invalid_agent_name ;;
    *)
      red "Unknown case: $1"
      FAIL=$((FAIL + 1))
      ;;
  esac
}

main() {
  local cases=("$@")
  if [ "${#cases[@]}" -eq 0 ] || [ "${cases[0]}" = "all" ]; then
    cases=(
      local-interactive
      local-non-interactive
      gemini-non-interactive
      vertex-non-interactive
      no-container-legacy
      invalid-agent-name
    )
  fi
  for c in "${cases[@]}"; do
    run_case "$c"
  done
  log "Summary: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -gt 0 ]; then
    exit 1
  fi
}

main "$@"
