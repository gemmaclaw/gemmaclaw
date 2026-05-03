import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listAgentEntries } from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import type { ChatAgentResolveDeps } from "../cli/webchat-cli.js";
import { readBestEffortConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openUrl, resolveBrowserOpenCommand } from "../infra/browser-open.js";
import { buildAgentMainSessionKey, normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import type { TuiOptions } from "../tui/tui-types.js";
import { runTui } from "../tui/tui.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

export type TuiAgentLaunchMode = "terminal" | "browser";

export type TuiAgentLaunchResult =
  | { mode: "terminal"; opts: TuiOptions }
  | { mode: "browser"; url: string; port: number };

export const TUI_AGENT_PORT_START = 9100;
export const TUI_AGENT_PORT_END = 9199;

export type TuiPortRegistry = {
  version: 1;
  agents: Record<string, { port: number; updatedAt: string }>;
};

export type TuiAgentLaunchDeps = ChatAgentResolveDeps & {
  readConfig?: () => Promise<OpenClawConfig | undefined>;
  runTui?: (opts: TuiOptions) => Promise<void>;
  probeGatewayHealth?: (port: number) => Promise<boolean>;
  findPortOccupants?: (port: number) => string[] | Promise<string[]>;
  isPortOccupied?: (port: number) => boolean | Promise<boolean>;
  spawnGateway?: (port: number, agentId: string) => number | undefined;
  waitForGatewayReady?: (port: number) => Promise<boolean>;
  openUrl?: (url: string) => Promise<boolean>;
  resolveBrowserOpenCommand?: typeof resolveBrowserOpenCommand;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

/**
 * Derive a deterministic per-agent local port in range [9100, 9199].
 * The launcher persists assignments and linearly probes from this preferred
 * slot, so hash collisions do not make two agents fight over one port.
 */
export function deriveAgentTuiPort(agentId: string): number {
  const id = normalizeAgentId(agentId);
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = (((h << 5) + h) ^ id.charCodeAt(i)) >>> 0; // djb2 bitwise hash step
  }
  return TUI_AGENT_PORT_START + (h % (TUI_AGENT_PORT_END - TUI_AGENT_PORT_START + 1));
}

/**
 * Return true when the selected agent's effective sandbox is Docker-backed.
 * Agent-specific sandbox settings override global defaults.
 */
export function isContainerBackedAgent(cfg: OpenClawConfig | undefined, agentId: string): boolean {
  if (!cfg) {
    return false;
  }
  const sandbox = resolveSandboxConfigForAgent(cfg, agentId);
  return sandbox.mode !== "off" && sandbox.backend === "docker";
}

type TuiAgentChoice = { id: string; name?: string };

function listConfiguredTuiAgents(cfg: OpenClawConfig | undefined): TuiAgentChoice[] {
  if (!cfg) {
    return [];
  }
  const seen = new Set<string>();
  const choices: TuiAgentChoice[] = [];
  for (const entry of listAgentEntries(cfg)) {
    const id = normalizeAgentId(entry?.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    choices.push({ id, name: typeof entry.name === "string" ? entry.name.trim() : undefined });
  }
  return choices;
}

function findConfiguredTuiAgent(agents: TuiAgentChoice[], rawAgent: string): string | undefined {
  const normalized = normalizeAgentId(rawAgent);
  return (
    agents.find((agent) => agent.id === normalized)?.id ??
    agents.find((agent) => agent.name && normalizeAgentId(agent.name) === normalized)?.id
  );
}

export async function resolveTuiAgent(
  cfg: OpenClawConfig | undefined,
  rawAgent: string | undefined,
  deps: ChatAgentResolveDeps = {},
): Promise<string> {
  const agents = listConfiguredTuiAgents(cfg);
  const trimmed = rawAgent?.trim();

  if (agents.length === 0) {
    throw new Error(
      "No agents configured. Run 'gemmaclaw setup' or 'gemmaclaw create <name>' first.",
    );
  }

  if (trimmed) {
    const resolved = findConfiguredTuiAgent(agents, trimmed);
    if (!resolved) {
      throw new Error(
        `Unknown agent id "${trimmed}". Run 'gemmaclaw list' to see configured agents.`,
      );
    }
    return resolved;
  }

  const isTty = deps.isTty ?? ((process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false));
  if (!isTty) {
    throw new Error(
      "No agent specified. Usage: gemmaclaw tui <agent>. Run 'gemmaclaw list' to see configured agents.",
    );
  }

  if (!deps.pickAgent) {
    throw new Error("No agent picker available. Usage: gemmaclaw tui <agent>.");
  }

  const ids = agents.map((agent) => agent.id);
  const picked = await deps.pickAgent(ids);
  if (!picked) {
    throw new Error("No agent selected. Usage: gemmaclaw tui <agent>.");
  }
  const normalized = findConfiguredTuiAgent(agents, picked);
  if (!normalized) {
    throw new Error(`Unknown agent id "${picked}". Run 'gemmaclaw list' to see configured agents.`);
  }
  return normalized;
}

function resolveGemmaclawHomeForEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GEMMACLAW_HOME?.trim();
  if (explicit) {
    return explicit;
  }
  return path.join(env.HOME?.trim() || "/tmp", ".gemmaclaw");
}

export function resolveTuiPortRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveGemmaclawHomeForEnv(env), "state", "tui-ports.json");
}

