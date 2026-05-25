#!/usr/bin/env bash
# Live Gemmaclaw container-agent smoke.
#
# Verifies that `gemmaclaw setup --setup-mode gemini` produces a Docker-backed
# OpenClaw agent that can operate freely inside its own container while only
# writing through the expected workspace and shared-folder host mounts.
#
# Requires Docker and a Gemini API key. Without a key this script skips unless
# GEMMACLAW_CONTAINER_AGENT_SMOKE_REQUIRED=1 is set.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

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

use_node_22

KEY="${GEMMACLAW_CONTAINER_AGENT_SMOKE_GEMINI_API_KEY:-${GEMINI_API_KEY:-}}"
if [ -z "$KEY" ]; then
  if [ "${GEMMACLAW_CONTAINER_AGENT_SMOKE_REQUIRED:-0}" = "1" ]; then
    echo "FAIL: GEMINI_API_KEY or GEMMACLAW_CONTAINER_AGENT_SMOKE_GEMINI_API_KEY is required" >&2
    exit 1
  fi
  echo "SKIP: Gemmaclaw container-agent live smoke requires GEMINI_API_KEY."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: docker is required for Gemmaclaw container-agent smoke" >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "FAIL: Docker daemon is not reachable" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/dist/entry.js" ]; then
  pnpm build
fi

SMOKE_ID="gc-container-smoke-$(date +%s)-$$"
AGENT_NAME="container-smoke"
SESSION_ID="$SMOKE_ID"
E2E_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gemmaclaw-container-agent-smoke.XXXXXX")"
HOME_DIR="$E2E_ROOT/home"
OUTSIDE_DIR="$E2E_ROOT/host-outside"
OUTSIDE_SENTINEL="$OUTSIDE_DIR/sentinel.txt"
OUTSIDE_MARKER="$OUTSIDE_DIR/container-write-marker.txt"
AGENT_JSON="$E2E_ROOT/agent.json"
CONTAINER_NAME=""
cleanup() {
  local status=$?
  if [ -n "$CONTAINER_NAME" ]; then
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  else
    docker rm -f $(docker ps -a --filter "label=openclaw.sessionKey=agent:${AGENT_NAME}:main" --format '{{.Names}}') >/dev/null 2>&1 || true
  fi
  if [ "$status" -eq 0 ]; then
    if [ -d "$E2E_ROOT" ]; then
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
printf 'HOST_SENTINEL_ORIGINAL\n' > "$OUTSIDE_SENTINEL"

echo "==> Running Gemmaclaw setup into isolated HOME"
HOME="$HOME_DIR" GEMINI_API_KEY="$KEY" node dist/entry.js setup \
  --non-interactive \
  --accept-risk \
  --agent-name "$AGENT_NAME" \
  --setup-mode gemini \
  --model gemini-2.5-flash \
  --thinking off \
  --bootstrap coding >/dev/null

HOME="$HOME_DIR" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const home = process.env.HOME;
const cfg = JSON.parse(fs.readFileSync(path.join(home, ".openclaw", "openclaw.json"), "utf8"));
const sandbox = cfg.agents?.defaults?.sandbox;
const docker = sandbox?.docker;
const sharedDir = path.join(home, ".gemmaclaw", "shared");
const workspaceDir = path.join(home, ".openclaw", "workspaces", "container-smoke");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
function mode(target) {
  return (fs.statSync(target).mode & 0o777).toString(8);
}

if (cfg.agents?.defaults?.model !== "google/gemini-2.5-flash") {
  fail(`unexpected model ${cfg.agents?.defaults?.model}`);
}
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
  fail(`capDrop must be empty for package-manager behavior, got ${JSON.stringify(docker?.capDrop)}`);
}
const setupCommand = String(docker?.setupCommand ?? "");
for (const pkg of ["git", "python3", "jq", "ripgrep", "file", "unzip", "wget", "procps", "less"]) {
  if (!setupCommand.includes(pkg)) {
    fail(`setupCommand must install ${pkg}`);
  }
}
if (!setupCommand.includes("apt-get-retry")) {
  fail("setupCommand must install the retry-aware apt helper");
}
if (!setupCommand.includes("99gemmaclaw-network-retries")) {
  fail("setupCommand must install apt network retry config");
}
if (cfg.tools?.exec?.security !== "full" || cfg.tools?.exec?.ask !== "off") {
  fail(`exec policy is not full/off: ${JSON.stringify(cfg.tools?.exec)}`);
}
if (mode(sharedDir) !== "777" || mode(workspaceDir) !== "777") {
  fail(`bind host dirs must be mode 777, got shared=${mode(sharedDir)} workspace=${mode(workspaceDir)}`);
}
console.log("setup-config-ok");
NODE

