import { listAgentEntries } from "../agents/agent-scope.js";
import type { CliDeps } from "../cli/deps.types.js";
import { loadConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, defaultRuntime } from "../runtime.js";
import { agentCliCommand, type AgentCliOpts } from "./agent-via-gateway.js";

export type MessageAskOpts = {
  text?: string;
  agent?: string;
  sessionId?: string;
  thinking?: string;
  json?: boolean;
  timeout?: string;
  local?: boolean;
};

export type MessageAskParams = {
  positional?: string[];
  isTty?: boolean;
  readStdin?: () => Promise<string>;
};

function listConfiguredAgentIds(cfg: ReturnType<typeof loadConfig>): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of listAgentEntries(cfg)) {
    const id = normalizeAgentId(entry?.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function readAllStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

export async function messageAskCommand(
  opts: MessageAskOpts,
  runtime: RuntimeEnv = defaultRuntime,
  params: MessageAskParams = {},
  deps?: CliDeps,
): Promise<void> {
  const positional = (params.positional ?? []).join(" ").trim();
  const flagText = opts.text?.trim();

  const isTty = params.isTty ?? process.stdin.isTTY ?? false;
  let stdinText = "";
  if (!isTty && !positional && !flagText) {
    const reader = params.readStdin ?? readAllStdin;
    try {
      stdinText = (await reader()).trim();
    } catch {
      stdinText = "";
    }
  }

  const message = (positional || flagText || stdinText).trim();
  if (!message) {
    runtime.error(
      "Message text is required. Pass it as an argument, via --text, or pipe it on stdin (e.g., echo 'hi' | gemmaclaw message --agent foo).",
    );
    runtime.exit(1);
    return;
  }

  const cfg = loadConfig();
  const knownAgents = listConfiguredAgentIds(cfg);
  const agentInput = opts.agent?.trim();

  let agentId = agentInput ? normalizeAgentId(agentInput) : undefined;

  if (!agentId) {
    if (knownAgents.length === 1) {
      agentId = knownAgents[0];
    } else if (knownAgents.length === 0) {
      runtime.error(
        "No agents configured. Run 'gemmaclaw create <name>' to create an instance, or 'gemmaclaw setup' to provision Gemma.",
      );
      runtime.exit(1);
      return;
    } else {
      runtime.error(
        `Multiple agents configured. Pass --agent <id> to choose one. Available: ${knownAgents.join(", ")}.`,
      );
      runtime.exit(1);
      return;
    }
  } else if (!knownAgents.includes(agentId)) {
    runtime.error(
      `Unknown agent id "${agentInput}". Run 'gemmaclaw list' to see configured agents.`,
    );
    runtime.exit(1);
    return;
  }

  const cliOpts: AgentCliOpts = {
    message,
    agent: agentId,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    ...(opts.json ? { json: true } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
    ...(opts.local ? { local: true } : {}),
  };

  await agentCliCommand(cliOpts, runtime, deps);
}
