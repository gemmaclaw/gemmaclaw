import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { listAgentEntries } from "../agents/agent-scope.js";
import { readBestEffortConfig } from "../config/config.js";
import { resolveGatewayPort } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openUrl, resolveBrowserOpenCommand } from "../infra/browser-open.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

export type ChatAgentResolveDeps = {
  isTty?: boolean;
  pickAgent?: (agents: string[]) => Promise<string | undefined>;
};

export type ChatAgentResolveResult =
  | { ok: true; agentId?: string }
  | { ok: false; message: string };

function listConfiguredAgentIds(cfg: OpenClawConfig | undefined): string[] {
  if (!cfg) {
    return [];
  }
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

export async function resolveChatAgent(
  cfg: OpenClawConfig | undefined,
  rawAgent: string | undefined,
  deps: ChatAgentResolveDeps = {},
): Promise<ChatAgentResolveResult> {
  const agents = listConfiguredAgentIds(cfg);
  const trimmed = rawAgent?.trim();

  if (agents.length === 0) {
    return {
      ok: false,
      message: "No agents configured. Run 'gemmaclaw create <name>' to create an instance first.",
    };
  }

  if (trimmed) {
    const normalized = normalizeAgentId(trimmed);
    if (!agents.includes(normalized)) {
      return {
        ok: false,
        message: `Unknown agent id "${trimmed}". Run 'gemmaclaw list' to see configured agents.`,
      };
    }
    return { ok: true, agentId: normalized };
  }

  if (agents.length === 1) {
    return { ok: true, agentId: agents[0] };
  }

  const isTty = deps.isTty ?? ((process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false));
  if (!isTty) {
    return {
      ok: false,
      message: `Multiple agents configured. Pass --agent <id> to choose one. Available: ${agents.join(", ")}.`,
    };
  }

  const pick = deps.pickAgent;
  if (!pick) {
    return {
      ok: false,
      message: "No agent picker available; pass --agent <id> to choose one explicitly.",
    };
  }
  const picked = await pick(agents);
  if (!picked) {
    return { ok: false, message: "No agent selected. Pass --agent <id> to choose one." };
  }
  return { ok: true, agentId: normalizeAgentId(picked) };
}

async function defaultPickAgent(agents: string[]): Promise<string | undefined> {
  const prompter = createClackPrompter();
  try {
    const choice = await prompter.select({
      message: "Pick a Gemmaclaw instance to chat with",
      options: agents.map((id) => ({ value: id, label: id })),
    });
    return typeof choice === "string" ? choice : undefined;
  } finally {
    /* clack returns a fresh state each call */
  }
}

const HEALTH_POLL_INTERVAL_MS = 500;
const HEALTH_POLL_MAX_ATTEMPTS = 60;

async function probeGatewayHealth(port: number): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${String(port)}/healthz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return false;
    }
    const body = await res.text();
    return body.includes("ok");
  } catch {
    return false;
  }
}

async function waitForGatewayReady(port: number): Promise<boolean> {
  for (let i = 0; i < HEALTH_POLL_MAX_ATTEMPTS; i++) {
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
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return process.argv[1] ?? candidates[0];
}

function killProcessesOnPort(port: number): void {
  try {
    const pids = execSync(`lsof -ti :${port}`, {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: "pipe",
    }).trim();
    if (pids) {
      for (const pid of pids.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          // Already gone.
        }
      }
      execSync("sleep 1", { stdio: "pipe" });
      for (const pid of pids.split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  } catch {
    // No processes on port.
  }
}

function spawnGatewayDetached(port: number): number | undefined {
  const entryPath = resolveCliEntryPath();
  const child = spawn(
    process.execPath,
    [entryPath, "gateway", "run", "--allow-unconfigured", "--auth", "none", "--port", String(port)],
    { stdio: "ignore", detached: true, env: process.env },
  );
  child.unref();
  return child.pid;
}

export function registerWebchatCli(program: Command) {
  program
    .command("chat")
    .description("Open a browser-based chat UI for your Gemma assistant")
    .option("--port <port>", "Gateway port (default: auto-detected from config)")
    .option("--agent <id>", "Target agent id (skips picker; required when stdin is not a TTY)")
    .option("--name <id>", "Alias for --agent")
    .option("--no-open", "Start gateway but do not open the browser automatically")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Starts the gateway in the background and opens the web chat UI in your default browser.")}\n${theme.muted(
          "When multiple agents are configured, pass --agent <id> or pick one interactively.",
        )}\n`,
    )
    .action(async (opts) => {
      try {
        const cfg = await readBestEffortConfig().catch(() => undefined);
        const rawAgent =
          (typeof opts.agent === "string" && opts.agent.trim()) ||
          (typeof opts.name === "string" && opts.name.trim()) ||
          undefined;
        const resolved = await resolveChatAgent(cfg, rawAgent, {
          pickAgent: defaultPickAgent,
        });
        if (!resolved.ok) {
          defaultRuntime.error(resolved.message);
          defaultRuntime.exit(1);
          return;
        }
        const agentId = resolved.agentId;

        const port = opts.port
          ? Number.parseInt(String(opts.port), 10)
          : resolveGatewayPort(cfg, process.env);

        if (Number.isNaN(port) || port <= 0 || port > 65535) {
          defaultRuntime.error(`Invalid port: ${String(opts.port)}`);
          defaultRuntime.exit(1);
        }

        const baseUrl = `http://127.0.0.1:${String(port)}/`;
        const chatUrl = agentId ? `${baseUrl}?agent=${encodeURIComponent(agentId)}` : baseUrl;

        // Always clean up stale processes and start a fresh gateway.
        killProcessesOnPort(port);

        defaultRuntime.log(`Starting gateway on port ${String(port)}...`);
        const pid = spawnGatewayDetached(port);

        const ready = await waitForGatewayReady(port);
        if (!ready) {
          defaultRuntime.error(
            "Gateway did not become ready within 30 seconds. Check logs with: gemmaclaw logs",
          );
          if (pid) {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              /* already gone */
            }
          }
          defaultRuntime.exit(1);
        }

        defaultRuntime.log(`Gateway is ready (PID ${pid ?? "unknown"}).`);
        if (agentId) {
          defaultRuntime.log(`Target agent: ${agentId}`);
        }
        defaultRuntime.log(
          theme.muted(
            "Note: if you rebuild the project, run `gemmaclaw chat` again to restart the gateway.",
          ),
        );

        if (opts.open !== false) {
          const browserCmd = await resolveBrowserOpenCommand();
          if (browserCmd.argv) {
            defaultRuntime.log(`Opening ${chatUrl} in your browser...`);
            const opened = await openUrl(chatUrl);
            if (!opened) {
              defaultRuntime.log(
                `Could not open browser automatically. Open this URL manually:\n  ${chatUrl}`,
              );
            }
          } else {
            defaultRuntime.log(
              `No browser detected (${browserCmd.reason ?? "unknown"}). Open this URL manually:\n  ${chatUrl}`,
            );
          }
        } else {
          defaultRuntime.log(`Chat UI: ${chatUrl}`);
        }
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