PROMPT=$(cat <<PROMPT_EOF
Use your exec tool to run shell commands inside the Docker container. Do not just explain.

Run these checks:
1. Print whoami, id, pwd, and uname -a.
2. Install cowsay with apt-get-retry update and DEBIAN_FRONTEND=noninteractive apt-get-retry install -y cowsay.
3. Write WORKSPACE_WRITE_OK to /workspace/workspace_e2e.txt and read it back.
4. Write SHARED_WRITE_OK to /workspace/shared/shared_e2e.txt and read it back.
5. Write MOVED_SHARED_OK to /workspace/moved_e2e.txt, move it to /workspace/shared/moved_e2e.txt, then read it back from /workspace/shared/moved_e2e.txt.
6. git clone --depth 1 --filter=blob:none --no-checkout https://github.com/octocat/Hello-World.git /workspace/cloned-repo-smoke, then write the clone HEAD to /workspace/shared/clone_head.txt.
7. Using the exec tool, run a shell check for this host-only sentinel path and report whether it is visible inside the container: $OUTSIDE_SENTINEL
8. Using the exec tool, attempt to write OUTSIDE_WRITE_ATTEMPTED to this host-only marker path and report the shell result: $OUTSIDE_MARKER

The outside path tests are expected not to affect the host. Complete the in-container tasks, then reply with the command outputs.
PROMPT_EOF
)

echo "==> Running live agent container capability probe"
HOME="$HOME_DIR" GEMINI_API_KEY="$KEY" node dist/entry.js agent \
  --local \
  --agent "$AGENT_NAME" \
  --session-id "$SESSION_ID" \
  --thinking off \
  --timeout "${GEMMACLAW_CONTAINER_AGENT_SMOKE_TIMEOUT:-900}" \
  --json \
  --message "$PROMPT" > "$AGENT_JSON"

CONTAINER_NAME="$(docker ps -a --filter "label=openclaw.sessionKey=agent:${AGENT_NAME}:main" --format '{{.Names}}' | head -n 1)"
if [ -z "$CONTAINER_NAME" ]; then
  echo "FAIL: no sandbox container found for $AGENT_NAME" >&2
  exit 1
fi

echo "==> Verifying host artifacts and container mount isolation"
SMOKE_HOME_DIR="$HOME_DIR" \
SMOKE_OUTSIDE_SENTINEL="$OUTSIDE_SENTINEL" \
SMOKE_OUTSIDE_MARKER="$OUTSIDE_MARKER" \
SMOKE_CONTAINER_NAME="$CONTAINER_NAME" \
node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const home = process.env.SMOKE_HOME_DIR;
const outsideSentinel = process.env.SMOKE_OUTSIDE_SENTINEL;
const outsideMarker = process.env.SMOKE_OUTSIDE_MARKER;
const containerName = process.env.SMOKE_CONTAINER_NAME;
const workspaceDir = path.join(home, ".openclaw", "workspaces", "container-smoke");
const sharedDir = path.join(home, ".gemmaclaw", "shared");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}
function read(file) {
  return fs.readFileSync(file, "utf8").trim();
}

if (read(path.join(workspaceDir, "workspace_e2e.txt")) !== "WORKSPACE_WRITE_OK") {
  fail("workspace_e2e.txt was not written through the workspace mount");
}
if (read(path.join(sharedDir, "shared_e2e.txt")) !== "SHARED_WRITE_OK") {
  fail("shared_e2e.txt was not written through the shared mount");
}
if (read(path.join(sharedDir, "moved_e2e.txt")) !== "MOVED_SHARED_OK") {
  fail("moved_e2e.txt was not moved into the shared mount");
}
fs.appendFileSync(path.join(sharedDir, "shared_e2e.txt"), "\nHOST_APPEND_OK\n");
if (!read(path.join(sharedDir, "shared_e2e.txt")).includes("HOST_APPEND_OK")) {
  fail("host could not append to shared_e2e.txt");
}
fs.appendFileSync(path.join(sharedDir, "moved_e2e.txt"), "\nHOST_APPEND_MOVED_OK\n");
if (!read(path.join(sharedDir, "moved_e2e.txt")).includes("HOST_APPEND_MOVED_OK")) {
  fail("host could not append to a file moved into the shared folder");
}
const cloneHead = read(path.join(sharedDir, "clone_head.txt"));
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
if (cloneHead !== actualHead) {
  fail(`clone head mismatch shared=${cloneHead} actual=${actualHead}`);
}
if (read(outsideSentinel) !== "HOST_SENTINEL_ORIGINAL") {
  fail("outside host sentinel was modified by the container");
}
if (fs.existsSync(outsideMarker)) {
  fail("container created a marker outside the configured host mounts");
}
const sharedStat = fs.statSync(path.join(sharedDir, "shared_e2e.txt"));
if ((sharedStat.mode & 0o006) !== 0o006) {
  fail(`shared_e2e.txt must remain host-readable and host-writable, mode=${(sharedStat.mode & 0o777).toString(8)}`);
}
const movedStat = fs.statSync(path.join(sharedDir, "moved_e2e.txt"));
if ((movedStat.mode & 0o006) !== 0o006) {
  fail(`moved_e2e.txt must remain host-readable and host-writable, mode=${(movedStat.mode & 0o777).toString(8)}`);
}

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

console.log(JSON.stringify({
  status: "ok",
  workspace: path.join(workspaceDir, "workspace_e2e.txt"),
  shared: path.join(sharedDir, "shared_e2e.txt"),
  cloneHead,
  bindSources: mounts.filter((m) => m.Type === "bind").map((m) => m.Source),
}, null, 2));
NODE

echo "==> Gemmaclaw container-agent smoke passed."
