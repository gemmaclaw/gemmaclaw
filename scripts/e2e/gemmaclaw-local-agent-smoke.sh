#!/usr/bin/env bash
# Live Gemmaclaw local-model agent smoke.
#
# Flow=container verifies `gemmaclaw setup` with Docker tool sandbox enabled.
# Flow=non-container verifies `gemmaclaw setup --no-container` from inside an
# outer Docker container, so the direct-host path is still isolated from the
# real host.
#
# This is a drift/bug detector. It must exercise the real Gemmaclaw wrapper
# (`gemmaclaw.mjs`) and product home (`~/.gemmaclaw`), not the internal
# OpenClaw entrypoint or `~/.openclaw` defaults.
#
# Defaults to qwen3.6:35b because it is a local MoE model that is capable enough
# to drive tools without relying on Gemini API quota.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

FLOW="${GEMMACLAW_LOCAL_AGENT_SMOKE_FLOW:-container}"
MODEL="${GEMMACLAW_LOCAL_AGENT_SMOKE_MODEL:-qwen3.6:35b}"
OLLAMA_URL="${GEMMACLAW_LOCAL_AGENT_SMOKE_OLLAMA_URL:-http://127.0.0.1:11434}"
REQUIRED="${GEMMACLAW_LOCAL_AGENT_SMOKE_REQUIRED:-0}"
ALLOW_DURING_BENCHMARK="${GEMMACLAW_LOCAL_AGENT_SMOKE_ALLOW_DURING_BENCHMARK:-0}"
SKIP_BENCHMARK_GUARD="${GEMMACLAW_LOCAL_AGENT_SMOKE_SKIP_BENCHMARK_GUARD:-0}"
TIMEOUT="${GEMMACLAW_LOCAL_AGENT_SMOKE_TIMEOUT:-1200}"
THINKING="${GEMMACLAW_LOCAL_AGENT_SMOKE_THINKING:-off}"

case "$FLOW" in
  container|non-container) ;;
  *)
    echo "FAIL: GEMMACLAW_LOCAL_AGENT_SMOKE_FLOW must be container or non-container, got $FLOW" >&2
    exit 1
    ;;
esac

use_node_22() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    source "$HOME/.nvm/nvm.sh"
    nvm use 22 >/dev/null
  fi

  node -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && minor < 14)) {
      console.error(`FAIL: node >=22.14 is required, got ${process.versions.node}`);
      process.exit(1);
    }
  '
}

skip_or_fail() {
  local message="$1"
  if [ "$REQUIRED" = "1" ]; then
    echo "FAIL: $message" >&2
    exit 1
  fi
  echo "SKIP: $message"
  exit 0
}

use_node_22

