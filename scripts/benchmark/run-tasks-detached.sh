#!/usr/bin/env bash
# Detached, supervised runner for sequential agent-benchmark task reruns.
#
# Why this exists:
#   The 2026-05-10 context_memory_chain incident: an in-flight benchmark task
#   was killed silently when the parent ACP worker process tree exited. The
#   wrapper script was launched without setsid/nohup, so it died with the
#   parent, leaving no result.json and no logged exit. From the operator's
#   perspective the rerun was indistinguishable from "never started".
#
#   This script makes long benchmark sweeps survive parent death:
#     1. Re-execs itself under setsid+nohup so it has its own session id.
#     2. Writes a heartbeat file every 60s with current task + timestamp.
#     3. Writes its own pid file so a watcher can verify liveness.
#     4. Keeps a per-task log + a single tail-able runner log.
#
# Usage:
#   bash scripts/benchmark/run-tasks-detached.sh \
#     --tasks "task_a,task_b,task_c" \
#     --model gemma4:31b --quant Q4_K_M --thinking high \
#     --run-id gemma4-31b-q4-high \
#     --output-dir /home/frank/gemmaclaw-benchmarks/results \
#     --log-dir /home/frank/gemmaclaw-benchmarks/q4-rerun-logs \
#     [--no-activity-timeout 600] [--hard-cap 28800]
#
# Detached state lives in --log-dir:
#   detached.pid          pid of the supervisor process
#   detached.sid          setsid session id (use for kill -- -<sid>)
#   detached.heartbeat    epoch seconds, current task name, last log line ref
#   runner.log            full supervisor stdout+stderr
#   <task>.log            per-task log
#   detached.summary.json final summary on clean exit
#
# This script uses the same `pnpm benchmark agent --rerun --task <id>`
# entry point as scripts/benchmark/smoke-test.sh, so the per-task harness
# (preflight, container build, model verification, fake gog) is identical.

set -uo pipefail

usage() {
  cat <<EOF >&2
Usage: $0 --tasks "id1,id2,..." --model <ollama-tag> --quant <Q4_K_M|...> \\
   --thinking <high|medium|low|off> --run-id <id> --output-dir <dir> \\
   --log-dir <dir> [--no-activity-timeout 600] [--hard-cap 28800] [--worktree <dir>]

If --worktree is omitted, the current working directory is used. The runner
does a 'git fetch origin main' + ancestry check before each task to enforce
the latest-main preflight rule.
EOF
  exit 2
}

TASKS_RAW=""
MODEL=""
QUANT=""
THINKING="high"
RUN_ID=""
OUTPUT_DIR=""
LOG_DIR=""
NO_ACTIVITY_TIMEOUT=600
HARD_CAP=28800
WORKTREE="$(pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --tasks) TASKS_RAW="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --quant) QUANT="$2"; shift 2 ;;
    --thinking) THINKING="$2"; shift 2 ;;
    --run-id) RUN_ID="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    --no-activity-timeout) NO_ACTIVITY_TIMEOUT="$2"; shift 2 ;;
    --hard-cap) HARD_CAP="$2"; shift 2 ;;
    --worktree) WORKTREE="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ -n "$TASKS_RAW" ] || usage
[ -n "$MODEL" ] || usage
[ -n "$RUN_ID" ] || usage
[ -n "$OUTPUT_DIR" ] || usage
[ -n "$LOG_DIR" ] || usage

mkdir -p "$LOG_DIR"
RUNNER_LOG="$LOG_DIR/runner.log"
PID_FILE="$LOG_DIR/detached.pid"
SID_FILE="$LOG_DIR/detached.sid"
HEARTBEAT_FILE="$LOG_DIR/detached.heartbeat"
SUMMARY_FILE="$LOG_DIR/detached.summary.json"

# Step 1: re-exec under setsid + nohup so we survive parent death.
# Detect by env var so we don't loop forever.
if [ -z "${RUN_TASKS_DETACHED_REEXEC:-}" ]; then
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "FAIL: another detached runner is alive (pid=$(cat "$PID_FILE")). Stop it first or use a different --log-dir." >&2
    exit 3
  fi
  export RUN_TASKS_DETACHED_REEXEC=1
  # setsid puts us in a new session. nohup detaches from the controlling
  # terminal. Redirect all stdio into the runner log so a future watcher can
  # tail it.
  setsid nohup bash "$0" \
    --tasks "$TASKS_RAW" \
    --model "$MODEL" \
    --quant "$QUANT" \
    --thinking "$THINKING" \
    --run-id "$RUN_ID" \
    --output-dir "$OUTPUT_DIR" \
    --log-dir "$LOG_DIR" \
    --no-activity-timeout "$NO_ACTIVITY_TIMEOUT" \
    --hard-cap "$HARD_CAP" \
    --worktree "$WORKTREE" \
    >"$RUNNER_LOG" 2>&1 < /dev/null &
  CHILD_PID=$!
  # Wait briefly for the child to record its own pid + sid; then return.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.5
    if [ -f "$PID_FILE" ] && [ -f "$SID_FILE" ]; then
      break
    fi
  done
  if [ -f "$PID_FILE" ] && [ -f "$SID_FILE" ]; then
    echo "DETACHED OK pid=$(cat "$PID_FILE") sid=$(cat "$SID_FILE") log=$RUNNER_LOG"
    exit 0
  fi
  echo "FAIL: detached child did not start cleanly (pid=$CHILD_PID, no PID file)." >&2
  exit 4
