import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { readRegistry } from "../agents/sandbox/registry.js";
import { resolveSandboxAgentId } from "../agents/sandbox/shared.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { buildAgentSummaries } from "./agents.config.js";

type ContainerRuntime = "docker" | "podman";

export type AgentContainerInfo = {
  agentId: string;
  sandboxMode: string;
  sandboxBackend: string;
  containerBacked: boolean;
  unavailableReason?: string;
  shellAvailable: boolean;
  shellUnavailableReason?: string;
  containers: ReadonlyArray<{
    containerName: string;
    backendId: string;
    exists: boolean;
    running: boolean;
  }>;
};

export type AgentsSshOptions = {
  agent?: string;
  nonInteractive?: boolean;
};

function resolveContainerRuntimeCommand(backendId: string | undefined): ContainerRuntime | null {
  const normalized = (backendId ?? "docker").trim().toLowerCase();
  if (normalized === "docker" || normalized === "podman") {
    return normalized;
  }
  return null;
}

function isContainerRuntimeAvailable(runtime: ContainerRuntime): boolean {
  const result = spawnSync(runtime, ["--version"], { encoding: "utf8", timeout: 5000 });
  return result.status === 0;
}

function inspectContainerState(runtime: ContainerRuntime, containerName: string) {
  const result = spawnSync(runtime, ["inspect", "--format", "{{.State.Running}}", containerName], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) {
    return { exists: false, running: false };
  }
  return { exists: true, running: result.stdout.trim() === "true" };
}

function summarizeShellUnavailableReason(info: AgentContainerInfo): string | undefined {
  if (!info.containerBacked) {
    return info.unavailableReason ?? "not container-backed";
  }
  if (info.containers.length === 0) {
    return "no container registered — start a session first";
  }
  if (!info.containers.some((c) => c.exists)) {
    return "container missing — start a session first";
  }
  if (!info.containers.some((c) => c.running)) {
    return "container stopped — start a session first";
  }
  return undefined;
}

async function resolveAgentContainerInfo(
  agentId: string,
  cfg: Awaited<ReturnType<typeof requireValidConfig>>,
): Promise<AgentContainerInfo> {
  const normalized = normalizeAgentId(agentId);
  const sandboxCfg = resolveSandboxConfigForAgent(cfg ?? undefined, normalized);

  if (sandboxCfg.mode === "off") {
    return {
      agentId: normalized,
      sandboxMode: sandboxCfg.mode,
      sandboxBackend: sandboxCfg.backend,
      containerBacked: false,
      unavailableReason: "sandbox mode is off (not container-backed)",
      shellAvailable: false,
      shellUnavailableReason: "sandbox mode is off (not container-backed)",
      containers: [],
    };
  }

  if (sandboxCfg.backend !== "docker") {
    const reason = `sandbox backend is "${sandboxCfg.backend}", not docker`;
    return {
      agentId: normalized,
      sandboxMode: sandboxCfg.mode,
      sandboxBackend: sandboxCfg.backend,
      containerBacked: false,
      unavailableReason: reason,
      shellAvailable: false,
      shellUnavailableReason: reason,
      containers: [],
    };
  }

  const registry = await readRegistry();
  const agentContainers = registry.entries.filter((entry) => {
    const resolvedId = resolveSandboxAgentId(entry.sessionKey);
    return resolvedId !== undefined && normalizeAgentId(resolvedId) === normalized;
  });

  const runtimeAvailability = new Map<string, boolean>();
  const containers = agentContainers.map((entry) => {
    const backendId = entry.backendId ?? "docker";
    const runtime = resolveContainerRuntimeCommand(backendId);
    if (!runtime) {
      return {
        containerName: entry.containerName,
        backendId,
        exists: false,
        running: false,
      };
    }
    let available = runtimeAvailability.get(runtime);
    if (available === undefined) {
      available = isContainerRuntimeAvailable(runtime);
      runtimeAvailability.set(runtime, available);
    }
    const state = available
      ? inspectContainerState(runtime, entry.containerName)
      : { exists: false, running: false };
    return {
      containerName: entry.containerName,
      backendId,
      exists: state.exists,
      running: state.running,
    };
  });

  const info: AgentContainerInfo = {
    agentId: normalized,
    sandboxMode: sandboxCfg.mode,
    sandboxBackend: sandboxCfg.backend,
    containerBacked: true,
    shellAvailable: containers.some((container) => container.running),
    containers,
  };

  if (!info.shellAvailable) {
    info.shellUnavailableReason = summarizeShellUnavailableReason(info);
  }
  return info;
}

