import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { resolveUserPath, shortenHomePath } from "../utils.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import { requireValidConfigFileSnapshot } from "./agents.command-shared.js";
import { applyAgentConfig, findAgentEntryIndex, listAgentEntries } from "./agents.config.js";
import { ensureWorkspaceAndSessions } from "./onboard-helpers.js";

export type CreateCommandOpts = {
  name?: string;
  workspace?: string;
  model?: string;
  agentDir?: string;
  nonInteractive?: boolean;
  json?: boolean;
};

export type CreateCommandParams = {
  hasFlags?: boolean;
  isTty?: boolean;
};

const RESERVED_AGENT_IDS = new Set([DEFAULT_AGENT_ID]);

type CreateAgentConfigParams = Parameters<typeof applyAgentConfig>[1];

function applyCreateAgentConfig(
  cfg: Parameters<typeof applyAgentConfig>[0],
  params: CreateAgentConfigParams,
) {
  const existingEntries = listAgentEntries(cfg);
  const nextConfig = applyAgentConfig(cfg, params);
  if (existingEntries.length > 0) {
    return nextConfig;
  }

  const agentId = normalizeAgentId(params.agentId);
  return {
    ...nextConfig,
    agents: {
      ...nextConfig.agents,
      list: (nextConfig.agents?.list ?? []).filter(
        (entry) => normalizeAgentId(entry?.id) === agentId,
      ),
    },
  };
}

function reportError(runtime: RuntimeEnv, message: string): void {
  runtime.error(message);
  runtime.exit(1);
}

function validateAgentId(runtime: RuntimeEnv, raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    reportError(runtime, "Agent name cannot be empty.");
    return undefined;
  }
  const normalized = normalizeAgentId(trimmed);
  if (RESERVED_AGENT_IDS.has(normalized)) {
    reportError(runtime, `"${normalized}" is reserved. Choose another name.`);
    return undefined;
  }
  return normalized;
}

export async function createCommand(
  opts: CreateCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  params: CreateCommandParams = {},
): Promise<void> {
  const snapshot = await requireValidConfigFileSnapshot(runtime);
  if (!snapshot) {
    return;
  }
  const cfg = snapshot.sourceConfig ?? snapshot.config;
  const baseHash = snapshot.hash;

  const nameInput = opts.name?.trim();
  const hasFlags = params.hasFlags === true;
  const isTty = params.isTty ?? ((process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false));
  const nonInteractive = opts.nonInteractive === true || hasFlags || !isTty;

  if (nonInteractive) {
    if (!nameInput) {
      reportError(
        runtime,
        "Agent name is required. Pass it as the first argument or via --name. Run from a TTY for interactive mode.",
      );
      return;
    }
    const agentId = validateAgentId(runtime, nameInput);
    if (!agentId) {
      return;
    }
    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      reportError(
        runtime,
        `Agent "${agentId}" already exists. Use 'gemmaclaw list' to see configured agents, or pick another name.`,
      );
      return;
    }
    if (agentId !== nameInput) {
      runtime.log(`Normalized agent id to "${agentId}".`);
    }

    const workspaceDir = opts.workspace?.trim()
      ? resolveUserPath(opts.workspace.trim())
      : resolveAgentWorkspaceDir(cfg, agentId);
    const agentDir = opts.agentDir?.trim()
      ? resolveUserPath(opts.agentDir.trim())
      : resolveAgentDir(cfg, agentId);
    const model = opts.model?.trim();

    const nextConfig = applyCreateAgentConfig(cfg, {
      agentId,
      name: nameInput,
      workspace: workspaceDir,
      agentDir,
      ...(model ? { model } : {}),
    });

    await replaceConfigFile({
      nextConfig,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
    await ensureWorkspaceAndSessions(
      workspaceDir,
      opts.json ? { ...runtime, log: () => {} } : runtime,
      {
        skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
        agentId,
      },
    );

    if (opts.json) {
      writeRuntimeJson(runtime, {
        agentId,
        name: nameInput,
        workspace: workspaceDir,
        agentDir,
        model: model ?? null,
      });
      return;
    }

    runtime.log("");
    runtime.log(`Agent: ${agentId}`);
    runtime.log(`Workspace: ${shortenHomePath(workspaceDir)}`);
    runtime.log(`Agent dir: ${shortenHomePath(agentDir)}`);
    if (model) {
      runtime.log(`Model: ${model}`);
    } else {
      runtime.log("Model: (uses agents.defaults.model)");
    }
    runtime.log("");
    runtime.log(`Chat with this agent: gemmaclaw chat --agent ${agentId}`);
    runtime.log(`Send a one-shot message:  gemmaclaw message --agent ${agentId} "hello"`);
    return;
  }

  const prompter = createClackPrompter();
  try {
    await prompter.intro("Create a new Gemmaclaw instance");
    const name =
      nameInput ??
      (await prompter.text({
        message: "Instance name (unique agent id)",
        validate: (value) => {
          if (!value?.trim()) {
            return "Required";
          }
          const normalized = normalizeAgentId(value);
          if (RESERVED_AGENT_IDS.has(normalized)) {
            return `"${normalized}" is reserved. Choose another name.`;
          }
          if (findAgentEntryIndex(listAgentEntries(cfg), normalized) >= 0) {
            return `Agent "${normalized}" already exists.`;
          }
          return undefined;
        },
      }));

    const agentName = (name ?? "").trim();
    const agentId = normalizeAgentId(agentName);
    if (!agentId) {
      throw new WizardCancelledError();
    }
    if (agentName !== agentId) {
      await prompter.note(`Normalized id to "${agentId}".`, "Agent id");
    }
    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      reportError(runtime, `Agent "${agentId}" already exists.`);
      return;
    }

    const workspaceDefault = resolveAgentWorkspaceDir(cfg, agentId);
    const workspaceInput = await prompter.text({
      message: "Workspace directory",
      initialValue: opts.workspace?.trim() ?? workspaceDefault,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    });
    const workspaceDir = resolveUserPath(
      (workspaceInput ?? workspaceDefault).trim() || workspaceDefault,
    );
    const agentDir = opts.agentDir?.trim()
      ? resolveUserPath(opts.agentDir.trim())
      : resolveAgentDir(cfg, agentId);

    const modelInput = opts.model?.trim()
      ? opts.model.trim()
      : await prompter.text({
          message: "Model (leave blank to use the configured default)",
          initialValue: "",
        });
    const model = (modelInput ?? "").trim() || undefined;

    const nextConfig = applyCreateAgentConfig(cfg, {
      agentId,
      name: agentName,
      workspace: workspaceDir,
      agentDir,
      ...(model ? { model } : {}),
    });

    await replaceConfigFile({
      nextConfig,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    logConfigUpdated(runtime);
    await ensureWorkspaceAndSessions(workspaceDir, runtime, {
      skipBootstrap: Boolean(nextConfig.agents?.defaults?.skipBootstrap),
      agentId,
    });

    await prompter.outro(`Instance "${agentId}" ready.`);
    runtime.log("");
    runtime.log(`Chat with this agent: gemmaclaw chat --agent ${agentId}`);
    runtime.log(`Send a one-shot message:  gemmaclaw message --agent ${agentId} "hello"`);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}
