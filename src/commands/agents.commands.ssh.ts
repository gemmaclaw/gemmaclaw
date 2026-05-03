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
  containerBacked: boolean;
  unavailableReason?: string;
  containers: ReadonlyArray<{
    containerName: string;
    backendId: string;
    running: boolean;
  }>;
};

export type AgentsSshOptions = {
  agent?: string;
  nonInteractive?: boolean;
};

function detectContainerRuntime(): ContainerRuntime | null {
  for (const rt of ["podman", "docker"] as ContainerRuntime[]) {
    const result = spawnSync(rt, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (result.status === 0) {
      return rt;
    }
  }
  return null;
}

function isContainerRunning(runtime: ContainerRuntime, containerName: string): boolean {
  const result = spawnSync(runtime, ["inspect", "--format", "{{.State.Running}}", containerName], {
    encoding: "utf8",
    timeout: 5000,
  });
  return result.status === 0 && result.stdout.trim() === "true";
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
      containerBacked: false,
      unavailableReason: "sandbox mode is off (not container-backed)",
      containers: [],
    };
  }

  if (sandboxCfg.backend !== "docker") {
    return {
      agentId: normalized,
      containerBacked: false,
      unavailableReason: `sandbox backend is "${sandboxCfg.backend}", not docker`,
      containers: [],
    };
  }

  const registry = await readRegistry();
  const agentContainers = registry.entries.filter((entry) => {
    const resolvedId = resolveSandboxAgentId(entry.sessionKey);
    return resolvedId !== undefined && normalizeAgentId(resolvedId) === normalized;
  });

  const containerRuntime = detectContainerRuntime();
  const containers = agentContainers.map((entry) => ({
    containerName: entry.containerName,
    backendId: entry.backendId ?? "docker",
    running: containerRuntime ? isContainerRunning(containerRuntime, entry.containerName) : false,
  }));

  return {
    agentId: normalized,
    containerBacked: true,
    containers,
  };
}

function openShell(containerName: string): void {
  const runtime = detectContainerRuntime();
  if (!runtime) {
    throw new Error(
      "No container runtime found. Install Docker or Podman to use container shell access.",
    );
  }

  const result = spawnSync(runtime, ["exec", "-it", containerName, "/bin/bash"], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    const fallback = spawnSync(runtime, ["exec", "-it", containerName, "/bin/sh"], {
      stdio: "inherit",
    });
    if (fallback.status !== 0 && fallback.status !== null) {
      process.exitCode = fallback.status;
    }
    return;
  }

  if (result.status !== null && result.status !== 0) {
    process.exitCode = result.status;
  }
}

async function promptAgentSelection(
  candidates: Array<{ info: AgentContainerInfo; displayName: string }>,
): Promise<AgentContainerInfo | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log("\nRegistered agents:");
    candidates.forEach((c, i) => {
      const idx = String(i + 1).padStart(2);
      if (c.info.containerBacked) {
        const running = c.info.containers.some((cn) => cn.running);
        const status = running ? "running" : "container stopped";
        console.log(`  ${idx}. ${c.displayName} [${status}]`);
      } else {
        console.log(
          `  ${idx}. ${c.displayName} [unavailable: ${c.info.unavailableReason ?? "not container-backed"}]`,
        );
      }
    });
    console.log("");

    return await new Promise((resolve) => {
      rl.question("Select agent (number or name, ctrl+c to cancel): ", (answer) => {
        const trimmed = answer.trim();
        const num = Number.parseInt(trimmed, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= candidates.length) {
          resolve(candidates[num - 1].info);
          return;
        }
        const found = candidates.find(
          (c) => normalizeAgentId(c.info.agentId) === normalizeAgentId(trimmed),
        );
        resolve(found?.info ?? null);
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
    const summaries = buildAgentSummaries(cfg, { includeImplicitDefault: true });
    const exists = summaries.some((s) => normalizeAgentId(s.id) === agentId);
    if (!exists) {
      runtime.error(
        `Agent "${opts.agent}" is not registered. Run 'gemmaclaw list' to see configured agents.`,
      );
      process.exitCode = 1;
      return;
    }
    targetInfo = await resolveAgentContainerInfo(agentId, cfg);
  } else {
    const summaries = buildAgentSummaries(cfg, { includeImplicitDefault: true });

    if (summaries.length === 0) {
      runtime.error(
        "No agents configured. Run 'gemmaclaw create <name>' or 'gemmaclaw setup' first.",
      );
      process.exitCode = 1;
      return;
    }

    const isTTY = process.stdin.isTTY && process.stdout.isTTY;
    if (!isTTY || opts.nonInteractive) {
      runtime.error(
        "No agent specified. Usage: gemmaclaw ssh <agent>\n" +
          "Run 'gemmaclaw list' to see configured agents.",
      );
      process.exitCode = 1;
      return;
    }

    const candidates = await Promise.all(
      summaries.map(async (s) => ({
        info: await resolveAgentContainerInfo(s.id, cfg),
        displayName: s.name && s.name !== s.id ? `${s.id} (${s.name})` : s.id,
      })),
    );

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
          `Start a session first so the sandbox container is created, then re-run this command.`,
      );
    } else {
      runtime.error(
        `Container for agent "${targetInfo.agentId}" is not running.\n` +
          `Start a session for this agent first, then re-run this command.`,
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
  openShell(container.containerName);
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