function openShell(containerName: string, backendId: string): void {
  const runtime = resolveContainerRuntimeCommand(backendId);
  if (!runtime) {
    throw new Error(`Unsupported container runtime "${backendId}" for shell access.`);
  }
  if (!isContainerRuntimeAvailable(runtime)) {
    throw new Error(`Container runtime "${runtime}" was not found in PATH.`);
  }

  const result = spawnSync(runtime, ["exec", "-it", containerName, "/bin/bash"], {
    stdio: "inherit",
  });

  // Fall back to /bin/sh only when bash is unavailable in the container.
  // Exit codes 126 (not executable) and 127 (not found) are standard POSIX signals for an
  // unavailable command; a spawn error (e.g. ENOENT) means the runtime itself couldn't find
  // bash. Any other exit code is the user's interactive bash exit and must be preserved as-is.
  const bashUnavailable = result.error != null || result.status === 126 || result.status === 127;
  if (bashUnavailable) {
    const fallback = spawnSync(runtime, ["exec", "-it", containerName, "/bin/sh"], {
      stdio: "inherit",
    });
    if (fallback.status !== null && fallback.status !== 0) {
      process.exitCode = fallback.status;
    }
    return;
  }

  if (result.status !== null && result.status !== 0) {
    process.exitCode = result.status;
  }
}

function getContainerUnavailableReason(info: AgentContainerInfo): string | null {
  return info.shellAvailable ? null : (info.shellUnavailableReason ?? "not container-backed");
}

type AgentSshCandidate = { info: AgentContainerInfo; displayName: string; name?: string };

function candidateMatchesInput(candidate: AgentSshCandidate, input: string): boolean {
  const normalized = normalizeAgentId(input);
  return (
    normalizeAgentId(candidate.info.agentId) === normalized ||
    (candidate.name ? normalizeAgentId(candidate.name) === normalized : false)
  );
}

function formatNonInteractiveNoAgentError(candidates: AgentSshCandidate[]): string {
  const lines = ["No agent specified. Usage: gemmaclaw ssh <agent>"];
  const eligible = candidates.filter(
    (candidate) => getContainerUnavailableReason(candidate.info) === null,
  );
  if (eligible.length > 0) {
    lines.push("Eligible container-backed agents with running containers:");
    for (const candidate of eligible) {
      lines.push(`  - ${candidate.info.agentId} (gemmaclaw ssh ${candidate.info.agentId})`);
    }
  } else {
    lines.push("No configured agents currently have a running container shell.");
  }
  lines.push("Run 'gemmaclaw list' to inspect configured agents and container status.");
  return lines.join("\n");
}

async function promptAgentSelection(
  candidates: AgentSshCandidate[],
): Promise<AgentContainerInfo | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\nRegistered agents:");
    candidates.forEach((c, i) => {
      const idx = String(i + 1).padStart(2);
      const reason = getContainerUnavailableReason(c.info);
      if (reason === null) {
        console.log(`  ${idx}. ${c.displayName} [container running]`);
      } else {
        console.log(`  ${idx}. ${c.displayName} [unavailable: ${reason}]`);
      }
    });
    console.log("");

    return await new Promise((resolve) => {
      rl.question("Select agent (number or name, ctrl+c to cancel): ", (answer) => {
        const trimmed = answer.trim();
        const num = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= candidates.length) {
          const candidate = candidates[num - 1];
          const reason = getContainerUnavailableReason(candidate.info);
          if (reason !== null) {
            console.error(`  Agent "${candidate.info.agentId}" is unavailable: ${reason}`);
            resolve(null);
            return;
          }
          resolve(candidate.info);
          return;
        }
        const found = candidates.find((c) => candidateMatchesInput(c, trimmed));
        if (found) {
          const reason = getContainerUnavailableReason(found.info);
          if (reason !== null) {
            console.error(`  Agent "${found.info.agentId}" is unavailable: ${reason}`);
            resolve(null);
            return;
          }
          resolve(found.info);
          return;
        }
        resolve(null);
      });
    });
  } finally {
    rl.close();
  }
}