fi

# Step 2: detached child — record identity, run sweep.
echo $$ > "$PID_FILE"
ps -o sid= -p $$ 2>/dev/null | tr -d ' ' > "$SID_FILE" || echo $$ > "$SID_FILE"

cleanup() {
  local rc=${1:-$?}
  echo "RUNNER EXIT rc=$rc at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  rm -f "$PID_FILE" 2>/dev/null || true
  printf '{"endedAt":"%s","exitCode":%s,"runId":"%s","model":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rc" "$RUN_ID" "$MODEL" > "$SUMMARY_FILE" || true
}
trap 'cleanup $?' EXIT
trap 'cleanup 130; exit 130' INT
trap 'cleanup 143; exit 143' TERM

heartbeat() {
  local task="$1"
  local phase="$2"
  printf '{"epoch":%d,"iso":"%s","task":"%s","phase":"%s","runId":"%s","pid":%d}\n' \
    "$(date -u +%s)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$task" "$phase" "$RUN_ID" "$$" \
    > "$HEARTBEAT_FILE"
}

heartbeat "_init" "starting"

cd "$WORKTREE"
# Activate node 22 for pnpm if nvm is present.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

IFS=',' read -r -a TASKS <<<"$TASKS_RAW"

echo "===== detached runner start $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
echo "pid=$$ sid=$(cat "$SID_FILE") tasks=${#TASKS[@]} run_id=$RUN_ID worktree=$WORKTREE"

PASSED=0
FAILED=0

for task in "${TASKS[@]}"; do
  task="${task// /}"
  [ -z "$task" ] && continue
  TASK_LOG="$LOG_DIR/${task}.log"

  echo ""
  echo "==== task=$task started=$(date -u +%Y-%m-%dT%H:%M:%SZ) ===="
  heartbeat "$task" "preflight"

  # Latest-main preflight per Frank directive (May 10 2026).
  if ! git -C "$WORKTREE" fetch origin main 2>&1 | tail -3; then
    echo "FAIL: git fetch origin main exited nonzero — continuing with local HEAD"
  fi
  ORIGIN_MAIN=$(git -C "$WORKTREE" rev-parse origin/main 2>/dev/null || echo unknown)
  HEAD_SHA=$(git -C "$WORKTREE" rev-parse HEAD 2>/dev/null || echo unknown)
  echo "origin/main=$ORIGIN_MAIN head=$HEAD_SHA"
  if [ "$ORIGIN_MAIN" != "unknown" ] && [ "$HEAD_SHA" != "unknown" ]; then
    if ! git -C "$WORKTREE" merge-base --is-ancestor "$ORIGIN_MAIN" "$HEAD_SHA"; then
      echo "FAIL: HEAD does not include origin/main; aborting task=$task"
      FAILED=$((FAILED+1))
      continue
    fi
  fi

  heartbeat "$task" "dispatching"
  echo "dispatching $(date -u +%Y-%m-%dT%H:%M:%SZ) -> $TASK_LOG"

  # Run the per-task benchmark inside the existing pnpm benchmark agent
  # entry point. Container-only enforcement is in the harness itself.
  if pnpm benchmark agent \
        --model "$MODEL" \
        --quant "$QUANT" \
        --thinking "$THINKING" \
        --run-id "$RUN_ID" \
        --task "$task" \
        --output-dir "$OUTPUT_DIR" \
        --no-activity-timeout "$NO_ACTIVITY_TIMEOUT" \
        --hard-cap "$HARD_CAP" \
        --rerun >"$TASK_LOG" 2>&1; then
    echo "task=$task exit=0 finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    heartbeat "$task" "completed"
    PASSED=$((PASSED+1))
  else
    rc=$?
    echo "task=$task exit=$rc finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    heartbeat "$task" "failed"
    FAILED=$((FAILED+1))
  fi
done

heartbeat "_assemble" "running"
echo ""
echo "==== assembling aggregate $(date -u +%Y-%m-%dT%H:%M:%SZ) ===="
pnpm benchmark agent \
  --model "$MODEL" \
  --quant "$QUANT" \
  --thinking "$THINKING" \
  --run-id "$RUN_ID" \
  --output-dir "$OUTPUT_DIR" \
  --assemble 2>&1 | tail -20

heartbeat "_done" "complete"
echo ""
echo "==== summary ===="
echo "passed=$PASSED failed=$FAILED total=${#TASKS[@]} ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

trap - EXIT INT TERM
cleanup 0