function createEmptyPortRegistry(): TuiPortRegistry {
  return { version: 1, agents: {} };
}

function readTuiPortRegistry(registryPath: string): TuiPortRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as Partial<TuiPortRegistry>;
    const agents =
      parsed && typeof parsed.agents === "object" && parsed.agents !== null ? parsed.agents : {};
    const registry = createEmptyPortRegistry();
    for (const [rawId, rawAssignment] of Object.entries(agents)) {
      const id = normalizeAgentId(rawId);
      const assignment = rawAssignment as { port?: unknown; updatedAt?: unknown } | undefined;
      const port = typeof assignment?.port === "number" ? assignment.port : Number.NaN;
      if (id && Number.isInteger(port) && port >= 1 && port <= 65535) {
        registry.agents[id] = {
          port,
          updatedAt:
            typeof assignment?.updatedAt === "string"
              ? assignment.updatedAt
              : new Date(0).toISOString(),
        };
      }
    }
    return registry;
  } catch {
    return createEmptyPortRegistry();
  }
}

function writeTuiPortRegistry(registryPath: string, registry: TuiPortRegistry): void {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function validateTcpPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${String(port)}`);
  }
}

function findAgentAssignedToPort(
  registry: TuiPortRegistry,
  port: number,
  exceptAgentId: string,
): string | undefined {
  return Object.entries(registry.agents).find(
    ([agentId, assignment]) => agentId !== exceptAgentId && assignment.port === port,
  )?.[0];
}

export function resolveAgentTuiPort(params: {
  agentId: string;
  overridePort?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): number {
  const agentId = normalizeAgentId(params.agentId);
  const registryPath = resolveTuiPortRegistryPath(params.env);
  const registry = readTuiPortRegistry(registryPath);
  const updatedAt = (params.now ?? (() => new Date()))().toISOString();

  if (params.overridePort !== undefined) {
    validateTcpPort(params.overridePort);
    const owner = findAgentAssignedToPort(registry, params.overridePort, agentId);
    if (owner) {
      throw new Error(
        `Port ${String(params.overridePort)} is already assigned to agent "${owner}". ` +
          "Choose a different --port or remove ~/.gemmaclaw/state/tui-ports.json after cleanup.",
      );
    }
    registry.agents[agentId] = { port: params.overridePort, updatedAt };
    writeTuiPortRegistry(registryPath, registry);
    return params.overridePort;
  }

  const existing = registry.agents[agentId]?.port;
  if (
    existing !== undefined &&
    Number.isInteger(existing) &&
    existing >= TUI_AGENT_PORT_START &&
    existing <= TUI_AGENT_PORT_END &&
    !findAgentAssignedToPort(registry, existing, agentId)
  ) {
    registry.agents[agentId] = { port: existing, updatedAt };
    writeTuiPortRegistry(registryPath, registry);
    return existing;
  }

  const preferred = deriveAgentTuiPort(agentId);
  const span = TUI_AGENT_PORT_END - TUI_AGENT_PORT_START + 1;
  for (let offset = 0; offset < span; offset += 1) {
    const candidate = TUI_AGENT_PORT_START + ((preferred - TUI_AGENT_PORT_START + offset) % span);
    if (!findAgentAssignedToPort(registry, candidate, agentId)) {
      registry.agents[agentId] = { port: candidate, updatedAt };
      writeTuiPortRegistry(registryPath, registry);
      return candidate;
    }
  }

  throw new Error(
    `No free Gemmaclaw TUI ports in ${String(TUI_AGENT_PORT_START)}-${String(TUI_AGENT_PORT_END)}. ` +
      "Use --port <free-port> or clean up ~/.gemmaclaw/state/tui-ports.json.",
  );
}

async function probeGatewayHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/healthz`, {
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function isLoopbackPortOccupied(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => {
      server.close(() => resolve(false));
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Check whether `port` is already occupied by any process. Returns PIDs when
 * lsof is available, otherwise an empty array. The launcher also probes
 * bindability so collision detection does not depend on lsof.
 */
export function findProcessesOnPort(port: number): string[] {
  try {
    const pids = execSync(`lsof -ti :${port}`, {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
    }).trim();
    return pids ? pids.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_MAX_ATTEMPTS = 60;

async function waitForGatewayReady(port: number): Promise<boolean> {
  for (let i = 0; i < HEALTH_POLL_MAX_ATTEMPTS; i += 1) {
    if (await probeGatewayHealth(port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function resolveCliEntryPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../dist/entry.js"),
    path.resolve(here, "../../gemmaclaw.mjs"),
    path.resolve(here, "../../openclaw.mjs"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return process.argv[1] ?? candidates[0];
}

function spawnGatewayDetached(
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const entryPath = resolveCliEntryPath();
  const child = spawn(
    process.execPath,
    [
      entryPath,
      "gateway",
      "run",
      "--allow-unconfigured",
      "--auth",
      "none",
      "--bind",
      "loopback",
      "--port",
      String(port),
    ],
    { stdio: "ignore", detached: true, env },
  );
  child.unref();
  return child.pid;
}

/**
 * Build the TUI launch parameters for a resolved agent.
 *
 * - Host-local: launch terminal TUI with `--local` and the agent session key.
 * - Container-backed: open browser chat on a localhost per-agent port.
 */
export function buildTuiAgentLaunchResult(
  cfg: OpenClawConfig | undefined,
  agentId: string,
  overridePort?: number,
): TuiAgentLaunchResult {
  const normalized = normalizeAgentId(agentId);
  const sessionKey = buildAgentMainSessionKey({ agentId: normalized });

  if (isContainerBackedAgent(cfg, normalized)) {
    const port = overridePort ?? deriveAgentTuiPort(normalized);
    const url = `http://127.0.0.1:${String(port)}/?agent=${encodeURIComponent(normalized)}`;
    return { mode: "browser", url, port };
  }

  const opts: TuiOptions = {
    local: true,
    session: sessionKey,
  };
  return { mode: "terminal", opts };
}

async function defaultPickAgent(agents: string[]): Promise<string | undefined> {
  const prompter = createClackPrompter();
  const choice = await prompter.select({
    message: "Pick a Gemmaclaw instance to open",
    options: agents.map((id) => ({ value: id, label: id })),
  });
  return typeof choice === "string" ? choice : undefined;
}

export type LaunchTuiAgentOpts = {
  /** Positional agent name/id (or undefined = picker in TTY, error in non-TTY). */
  agentArg?: string;
  /** Port override for container agents. */
  port?: number;
  /** Whether to open browser automatically for container agents. */
  openBrowser?: boolean;
  /** Injected deps for testing. */
  deps?: TuiAgentLaunchDeps;
};

/**
 * High-level entry point: resolve agent, determine launch mode, and execute.
 * Throws on error; callers should call `process.exit(1)` after catching.
 */
export async function launchTuiAgent(opts: LaunchTuiAgentOpts): Promise<void> {
  const deps: TuiAgentLaunchDeps = opts.deps ?? {};
  const cfg = await (deps.readConfig ?? (() => readBestEffortConfig().catch(() => undefined)))();

  const agentId = await resolveTuiAgent(cfg, opts.agentArg, {
    isTty: deps.isTty,
    pickAgent: deps.pickAgent ?? defaultPickAgent,
  });
  const allocatedPort = isContainerBackedAgent(cfg, agentId)
    ? resolveAgentTuiPort({
        agentId,
        overridePort: opts.port,
        env: deps.env,
        now: deps.now,
      })
    : opts.port;
  const result = buildTuiAgentLaunchResult(cfg, agentId, allocatedPort);

  if (result.mode === "terminal") {
    await (deps.runTui ?? runTui)(result.opts);
    return;
  }

  const { url, port } = result;
  const healthProbe = deps.probeGatewayHealth ?? probeGatewayHealth;
  const healthy = await healthProbe(port);
  if (healthy) {
    defaultRuntime.log(`Reusing existing Gemmaclaw gateway for agent "${agentId}".`);
  } else {
    const occupants = await (deps.findPortOccupants ?? findProcessesOnPort)(port);
    const occupied =
      occupants.length > 0 || (await (deps.isPortOccupied ?? isLoopbackPortOccupied)(port));
    if (occupied) {
      const pidText = occupants.length > 0 ? ` (PID ${occupants.join(", ")})` : "";
      defaultRuntime.error(
        `Port ${String(port)} is occupied${pidText} and is not a healthy Gemmaclaw gateway. ` +
          "Stop the other process or retry with --port <free-port>.",
      );
      throw new Error(`port ${String(port)} occupied by non-gateway process`);
    }

    defaultRuntime.log(`Starting Gemmaclaw gateway on 127.0.0.1:${String(port)}...`);
    const pid = (deps.spawnGateway ?? ((p) => spawnGatewayDetached(p, deps.env)))(port, agentId);
    const ready = await (deps.waitForGatewayReady ?? waitForGatewayReady)(port);
    if (!ready) {
      defaultRuntime.error(
        `Gateway did not become ready on 127.0.0.1:${String(port)} within 30 seconds. ` +
          "Check logs with: gemmaclaw logs",
      );
      throw new Error(`gateway not reachable on port ${String(port)}`);
    }
    defaultRuntime.log(`Gateway is ready${pid ? ` (PID ${String(pid)})` : ""}.`);
  }

  defaultRuntime.log(`Agent:  ${agentId}`);
  defaultRuntime.log(`Port:   ${String(port)} (localhost only)`);
  defaultRuntime.log(`URL:    ${url}`);

  if (opts.openBrowser !== false) {
    const browserCmd = await (deps.resolveBrowserOpenCommand ?? resolveBrowserOpenCommand)();
    if (browserCmd.argv) {
      defaultRuntime.log(`Opening ${url} in your browser...`);
      const opened = await (deps.openUrl ?? openUrl)(url);
      if (!opened) {
        defaultRuntime.log(
          `Could not open browser automatically. Open this URL manually:\n  ${url}`,
        );
      }
    } else {
      defaultRuntime.log(
        `No browser detected (${browserCmd.reason ?? "unknown"}). Open this URL manually:\n  ${url}`,
      );
    }
  }
}