export async function agentsSshCommand(
  opts: AgentsSshOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  let targetInfo: AgentContainerInfo | null = null;

  if (opts.agent) {
    const agentId = normalizeAgentId(opts.agent);
    const summaries = buildAgentSummaries(cfg, { includeImplicitDefault: false });
    const exactMatch = summaries.find((s) => normalizeAgentId(s.id) === agentId);
    const nameMatch = summaries.find((s) => s.name && normalizeAgentId(s.name) === agentId);
    const summary = exactMatch ?? nameMatch;
    if (!summary) {
      runtime.error(
        `Agent "${opts.agent}" is not registered. Run 'gemmaclaw list' to see configured agents and container status.`,
      );
      process.exitCode = 1;
      return;
    }
    targetInfo = await resolveAgentContainerInfo(summary.id, cfg);
  } else {
    const summaries = buildAgentSummaries(cfg, { includeImplicitDefault: false });

    if (summaries.length === 0) {
      runtime.error(
        "No agents configured. Run 'gemmaclaw create <name>' or 'gemmaclaw setup' first.",
      );
      process.exitCode = 1;
      return;
    }

    const candidates = await Promise.all(
      summaries.map(async (s) => ({
        info: await resolveAgentContainerInfo(s.id, cfg),
        displayName: s.name && s.name !== s.id ? `${s.id} (${s.name})` : s.id,
        name: s.name,
      })),
    );

    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (!isTTY || opts.nonInteractive) {
      runtime.error(formatNonInteractiveNoAgentError(candidates));
      process.exitCode = 1;
      return;
    }

    const selected = await promptAgentSelection(candidates);
    if (!selected) {
      runtime.error("No valid agent selected.");
      process.exitCode = 1;
      return;
    }
    targetInfo = selected;
  }

  if (!targetInfo.containerBacked) {
    runtime.error(
      `Agent "${targetInfo.agentId}" does not have a container-backed sandbox.\n` +
        `Reason: ${targetInfo.unavailableReason ?? "not container-backed"}\n\n` +
        `Run 'gemmaclaw list' to inspect configured agents and container status. ` +
        `To enable container mode, run 'gemmaclaw setup' and choose the Docker sandbox option.`,
    );
    process.exitCode = 1;
    return;
  }

  const runningContainers = targetInfo.containers.filter((c) => c.running);

  if (runningContainers.length === 0) {
    if (targetInfo.containers.length === 0) {
      runtime.error(
        `No containers found for agent "${targetInfo.agentId}".\n` +
          `Start/chat/run this agent first so the sandbox container is created, then re-run this command. Run 'gemmaclaw list' to inspect container status.`,
      );
    } else {
      runtime.error(
        `Container for agent "${targetInfo.agentId}" is not running.\n` +
          `Start/chat/run this agent first, then re-run this command. Run 'gemmaclaw list' to inspect container status.`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const container = runningContainers[0];
  runtime.log(
    `Opening shell in container ${container.containerName} (agent: ${targetInfo.agentId})...`,
  );
  runtime.log(
    `Note: this opens a container shell via '${container.backendId} exec', not a network SSH connection.`,
  );
  openShell(container.containerName, container.backendId);
}

export async function resolveAgentsSshInfo(
  agentIds: string[],
  cfg: Awaited<ReturnType<typeof requireValidConfig>>,
): Promise<Map<string, AgentContainerInfo>> {
  const result = new Map<string, AgentContainerInfo>();
  for (const agentId of agentIds) {
    result.set(normalizeAgentId(agentId), await resolveAgentContainerInfo(agentId, cfg));
  }
  return result;
}