if [ "$FLOW" = "container" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    skip_or_fail "Docker is required for the container local-agent smoke"
  fi
  if ! docker info >/dev/null 2>&1; then
    skip_or_fail "Docker daemon is not reachable"
  fi
fi

if [ "$SKIP_BENCHMARK_GUARD" != "1" ] && [ "$ALLOW_DURING_BENCHMARK" != "1" ]; then
  if pgrep -af 'pnpm benchmark agent|src/gemmaclaw/benchmark/cli-standalone.ts agent' >/dev/null 2>&1; then
    skip_or_fail "an Ollama/Gemmaclaw benchmark is active; local-model smoke would disturb the loaded model"
  fi
fi

OLLAMA_URL_CHECK="$OLLAMA_URL" MODEL_CHECK="$MODEL" node <<'NODE' || skip_or_fail "Ollama model ${MODEL} is not ready at ${OLLAMA_URL}"
const base = process.env.OLLAMA_URL_CHECK;
const model = process.env.MODEL_CHECK;
const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
if (!res.ok) {
  throw new Error(`Ollama tags failed: HTTP ${res.status}`);
}
const data = await res.json();
const names = new Set((data.models ?? []).map((m) => m.name));
if (!names.has(model) && !names.has(`${model}:latest`)) {
  throw new Error(`Model not found: ${model}`);
}
NODE

if [ ! -f "$ROOT_DIR/dist/entry.js" ] || [ ! -f "$ROOT_DIR/openclaw.mjs" ] || [ ! -f "$ROOT_DIR/gemmaclaw.mjs" ]; then
  pnpm build
fi

SMOKE_ID="gc-local-${FLOW}-smoke-$(date +%s)-$$"
AGENT_NAME="${FLOW}-smoke"
SESSION_ID="$SMOKE_ID"
E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gemmaclaw-local-agent-smoke.XXXXXX")"
HOME_DIR="$E2E_ROOT/home"
OUTSIDE_DIR="$E2E_ROOT/host-outside"
OUTSIDE_SENTINEL="${GEMMACLAW_LOCAL_AGENT_SMOKE_HOST_SENTINEL_PATH:-$OUTSIDE_DIR/sentinel.txt}"
OUTSIDE_MARKER="${GEMMACLAW_LOCAL_AGENT_SMOKE_HOST_MARKER_PATH:-$OUTSIDE_DIR/container-write-marker.txt}"
AGENT_JSON="$E2E_ROOT/agent.json"
CONTAINER_NAME=""

cleanup() {
  local status=$?
  if [ -n "$CONTAINER_NAME" ]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  elif [ "$FLOW" = "container" ]; then
    docker rm -f $(docker ps -a --filter "label=openclaw.sessionKey=agent:${AGENT_NAME}:main" --format '{{.Names}}') >/dev/null 2>&1 || true
  fi
  if [ "$status" -eq 0 ]; then
    if [ -d "$E2E_ROOT" ] && command -v docker >/dev/null 2>&1; then
      docker run --rm -v "$E2E_ROOT:/cleanup-root" debian:bookworm-slim \
        sh -lc 'chmod -R a+rwX /cleanup-root' >/dev/null 2>&1 || true
    fi
    rm -rf "$E2E_ROOT"
  else
    echo "Preserving failed smoke artifacts at $E2E_ROOT" >&2
  fi
}
trap cleanup EXIT

mkdir -p "$HOME_DIR" "$OUTSIDE_DIR"
if [ -z "${GEMMACLAW_LOCAL_AGENT_SMOKE_HOST_SENTINEL_PATH:-}" ]; then
  printf 'HOST_SENTINEL_ORIGINAL\n' > "$OUTSIDE_SENTINEL"
fi

echo "==> Running Gemmaclaw local setup smoke ($FLOW) into isolated HOME"
setup_args=(
  setup
  --non-interactive
  --accept-risk
  --agent-name "$AGENT_NAME"
  --setup-mode local
  --model "$MODEL"
  --thinking "$THINKING"
  --bootstrap coding
  --dry-run
)
if [ "$FLOW" = "non-container" ]; then
  setup_args+=(--no-container)
fi

HOME="$HOME_DIR" node gemmaclaw.mjs "${setup_args[@]}" >/dev/null

SMOKE_HOME_DIR="$HOME_DIR" \
SMOKE_MODEL="$MODEL" \
SMOKE_OLLAMA_URL="$OLLAMA_URL" \
SMOKE_FLOW="$FLOW" \
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const home = process.env.SMOKE_HOME_DIR;
const model = process.env.SMOKE_MODEL;
const ollamaUrl = process.env.SMOKE_OLLAMA_URL;
const flow = process.env.SMOKE_FLOW;
const cfgPath = path.join(home, ".gemmaclaw", "openclaw.json");
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const sharedDir = path.join(home, ".gemmaclaw", "shared");
const workspaceDir = path.join(home, ".gemmaclaw", "workspaces", `${flow}-smoke`);
const agentsPath = path.join(workspaceDir, "AGENTS.md");
const toolsPath = path.join(workspaceDir, "TOOLS.md");
const internalCfgPath = path.join(home, ".openclaw", "openclaw.json");
const internalWorkspaceDir = path.join(home, ".openclaw", "workspaces", `${flow}-smoke`);

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
function mode(target) {
  return (fs.statSync(target).mode & 0o777).toString(8);
}

if (fs.existsSync(internalCfgPath) || fs.existsSync(internalWorkspaceDir)) {
  fail("Gemmaclaw smoke leaked state into ~/.openclaw instead of using ~/.gemmaclaw");
}
if (!fs.existsSync(agentsPath) || !fs.existsSync(toolsPath)) {
  fail(`setup did not create expected coding bootstrap profile files in ${workspaceDir}`);
}

cfg.models ??= {};
cfg.models.providers ??= {};
cfg.models.providers.ollama = {
  baseUrl: `${ollamaUrl}/v1`,
  api: "ollama",
  models: [
    {
      id: model,
      name: model,
      reasoning: true,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
};
cfg.agents ??= {};
cfg.agents.defaults ??= {};
cfg.agents.defaults.model = `ollama/${model}`;
cfg.tools ??= {};
cfg.tools.exec ??= {};
cfg.tools.exec.security = "full";
cfg.tools.exec.ask = "off";
fs.mkdirSync(sharedDir, { recursive: true });
fs.mkdirSync(workspaceDir, { recursive: true });

if (flow === "container") {
  fs.chmodSync(sharedDir, 0o777);
  fs.chmodSync(workspaceDir, 0o777);
  const sandbox = cfg.agents.defaults.sandbox;
  const docker = sandbox?.docker;
  if (!sandbox || sandbox.mode !== "all" || sandbox.backend !== "docker" || sandbox.scope !== "session") {
    fail(`unexpected sandbox config ${JSON.stringify(sandbox)}`);
  }
  if (sandbox.workspaceAccess !== "rw") {
    fail(`workspaceAccess must be rw, got ${sandbox.workspaceAccess}`);
  }
  if (!docker?.dangerouslyAllowExternalBindSources || !docker?.dangerouslyAllowReservedContainerTargets) {
    fail("Docker bind overrides are not set");
  }
  if (docker?.readOnlyRoot !== false || docker?.network !== "bridge" || docker?.user !== "0:0") {
    fail(`Docker container is not configured for full in-container control: ${JSON.stringify(docker)}`);
  }
  if (!Array.isArray(docker?.capDrop) || docker.capDrop.length !== 0) {
    fail(`capDrop must be empty, got ${JSON.stringify(docker?.capDrop)}`);
  }
  if (mode(sharedDir) !== "777" || mode(workspaceDir) !== "777") {
    fail(`bind host dirs must be mode 777, got shared=${mode(sharedDir)} workspace=${mode(workspaceDir)}`);
  }
} else if (cfg.agents.defaults.sandbox?.backend === "docker") {
  fail("non-container smoke unexpectedly enabled Docker sandbox");
}

fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log("setup-config-ok");
NODE

if [ "$FLOW" = "container" ]; then
  WORKSPACE_PATH="/workspace"
  SHARED_PATH="/workspace/shared"
else
  WORKSPACE_PATH="$HOME_DIR/.gemmaclaw/workspaces/${AGENT_NAME}"
  SHARED_PATH="$HOME_DIR/.gemmaclaw/shared"
fi

PROMPT=$(cat <<PROMPT_EOF
Use your exec tool to run shell commands. Do not just explain.

Run these checks:
1. Print whoami, id, pwd, and uname -a.
2. Install cowsay with apt-get -o APT::Sandbox::User=root update and DEBIAN_FRONTEND=noninteractive apt-get -o APT::Sandbox::User=root install -y cowsay.
3. Write WORKSPACE_WRITE_OK to $WORKSPACE_PATH/workspace_e2e.txt and read it back.
4. Write SHARED_WRITE_OK to $SHARED_PATH/shared_e2e.txt and read it back.
5. Write MOVED_SHARED_OK to $WORKSPACE_PATH/moved_e2e.txt, move it to $SHARED_PATH/moved_e2e.txt, then read it back from $SHARED_PATH/moved_e2e.txt.
6. git clone --depth 1 --filter=blob:none --no-checkout https://github.com/octocat/Hello-World.git $WORKSPACE_PATH/cloned-repo-smoke, then run git -C $WORKSPACE_PATH/cloned-repo-smoke rev-parse HEAD and write only that full commit hash to $SHARED_PATH/clone_head.txt.
7. Using the exec tool, run a shell check for this host-only sentinel path and report whether it is visible: $OUTSIDE_SENTINEL
8. Using the exec tool, attempt to write OUTSIDE_WRITE_ATTEMPTED to this host-only marker path and report the shell result: $OUTSIDE_MARKER

The outside path tests are expected not to affect the host. Complete the tasks, then reply with the command outputs.
PROMPT_EOF
)

echo "==> Running live local-model agent capability probe ($FLOW, $MODEL)"
HOME="$HOME_DIR" node gemmaclaw.mjs agent \
  --local \
  --agent "$AGENT_NAME" \
  --session-id "$SESSION_ID" \
  --thinking "$THINKING" \
  --timeout "$TIMEOUT" \
  --json \
  --message "$PROMPT" > "$AGENT_JSON"

if [ "$FLOW" = "container" ]; then
  CONTAINER_NAME="$(docker ps -a --filter "label=openclaw.sessionKey=agent:${AGENT_NAME}:main" --format '{{.Names}}' | head -n 1)"
  if [ -z "$CONTAINER_NAME" ]; then
    echo "FAIL: no sandbox container found for $AGENT_NAME" >&2
    exit 1
  fi
fi

echo "==> Verifying smoke artifacts and isolation ($FLOW)"
SMOKE_HOME_DIR="$HOME_DIR" \
SMOKE_OUTSIDE_SENTINEL="$OUTSIDE_SENTINEL" \
SMOKE_OUTSIDE_MARKER="$OUTSIDE_MARKER" \
SMOKE_CONTAINER_NAME="$CONTAINER_NAME" \
SMOKE_FLOW="$FLOW" \
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const home = process.env.SMOKE_HOME_DIR;
const outsideSentinel = process.env.SMOKE_OUTSIDE_SENTINEL;
const outsideMarker = process.env.SMOKE_OUTSIDE_MARKER;
const containerName = process.env.SMOKE_CONTAINER_NAME;
const flow = process.env.SMOKE_FLOW;
const workspaceDir = path.join(home, ".gemmaclaw", "workspaces", `${flow}-smoke`);
const sharedDir = path.join(home, ".gemmaclaw", "shared");
const internalWorkspaceDir = path.join(home, ".openclaw", "workspaces", `${flow}-smoke`);
const bootstrapPath = path.join(workspaceDir, "BOOTSTRAP.md");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
function read(file) {
  return fs.readFileSync(file, "utf8").trim();
}

if (fs.existsSync(internalWorkspaceDir)) {
  fail("agent runtime leaked workspace state into ~/.openclaw instead of ~/.gemmaclaw");
}
if (!fs.existsSync(bootstrapPath)) {
  fail("agent runtime did not seed BOOTSTRAP.md in the Gemmaclaw workspace");
}

if (read(path.join(workspaceDir, "workspace_e2e.txt")) !== "WORKSPACE_WRITE_OK") {
  fail("workspace_e2e.txt was not written");
}
if (read(path.join(sharedDir, "shared_e2e.txt")) !== "SHARED_WRITE_OK") {
  fail("shared_e2e.txt was not written");
}
if (read(path.join(sharedDir, "moved_e2e.txt")) !== "MOVED_SHARED_OK") {
  fail("moved_e2e.txt was not moved into the shared folder");
}
fs.appendFileSync(path.join(sharedDir, "shared_e2e.txt"), "\nHOST_APPEND_OK\n");
if (!read(path.join(sharedDir, "shared_e2e.txt")).includes("HOST_APPEND_OK")) {
  fail("host could not append to shared_e2e.txt");
}
const cloneHeadRaw = read(path.join(sharedDir, "clone_head.txt"));
const cloneHead = cloneHeadRaw.split(/\s+/u)[0] ?? "";
const cloneDir = path.join(workspaceDir, "cloned-repo-smoke");
if (!fs.existsSync(path.join(cloneDir, ".git"))) {
  fail("cloned-repo-smoke is not a git repository");
}
const actualHead = execFileSync("git", [
  "-c",
  `safe.directory=${cloneDir}`,
  "-C",
  cloneDir,
  "rev-parse",
  "HEAD",
], { encoding: "utf8" }).trim();
if (cloneHead !== actualHead && !actualHead.startsWith(cloneHead)) {
  fail(`clone head mismatch shared=${cloneHeadRaw} actual=${actualHead}`);
}
if (fs.existsSync(outsideSentinel) && read(outsideSentinel) !== "HOST_SENTINEL_ORIGINAL") {
  fail("outside host sentinel was modified");
}
if (fs.existsSync(outsideMarker)) {
  fail("agent created a marker outside the configured test area");
}

let bindSources = [];
if (flow === "container") {
  const mounts = JSON.parse(execFileSync("docker", [
    "inspect",
    "--format",
    "{{json .Mounts}}",
    containerName,
  ], { encoding: "utf8" }));
  const allowedSources = new Set([path.resolve(workspaceDir), path.resolve(sharedDir)]);
  for (const mount of mounts) {
    if (mount.Type !== "bind") {
      continue;
    }
    const source = path.resolve(mount.Source);
    if (!allowedSources.has(source)) {
      fail(`unexpected host bind source ${source}`);
    }
  }
  bindSources = mounts.filter((m) => m.Type === "bind").map((m) => m.Source);
}

console.log(JSON.stringify({
  status: "ok",
  flow,
  workspace: path.join(workspaceDir, "workspace_e2e.txt"),
  shared: path.join(sharedDir, "shared_e2e.txt"),
  cloneHead,
  bindSources,
}, null, 2));
NODE

echo "==> Gemmaclaw local-agent smoke passed ($FLOW)."
