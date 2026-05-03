import { formatCliCommand } from "../cli/command-format.js";
import { listRouteBindings } from "../config/bindings.js";
import type { AgentRouteBinding } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { describeBinding } from "./agents.bindings.js";
import { requireValidConfig } from "./agents.command-shared.js";
import { resolveAgentsSshInfo } from "./agents.commands.ssh.js";
import type { AgentSummary } from "./agents.config.js";
import { buildAgentSummaries } from "./agents.config.js";
import {
  buildProviderStatusIndex,
  listProvidersForAgent,
  summarizeBindings,
} from "./agents.providers.js";

type AgentsListOptions = {
  json?: boolean;
  bindings?: boolean;
  configuredOnly?: boolean;
};

function formatSummary(summary: AgentSummary) {
  const defaultTag = summary.isDefault ? " (default)" : "";
  const header =
    summary.name && summary.name !== summary.id
      ? `${summary.id}${defaultTag} (${summary.name})`
      : `${summary.id}${defaultTag}`;

  const identityParts = [];
  if (summary.identityEmoji) {
    identityParts.push(summary.identityEmoji);
  }
  if (summary.identityName) {
    identityParts.push(summary.identityName);
  }
  const identityLine = identityParts.length > 0 ? identityParts.join(" ") : null;
  const identitySource =
    summary.identitySource === "identity"
      ? "IDENTITY.md"
      : summary.identitySource === "config"
        ? "config"
        : null;

  const lines = [`- ${header}`];
  if (identityLine) {
    lines.push(`  Identity: ${identityLine}${identitySource ? ` (${identitySource})` : ""}`);
  }
  lines.push(`  Workspace: ${shortenHomePath(summary.workspace)}`);
  lines.push(`  Agent dir: ${shortenHomePath(summary.agentDir)}`);
  if (summary.model) {
    lines.push(`  Model: ${summary.model}`);
  }
  lines.push(`  Routing rules: ${summary.bindings}`);

  if (summary.routes?.length) {
    lines.push(`  Routing: ${summary.routes.join(", ")}`);
  }
  if (summary.providers?.length) {
    lines.push("  Providers:");
    for (const provider of summary.providers) {
      lines.push(`    - ${provider}`);
    }
  }

  if (summary.bindingDetails?.length) {
    lines.push("  Routing rules:");
    for (const binding of summary.bindingDetails) {
      lines.push(`    - ${binding}`);
    }
  }

  if (summary.shellAvailable === true) {
    lines.push(`  Container shell: available (gemmaclaw ssh ${summary.id})`);
  } else if (summary.shellAvailable === false) {
    lines.push(
      `  Container shell: unavailable — ${summary.shellUnavailableReason ?? "not container-backed"}`,
    );
  }

  return lines.join("\n");
}

export async function agentsListCommand(
  opts: AgentsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const summaries = buildAgentSummaries(cfg, {
    includeImplicitDefault: opts.configuredOnly !== true,
  });
  const bindingMap = new Map<string, AgentRouteBinding[]>();
  for (const binding of listRouteBindings(cfg)) {
    const agentId = normalizeAgentId(binding.agentId);
    const list = bindingMap.get(agentId) ?? [];
    list.push(binding);
    bindingMap.set(agentId, list);
  }

  if (opts.bindings) {
    for (const summary of summaries) {
      const bindings = bindingMap.get(summary.id) ?? [];
      if (bindings.length > 0) {
        summary.bindingDetails = bindings.map((binding) => describeBinding(binding));
      }
    }
  }

  const providerStatus = await buildProviderStatusIndex(cfg);
  const sshInfoMap = await resolveAgentsSshInfo(
    summaries.map((s) => s.id),
    cfg,
  );

  for (const summary of summaries) {
    const bindings = bindingMap.get(summary.id) ?? [];
    const routes = summarizeBindings(cfg, bindings);
    if (routes.length > 0) {
      summary.routes = routes;
    } else if (summary.isDefault) {
      summary.routes = ["default (no explicit rules)"];
    }

    const providerLines = listProvidersForAgent({
      summaryIsDefault: summary.isDefault,
      cfg,
      bindings,
      providerStatus,
    });
    if (providerLines.length > 0) {
      summary.providers = providerLines;
    }

    const sshInfo = sshInfoMap.get(normalizeAgentId(summary.id));
    if (sshInfo) {
      if (!sshInfo.containerBacked) {
        summary.shellAvailable = false;
        summary.shellUnavailableReason = sshInfo.unavailableReason;
      } else {
        const hasRunning = sshInfo.containers.some((c) => c.running);
        if (hasRunning) {
          summary.shellAvailable = true;
        } else if (sshInfo.containers.length === 0) {
          summary.shellAvailable = false;
          summary.shellUnavailableReason = "no container registered — start a session first";
        } else {
          summary.shellAvailable = false;
          summary.shellUnavailableReason = "container stopped — start a session first";
        }
      }
    }
  }

  if (opts.json) {
    writeRuntimeJson(runtime, summaries);
    return;
  }

  if (summaries.length === 0) {
    runtime.log("No agents configured. Run 'gemmaclaw create <name>' to create an instance first.");
    return;
  }

  const lines = ["Agents:", ...summaries.map(formatSummary)];
  lines.push("Routing rules map channel/account/peer to an agent. Use --bindings for full rules.");
  lines.push(
    `Channel status reflects local config/creds. For live health: ${formatCliCommand("openclaw channels status --probe")}.`,
  );
  runtime.log(lines.join("\n"));
}
