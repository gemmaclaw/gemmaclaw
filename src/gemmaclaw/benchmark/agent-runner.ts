/**
 * E2E Agent Benchmark Runner.
 *
 * Dispatches tasks to a running gemmaclaw gateway, captures full conversations
 * (tool calls, results, reasoning). Data collection only, no scoring.
 * LLM evaluation is a separate step done after the run.
 *
 * Architecture:
 *   1. Seed mock gog state (emails, calendar, tasks, contacts)
 *   2. For each task: send message to gateway, poll session JSONL for completion
 *   3. Extract full conversation transcript (including tool calls)
 *   4. Save results with rich metadata (ready for PR)
 *   5. LLM judge evaluation added as a separate file later
 *
 * Configuration:
 *   - gatewayUrl: defaults to http://localhost:3001 (local gemmaclaw)
 *   - ollamaUrl: defaults to http://localhost:11434
 *   - Can target remote gemmaclaw instances via URL config
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { HardwareInfo } from "../provision/hardware.js";
import { detectSystemTools } from "../provision/hardware.js";
import { selectQuickProfile } from "../provision/setup-wizard.js";
import type { AgentBenchmarkTask } from "./agent-tasks.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type AgentBackendType = "ollama" | "llama-cpp";

export type AgentBenchmarkConfig = {
  /** URL of the gemmaclaw gateway. */
  gatewayUrl: string;
  /** Backend type for model inference. */
  backend: AgentBackendType;
  /** URL of the Ollama backend. */
  ollamaUrl: string;
  /** URL of the llama.cpp server (OpenAI-compatible). */
  llamaCppUrl: string;
  /** Model identifier (e.g. gemma4:31b, gemma4:26b). */
  model: string;
  /** Quantization level if applicable (e.g. Q4_K_M, Q8_0, FP16). */
  quant?: string;
  /** Thinking/reasoning level (off, low, medium, high). */
  thinkingLevel?: string;
  /** Maximum seconds to wait for a single task to complete. 0 = no limit. */
  taskTimeoutSeconds: number;
  /** Seconds of idle (no new JSONL lines) before considering task done. */
  idleTimeoutSeconds: number;
  /** Path to mock gog seed script. */
  seedScript?: string;
  /** Path to gemmaclaw home for isolated runs. */
  gemmaclawHome?: string;
  /** Filter tasks by id pattern (substring match). */
  filter?: string;
  /** Run in mock mode (no real model, deterministic responses). */
  mock?: boolean;
  /** Ollama context length. */
  contextLength?: number;
};

export type ConversationTurn = {
  role: "user" | "assistant" | "tool_call" | "tool_result" | "system";
  content: string;
  /** Tool name if role is tool_call. */
  toolName?: string;
  /** Tool arguments if role is tool_call. */
  toolArgs?: Record<string, unknown>;
  /** Timestamp of this turn. */
  timestamp?: string;
};

export type AgentTaskResult = {
  task: AgentBenchmarkTask;
  /** Full conversation transcript including tool calls. */
  conversation: ConversationTurn[];
  /** Wall clock time for this task. */
  elapsedMs: number;
  /** Tokens per second (generation speed). */
  tokensPerSecond?: number;
  /** Number of tool calls the agent made. */
  toolCallCount: number;
  /** List of tools the agent called. */
  toolsUsed: string[];
  /** Whether the task completed or timed out. */
  completionStatus: "completed" | "timeout" | "error";
  /** Error message if any. */
  error?: string;
};

export type RunMetadata = {
  /** Model identifier. */
  model: string;
  /** Quantization level. */
  quant?: string;
  /** Thinking/reasoning level used. */
  thinkingLevel?: string;
  /** Hardware info (GPU, RAM, CPU). */
  hardware: HardwareInfo;
  /** Gateway URL used. */
  gatewayUrl: string;
  /** Ollama URL used. */
  ollamaUrl: string;
  /** Git SHA of the gemmaclaw repo at run time. */
  gitSha?: string;
  /** Gemmaclaw version. */
  gemmaclawVersion?: string;
  /** Ollama model details (parameter count, family, quantization). */
  ollamaModelInfo?: Record<string, unknown>;
  /** Context length configured. */
  contextLength?: number;
  /** Run start timestamp. */
  startedAt: string;
  /** Run end timestamp. */
  finishedAt?: string;
  /** OS and platform info. */
  platform?: string;
  /** Node.js version. */
  nodeVersion?: string;
};

export type AgentBenchmarkResult = {
  metadata: RunMetadata;
  config: AgentBenchmarkConfig;
  tasks: AgentTaskResult[];
  summary: {
    totalTasks: number;
    completedCount: number;
    errorCount: number;
    timeoutCount: number;
    totalTimeMs: number;
    totalToolCalls: number;
    avgToolCallsPerTask: number;
  };
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function which(cmd: string): string | null {
  try {
    return execSync(`which ${cmd}`, { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function httpGet(url: string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function httpPost(url: string, body: string, timeoutMs = 300_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.write(body);
    req.end();
  });
}

/** Collect metadata about the current environment and model. */
export async function collectMetadata(
  config: AgentBenchmarkConfig,
  hardware: HardwareInfo,
): Promise<RunMetadata> {
  let gitSha: string | undefined;
  try {
    gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    /* not in a git repo */
  }

  let ollamaModelInfo: Record<string, unknown> | undefined;
  try {
    const infoResp = await httpPost(
      `${config.ollamaUrl}/api/show`,
      JSON.stringify({ name: config.model }),
      10_000,
    );
    const info = JSON.parse(infoResp);
    ollamaModelInfo = {
      family: info.details?.family,
      parameterSize: info.details?.parameter_size,
      quantizationLevel: info.details?.quantization_level,
      format: info.details?.format,
    };
  } catch {
    /* ollama not available or model not loaded */
  }

  return {
    model: config.model,
    quant: config.quant,
    thinkingLevel: config.thinkingLevel,
    hardware,
    gatewayUrl: config.gatewayUrl,
    ollamaUrl: config.ollamaUrl,
    gitSha,
    ollamaModelInfo,
    contextLength: config.contextLength,
    startedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
  };
}

/** Seed mock gog state before a benchmark run.
 * If gemmaclawHome is set, seeds inside that directory's gogcli state.
 * Otherwise seeds in the default ~/.config/gogcli/state/.
 */
export function seedMockGog(seedScript?: string, stateDir?: string): void {
  // Find repo root from cwd (pnpm sets cwd to repo root)
  const script = seedScript ?? path.resolve(process.cwd(), "scripts/benchmark/seed-mock-gog.py");
  if (!fs.existsSync(script)) {
    throw new Error(`Mock gog seed script not found: ${script}`);
  }
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (stateDir) {
    env.GEMMACLAW_MOCK_GOG_STATE_DIR = stateDir;
  }
  execSync(`python3 ${script}`, { stdio: "inherit", env });
}

/**
 * Create an isolated gemmaclaw home directory for benchmark runs.
 * Uses the existing Docker sandbox infrastructure so agent tool calls
 * (gog, file writes) are sandboxed but the gateway runs on the host.
 */
export function createBenchmarkHome(config: AgentBenchmarkConfig): string {
  const homeDir = config.gemmaclawHome ?? path.join(os.tmpdir(), `gemmaclaw-bench-${Date.now()}`);
  fs.mkdirSync(path.join(homeDir, "agents/main/sessions"), { recursive: true });
  fs.mkdirSync(path.join(homeDir, "workspace/memory"), { recursive: true });

  // Write config with sandbox enabled
  const benchConfig = {
    provider: config.backend === "llama-cpp" ? "llama-cpp" : "ollama",
    model: config.model,
    ollamaUrl: config.ollamaUrl,
    llamaCppUrl: config.llamaCppUrl,
    sandbox: { mode: "docker" },
    tools: { exec: { host: "gateway" } },
    security: "full",
    ask: "off",
  };
  fs.writeFileSync(path.join(homeDir, "openclaw.json"), JSON.stringify(benchConfig, null, 2));

  // Seed mock gog state into the benchmark home's gogcli state
  const gogStateDir = path.join(homeDir, ".config/gogcli/state");
  fs.mkdirSync(gogStateDir, { recursive: true });
  seedMockGog(config.seedScript, gogStateDir);

  return homeDir;
}

/**
 * Auto-detect the best model and backend for the current hardware.
 * Uses the same recommendation logic as `gemmaclaw setup`.
 */
export function autoSelectModel(hardware: HardwareInfo): {
  model: string;
  backend: AgentBackendType;
} {
  const tools = detectSystemTools();
  const profile = selectQuickProfile(hardware, tools);
  return {
    model: profile.model ?? "gemma4:e4b",
    backend: profile.backend === "llama-cpp" ? "llama-cpp" : "ollama",
  };
}

/** Check if gateway is healthy. */
export async function checkGateway(
  gatewayUrl: string,
  log?: (msg: string) => void,
): Promise<boolean> {
  try {
    const resp = await httpGet(`${gatewayUrl}/healthz`, 5_000);
    // Try JSON parse first, fall back to checking HTTP 200 response
    try {
      const data = JSON.parse(resp);
      const healthy = data.ok === true || data.status === "live" || data.status === "ok";
      if (log) {
        log(`  Gateway healthy: ${healthy} (${JSON.stringify(data).slice(0, 80)})`);
      }
      return healthy;
    } catch {
      // Non-JSON response, any 200 response means healthy
      if (log) {
        log(`  Gateway responded (non-JSON): ${resp.slice(0, 80)}`);
      }
      return true;
    }
  } catch (e) {
    if (log) {
      log(`  Gateway unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    return false;
  }
}

/**
 * Parse a single session JSONL entry into zero or more ConversationTurn entries.
 *
 * Handles both Anthropic-style block types (tool_use / tool_result) and OpenClaw
 * camelCase variants (toolCall / toolResult), plus top-level role=toolResult
 * messages emitted by OpenClaw sessions. Skips unrecognized entry types.
 */
export function parseSessionEntry(entry: unknown): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  if (!entry || typeof entry !== "object") {
    return turns;
  }
  const e = entry as { message?: unknown; timestamp?: string };
  const msg = (e.message ?? entry) as { role?: string; content?: unknown };
  const role = msg?.role;
  const content = msg?.content;
  const ts = e.timestamp;

  const blockText = (b: { content?: unknown }): string => {
    if (typeof b.content === "string") {
      return b.content;
    }
    if (Array.isArray(b.content)) {
      return b.content.map((c: { text?: string }) => c.text ?? "").join("\n");
    }
    return JSON.stringify(b.content);
  };

  if (role === "user") {
    if (typeof content === "string") {
      turns.push({ role: "user", content, timestamp: ts });
    } else if (Array.isArray(content)) {
      const text = content
        .filter((b: { type?: string; text?: string }) => b.type === "text" && b.text)
        .map((b: { text: string }) => b.text)
        .join("\n");
      if (text) {
        turns.push({ role: "user", content: text, timestamp: ts });
      }
    }
  } else if (role === "assistant") {
    if (typeof content === "string") {
      turns.push({ role: "assistant", content, timestamp: ts });
    } else if (Array.isArray(content)) {
      for (const block of content as Array<{
        type?: string;
        text?: string;
        name?: string;
        input?: unknown;
        arguments?: unknown;
        content?: unknown;
      }>) {
        if (block.type === "text" && block.text) {
          turns.push({ role: "assistant", content: block.text, timestamp: ts });
        } else if (block.type === "tool_use" || block.type === "toolCall") {
          const toolArgs = (block.input ?? block.arguments ?? {}) as Record<string, unknown>;
          turns.push({
            role: "tool_call",
            content: JSON.stringify(toolArgs),
            toolName: block.name,
            toolArgs,
            timestamp: ts,
          });
        } else if (block.type === "tool_result" || block.type === "toolResult") {
          turns.push({ role: "tool_result", content: blockText(block), timestamp: ts });
        }
      }
    }
  } else if (role === "toolResult" || role === "tool_result") {
    if (typeof content === "string") {
      turns.push({ role: "tool_result", content, timestamp: ts });
    } else if (Array.isArray(content)) {
      const text = content
        .filter((b: { type?: string; text?: string }) => b.type === "text" && b.text)
        .map((b: { text: string }) => b.text)
        .join("\n");
      if (text) {
        turns.push({ role: "tool_result", content: text, timestamp: ts });
      }
    }
  }
  return turns;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract a terminal OpenClaw trajectory error from a .trajectory.jsonl entry.
 *
 * The one-shot `gemmaclaw agent --local --json` command can exit 0 even when
 * the embedded runner records `session.ended { status: "error" }` (for example
 * an LLM idle timeout before the first token). The benchmark must treat those
 * runs as failed/timeout instead of accepting an empty transcript.
 */
export function extractTrajectoryError(entry: unknown): string | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (type !== "session.ended" && type !== "trace.artifacts" && type !== "model.completed") {
    return undefined;
  }
  const data = isRecord(entry.data) ? entry.data : {};
  const status = typeof data.status === "string" ? data.status : undefined;
  const finalStatus = typeof data.finalStatus === "string" ? data.finalStatus : undefined;
  const promptError = typeof data.promptError === "string" ? data.promptError.trim() : "";
  const error = typeof data.error === "string" ? data.error.trim() : "";
  const aborted = data.aborted === true;
  const timedOut = data.timedOut === true || data.idleTimedOut === true;

  if (promptError) {
    // A context overflow that occurs on a passive retry (no model output, no tool
    // calls attempted) is a harness artifact — the primary session already completed
    // successfully.  Ignoring it prevents false ERROR status when the gemmaclaw CLI
    // retries on a full context window after the agent finished its work.
    const isContextOverflow = promptError.toLowerCase().includes("context overflow");
    if (isContextOverflow) {
      const assistantTexts = Array.isArray(data.assistantTexts) ? data.assistantTexts : [];
      const toolMetas = Array.isArray(data.toolMetas) ? data.toolMetas : [];
      const isPassiveRetry = assistantTexts.length === 0 && toolMetas.length === 0;
      if (isPassiveRetry) {
        return undefined;
      }
    }
    return promptError;
  }
  if (error) {
    return error;
  }
  if (status === "error" || finalStatus === "error") {
    return "OpenClaw session ended with status=error";
  }
  if (timedOut) {
    return "OpenClaw session timed out";
  }
  if (aborted) {
    return "OpenClaw session aborted";
  }
  return undefined;
}

function readTrajectoryError(trajectoryPath: string): string | undefined {
  if (!fs.existsSync(trajectoryPath)) {
    return undefined;
  }
  let lastError: string | undefined;
  try {
    const lines = fs.readFileSync(trajectoryPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as unknown;
        const error = extractTrajectoryError(entry);
        if (error) {
          lastError = error;
        }
      } catch {
        // Ignore mid-write / malformed trajectory lines.
      }
    }
  } catch {
    return undefined;
  }
  return lastError;
}

/**
 * Dispatch a task to the gemmaclaw gateway and wait for completion.
 *
 * Uses `gemmaclaw agent --local` to send the message, then polls the session
 * JSONL for completion (idle detection). Returns the full conversation.
 */
export async function dispatchTask(
  task: AgentBenchmarkTask,
  config: AgentBenchmarkConfig,
  sessionId: string,
  log: (msg: string) => void,
): Promise<{
  conversation: ConversationTurn[];
  elapsedMs: number;
  completionStatus: "completed" | "timeout" | "error";
  error?: string;
}> {
  const startMs = Date.now();
  const timeoutMs =
    config.taskTimeoutSeconds > 0 ? config.taskTimeoutSeconds * 1000 : Number.MAX_SAFE_INTEGER;
  const idleMs = config.idleTimeoutSeconds * 1000;

  // Create isolated benchmark home for this task
  const benchHome = path.join(os.tmpdir(), `gemmaclaw-bench-${sessionId}`);

  // Dispatch via gemmaclaw CLI
  const gemmaclawBin =
    process.env.GEMMACLAW_BIN ??
    (fs.existsSync("/app/gemmaclaw.mjs")
      ? "node /app/gemmaclaw.mjs"
      : (which("gemmaclaw") ?? "gemmaclaw"));

  const args = [
    gemmaclawBin,
    "agent",
    "--local",
    "--session-id",
    sessionId,
    "--message",
    task.prompt,
  ];
  const effectiveThinking = task.thinkingLevelOverride ?? config.thinkingLevel;
  if (effectiveThinking) {
    args.push("--thinking", effectiveThinking);
  }
  if (config.taskTimeoutSeconds > 0) {
    // Keep the embedded OpenClaw command timeout aligned with the benchmark's
    // hard per-task timeout. Without this, large local Ollama models can hit
    // the CLI/runtime default before the benchmark watchdog fires.
    args.push("--timeout", String(config.taskTimeoutSeconds));
  }

  log(`  Dispatching: ${args[0]} agent --local --session-id ${sessionId}`);

  // Write dispatch command to log file for debugging
  const logDir = path.join(process.cwd(), "benchmark-results", ".logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${sessionId}.log`);
  fs.writeFileSync(logFile, `[${new Date().toISOString()}] Dispatching task: ${task.id}\n`);
  fs.appendFileSync(logFile, `Command: ${args.join(" ")}\n`);
  fs.appendFileSync(logFile, `Prompt: ${task.prompt}\n\n`);

  try {
    // Create isolated benchmark home using gemmaclaw setup --non-interactive.
    // This properly configures model, auth, workspace, and all gemmaclaw internals.
    const ocDir = path.join(benchHome, ".openclaw");
    fs.mkdirSync(path.join(ocDir, "agents/main/sessions"), { recursive: true });
    fs.mkdirSync(path.join(ocDir, "agents/main/agent"), { recursive: true });
    fs.mkdirSync(path.join(ocDir, "workspace/memory"), { recursive: true });

    // Build config using the same logic as gemmaclaw setup
    const isLlamaCpp = config.backend === "llama-cpp";
    const providerPrefix = isLlamaCpp ? "openai" : "ollama";
    const benchmarkModelConfig: Record<string, unknown> = {
      id: config.model,
      name: config.model,
    };
    if (typeof config.contextLength === "number" && Number.isFinite(config.contextLength)) {
      benchmarkModelConfig.contextWindow = config.contextLength;
      benchmarkModelConfig.maxTokens = config.contextLength;
    }

    const llmIdleTimeoutSeconds = config.taskTimeoutSeconds > 0 ? config.taskTimeoutSeconds : 0;
    const benchConfigData: Record<string, unknown> = {
      agents: {
        defaults: {
          llm: {
            // Large local models on RTX 3090 may take >120s to first token.
            // The benchmark hard timeout is the authoritative limit, so do not
            // let the embedded runner's default LLM idle watchdog abort early.
            idleTimeoutSeconds: llmIdleTimeoutSeconds,
          },
          model: {
            primary: `${providerPrefix}/${config.model}`,
          },
        },
      },
      // Deny all bundled plugins with runtime deps that need npm install at startup.
      // Docker containers have no npm registry access (WSL2 NAT networking blocks it).
      // Only ollama is allowed — it is pre-installed in the benchmark Docker image.
      // List: all enabledByDefault plugins with package.json dependencies, minus ollama.
      plugins: {
        deny: [
          "acpx",
          "amazon-bedrock",
          "amazon-bedrock-mantle",
          "anthropic",
          "browser",
          "deepgram",
          "elevenlabs",
          "fireworks",
          "github-copilot",
          "google",
          "kimi",
          "lmstudio",
          "microsoft",
          "mistral",
          "openai",
          "xai",
        ],
      },
    };
    // URLs inside the container must use host.docker.internal to reach host services
    const containerOllamaUrl = config.ollamaUrl
      .replace("http://localhost", "http://host.docker.internal")
      .replace("http://127.0.0.1", "http://host.docker.internal");
    const containerLlamaCppUrl = (config.llamaCppUrl ?? "")
      .replace("http://localhost", "http://host.docker.internal")
      .replace("http://127.0.0.1", "http://host.docker.internal");

    if (isLlamaCpp) {
      benchConfigData.models = {
        providers: {
          openai: {
            baseUrl: containerLlamaCppUrl + "/v1",
            models: [{ ...benchmarkModelConfig, api: "openai-completions" }],
          },
        },
      };
    } else {
      // Register the Ollama model explicitly so non-catalog models (custom
      // quant tags like gemma4-31b-q6k) are resolved by the provider plugin.
      benchConfigData.models = {
        providers: {
          ollama: {
            baseUrl: containerOllamaUrl,
            models: [benchmarkModelConfig],
          },
        },
      };
    }
    fs.writeFileSync(path.join(ocDir, "openclaw.json"), JSON.stringify(benchConfigData, null, 2));

    // Auth profile (both Ollama and llama.cpp/openai need a profile entry)
    const authProvider = isLlamaCpp ? "openai" : "ollama";
    fs.writeFileSync(
      path.join(ocDir, "agents/main/agent/auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          [`${authProvider}:default`]: {
            type: "token",
            provider: authProvider,
            token: "benchmark-dummy-key",
          },
        },
      }),
    );

    // Mock gog state is baked into the Docker image via seed-mock-gog.py.
    // No host credentials are copied. The container has zero access to real Google.

    // Run the benchmark agent INSIDE a Docker container (Frank directive May 5 2026).
    // The container has no access to host credentials, real gog tokens, or filesystem.
    // Only Ollama/llama.cpp on the host is accessible via network.
    const dockerImage = process.env.GEMMACLAW_BENCH_IMAGE ?? "gemmaclaw-bench:latest";
    const ollamaHost = config.ollamaUrl
      .replace("http://localhost", "http://host.docker.internal")
      .replace("http://127.0.0.1", "http://host.docker.internal");
    const llamaCppHost =
      config.llamaCppUrl
        ?.replace("http://localhost", "http://host.docker.internal")
        .replace("http://127.0.0.1", "http://host.docker.internal") ?? "";

    // Write task prompt to a file so we don't hit shell arg length limits
    const promptFile = path.join(benchHome, "task-prompt.txt");
    fs.writeFileSync(promptFile, task.prompt);

    const dockerArgs = [
      "docker",
      "run",
      "--rm",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      `${benchHome}:/bench-home`,
      "-e",
      `OPENCLAW_HOME=/bench-home`,
      "-e",
      `XDG_CONFIG_HOME=/bench-home`,
      "-e",
      `OLLAMA_API_KEY=ollama-local`,
      "-e",
      `OLLAMA_HOST=${ollamaHost}`,
      "-e",
      `GOG_ACCESS_TOKEN=gemmaclaw-bench-no-real-google`,
      ...(llamaCppHost ? ["-e", `LLAMA_CPP_URL=${llamaCppHost}`] : []),
      dockerImage,
      "node",
      "/app/gemmaclaw.mjs",
      "agent",
      "--local",
      "--session-id",
      sessionId,
      "--message",
      task.prompt,
      ...(effectiveThinking ? ["--thinking", effectiveThinking] : []),
      ...(config.taskTimeoutSeconds > 0 ? ["--timeout", String(config.taskTimeoutSeconds)] : []),
    ];

    log(`  Docker dispatch: ${dockerImage} agent --local --session-id ${sessionId}`);
    fs.appendFileSync(logFile, `Docker command: ${dockerArgs.join(" ")}\n`);

    const child = spawn(dockerArgs[0], dockerArgs.slice(1), {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Capture stdout and stderr for debugging. Also use them as heartbeat
    // signals so a model emitting tokens (even if not writing JSONL yet) is
    // not killed by the idle watchdog.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let lastIoMs = Date.now();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      lastIoMs = Date.now();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      lastIoMs = Date.now();
    });

    // Track child lifecycle without blocking: we need to poll JSONL
    // concurrently and kill the child on hard-timeout / idle-stuck.
    let childExitCode: number | null = null;
    let childError: Error | null = null;
    child.on("close", (code: number | null) => {
      childExitCode = code ?? -1;
      const stdout = Buffer.concat(stdoutChunks).toString().trim();
      const stderr = Buffer.concat(stderrChunks).toString().trim();
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] CLI exited with code ${code}\n`);
      if (stdout) {
        fs.appendFileSync(logFile, `STDOUT:\n${stdout}\n\n`);
      }
      if (stderr) {
        fs.appendFileSync(logFile, `STDERR:\n${stderr}\n\n`);
      }
    });
    child.on("error", (e: Error) => {
      childError = e;
    });

    const sessionsDir = path.join(benchHome, ".openclaw/agents/main/sessions");
    const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const trajectoryPath = path.join(sessionsDir, `${sessionId}.trajectory.jsonl`);

    let lastLineCount = 0;
    let lastChangeMs = Date.now();
    const conversation: ConversationTurn[] = [];

    const parseJsonl = () => {
      if (!fs.existsSync(jsonlPath)) {
        return;
      }
      try {
        const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
        if (lines.length > lastLineCount) {
          lastLineCount = lines.length;
          lastChangeMs = Date.now();
          lastIoMs = Date.now();
          conversation.length = 0;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const turns = parseSessionEntry(entry);
              conversation.push(...turns);
            } catch {
              // Skip unparseable lines
            }
          }
        }
      } catch {
        // File might be mid-write
      }
    };

    const killChild = async (reason: string): Promise<void> => {
      if (childExitCode !== null) {
        return;
      }
      log(`  Killing child: ${reason}`);
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Killing child: ${reason}\n`);
      try {
        child.kill("SIGTERM");
      } catch {}
      const killWaitStart = Date.now();
      // childExitCode is mutated by the 'close' handler (closure). The loop
      // re-reads it each iteration and the await yields the event loop so the
      // handler can fire.
      // eslint-disable-next-line no-unmodified-loop-condition
      while (childExitCode === null && Date.now() - killWaitStart < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (childExitCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {}
        const k2 = Date.now();
        // eslint-disable-next-line no-unmodified-loop-condition
        while (childExitCode === null && Date.now() - k2 < 3000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    };

    // Idle threshold while child is still running: tolerate model thinking
    // (idle JSONL during long generation) by extending the idle threshold.
    // Only declare task done via idle once we have an assistant response.
    const stuckThresholdMs = Math.max(idleMs * 4, 120_000);
    // Large local models can legitimately spend several minutes before their
    // first assistant turn. Let the hard task timeout, not the benchmark idle
    // watchdog, be the authoritative limit before first token/turn.
    const noAssistantStuckThresholdMs =
      config.taskTimeoutSeconds > 0
        ? Math.max(stuckThresholdMs * 1.5, timeoutMs)
        : stuckThresholdMs * 1.5;

    // Polling loop concurrent with child execution
    while (true) {
      const elapsed = Date.now() - startMs;

      parseJsonl();

      // Hard task timeout
      if (elapsed > timeoutMs) {
        await killChild(
          `hard task-timeout ${Math.round(elapsed / 1000)}s > ${Math.round(timeoutMs / 1000)}s`,
        );
        return {
          conversation,
          elapsedMs: Date.now() - startMs,
          completionStatus: "timeout",
          error: `task-timeout (${Math.round(timeoutMs / 1000)}s)`,
        };
      }

      // Child exited naturally
      if (childExitCode !== null || childError !== null) {
        // Give filesystem a moment to flush in case JSONL just got written
        await new Promise((r) => setTimeout(r, 500));
        parseJsonl();
        if (childError) {
          const errMsg = (childError as Error).message;
          return {
            conversation,
            elapsedMs: Date.now() - startMs,
            completionStatus: "error",
            error: errMsg,
          };
        }
        if (childExitCode !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          const stdout = Buffer.concat(stdoutChunks).toString().trim();
          return {
            conversation,
            elapsedMs: Date.now() - startMs,
            completionStatus: "error",
            error: `CLI exited ${childExitCode}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
          };
        }
        const trajectoryError = readTrajectoryError(trajectoryPath);
        if (trajectoryError) {
          return {
            conversation,
            elapsedMs: Date.now() - startMs,
            completionStatus: /timeout|timed out/i.test(trajectoryError) ? "timeout" : "error",
            error: `OpenClaw session error: ${trajectoryError.slice(0, 300)}`,
          };
        }
        if (conversation.length === 0) {
          return {
            conversation,
            elapsedMs: Date.now() - startMs,
            completionStatus: "error",
            error: "empty conversation transcript (no session JSONL turns parsed)",
          };
        }
        log(`  CLI completed successfully`);
        return {
          conversation,
          elapsedMs: Date.now() - startMs,
          completionStatus: "completed",
        };
      }

      // Idle detection: kill if JSONL AND stdio both quiet for stuckThreshold
      const idleSinceWrite = Date.now() - lastChangeMs;
      const idleSinceIo = Date.now() - lastIoMs;
      const realIdle = Math.min(idleSinceWrite, idleSinceIo);
      if (lastLineCount > 0 && realIdle > stuckThresholdMs) {
        const hasAssistant = conversation.some((t) => t.role === "assistant");
        if (hasAssistant) {
          await killChild(`task done via idle (${Math.round(realIdle / 1000)}s no JSONL/stdio)`);
          log(`  Task completed (idle ${Math.round(realIdle / 1000)}s)`);
          return {
            conversation,
            elapsedMs: Date.now() - startMs,
            completionStatus: "completed",
          };
        }
        // No assistant response yet. Large local Ollama runs may be generating
        // silently, so only fail here after the extended no-assistant threshold.
        if (realIdle > noAssistantStuckThresholdMs) {
          await killChild(`stuck without assistant turn (${Math.round(realIdle / 1000)}s idle)`);
          return {
            conversation,
            elapsedMs: Date.now() - startMs,
            completionStatus: "timeout",
            error: `idle-stuck-no-progress`,
          };
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ERROR: ${errMsg}\n`);
    return {
      conversation: [],
      elapsedMs: Date.now() - startMs,
      completionStatus: "error",
      error: errMsg,
    };
  }
}

/** Save results to disk in the standard directory structure. */
export function saveResults(result: AgentBenchmarkResult, outputDir: string): void {
  const runDir = path.join(outputDir, "runs", formatRunDirName(result));
  const evalDir = path.join(outputDir, "evaluations", formatRunDirName(result));
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(evalDir, { recursive: true });

  // metadata.json
  fs.writeFileSync(path.join(runDir, "metadata.json"), JSON.stringify(result.metadata, null, 2));

  // results.json (full results with conversations)
  fs.writeFileSync(path.join(runDir, "results.json"), JSON.stringify(result, null, 2));

  // Per-task transcripts
  const transcriptsDir = path.join(runDir, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });
  for (const tr of result.tasks) {
    const transcript = tr.conversation
      .map((t) => {
        if (t.role === "tool_call") {
          return `[tool_call] ${t.toolName} ${t.content}`;
        }
        if (t.role === "tool_result") {
          return `[tool_result] ${t.content}`;
        }
        return `[${t.role}] ${t.content}`;
      })
      .join("\n\n");
    fs.writeFileSync(path.join(transcriptsDir, `${tr.task.id}.txt`), transcript);
  }

  // Per-task evaluation stubs (placeholders for LLM judge results added later)
  for (const tr of result.tasks) {
    const evalFile = path.join(evalDir, `${tr.task.id}.json`);
    // Only write stub if no evaluation exists yet (don't overwrite existing judge results)
    if (!fs.existsSync(evalFile)) {
      fs.writeFileSync(
        evalFile,
        JSON.stringify(
          {
            taskId: tr.task.id,
            taskName: tr.task.name,
            gradingCriteria: tr.task.grading.criteria,
            maxScore: tr.task.grading.maxScore,
            toolCallCount: tr.toolCallCount,
            toolsUsed: tr.toolsUsed,
            completionStatus: tr.completionStatus,
            elapsedMs: tr.elapsedMs,
            conversationTurns: tr.conversation.length,
            transcriptFile: `transcripts/${tr.task.id}.txt`,
            llmJudge: null,
          },
          null,
          2,
        ),
      );
    }
  }

  // RESULTS.md (human-readable)
  const md = generateResultsMarkdown(result);
  fs.writeFileSync(path.join(runDir, "RESULTS.md"), md);

  console.log(`\nResults saved to: ${runDir}`);
  console.log(`Evaluations saved to: ${evalDir}`);
}

function formatRunDirName(result: AgentBenchmarkResult): string {
  const model = result.config.model.replace(/[/:]/g, "-");
  const quant = result.config.quant ? `__${result.config.quant}` : "";
  const ts = result.metadata.startedAt.replace(/[:.]/g, "-").slice(0, 19);
  return `${model}${quant}__${ts}`;
}

function generateResultsMarkdown(result: AgentBenchmarkResult): string {
  const { metadata, summary, tasks } = result;
  const vramGb = metadata.hardware.gpu.vramBytes
    ? Math.round(metadata.hardware.gpu.vramBytes / 1024 ** 3)
    : "?";
  const lines: string[] = [
    `# Benchmark Run: ${metadata.model}${metadata.quant ? ` (${metadata.quant})` : ""}`,
    "",
    `**Date:** ${metadata.startedAt}`,
    `**Hardware:** ${metadata.hardware.gpu.name ?? "unknown GPU"} (${vramGb}GB VRAM), ${metadata.hardware.cpu.model}, ${Math.round(metadata.hardware.ram.totalBytes / 1024 ** 3)}GB RAM`,
    `**Backend:** ${result.config.backend}`,
    `**Thinking:** ${metadata.thinkingLevel ?? "default"}`,
    `**Context:** ${metadata.contextLength ?? "default"}`,
    `**Git SHA:** ${metadata.gitSha ?? "unknown"}`,
    "",
    "## Run Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Tasks | ${summary.totalTasks} |`,
    `| Completed | ${summary.completedCount} |`,
    `| Errors | ${summary.errorCount} |`,
    `| Timeouts | ${summary.timeoutCount} |`,
    `| Total time | ${(summary.totalTimeMs / 1000).toFixed(1)}s |`,
    `| Tool calls | ${summary.totalToolCalls} (avg ${summary.avgToolCallsPerTask}/task) |`,
    "",
    "## Per-Task Results",
    "",
    "| Task | Category | Difficulty | Tools | Time | Status |",
    "|------|----------|------------|-------|------|--------|",
  ];

  for (const tr of tasks) {
    const timeStr = `${(tr.elapsedMs / 1000).toFixed(1)}s`;
    lines.push(
      `| ${tr.task.name} | ${tr.task.category} | ${tr.task.difficulty} | ${tr.toolCallCount} | ${timeStr} | ${tr.completionStatus} |`,
    );
  }

  lines.push("");
  lines.push("## Evaluation");
  lines.push("");
  lines.push("LLM judge evaluation results are in the `evaluations/` directory.");
  lines.push(
    "Each task has a `.json` file with grading criteria and (when evaluated) judge scores.",
  );
  lines.push("Full conversation transcripts are in `transcripts/`.");

  return lines.join("\n") + "\n";
}

// ── Main Runner ─────────────────────────────────────────────────────────────

export async function runAgentBenchmark(
  tasks: AgentBenchmarkTask[],
  config: AgentBenchmarkConfig,
  hardware: HardwareInfo,
  progress?: (msg: string) => void,
): Promise<AgentBenchmarkResult> {
  const log = progress ?? console.log;
  const startTime = Date.now();

  // Collect metadata
  const metadata = await collectMetadata(config, hardware);

  // Build Docker image for isolated benchmark agent (Frank directive May 5 2026)
  const dockerImage = process.env.GEMMACLAW_BENCH_IMAGE ?? "gemmaclaw-bench:latest";
  if (!config.mock) {
    log(`Ensuring Docker image '${dockerImage}' is available...`);
    try {
      execSync(`docker image inspect ${dockerImage} > /dev/null 2>&1`);
      log(`  Image exists`);
    } catch {
      log(`  Building image from scripts/benchmark/Dockerfile.agent...`);
      execSync(`docker build -t ${dockerImage} -f scripts/benchmark/Dockerfile.agent .`, {
        stdio: "inherit",
        timeout: 300_000,
      });
      log(`  Image built successfully`);
    }
  }

  // Seed mock gog state
  log("Seeding mock gog state...");
  seedMockGog(config.seedScript);

  // In mock mode, skip gateway check (no real agent needed)
  // The benchmark uses `gemmaclaw agent --local` which runs an embedded agent
  // without needing a gateway. Only check Ollama availability.
  if (!config.mock) {
    const backendUrl = config.backend === "llama-cpp" ? config.llamaCppUrl : config.ollamaUrl;
    log(`Checking ${config.backend} at ${backendUrl}...`);
    try {
      const endpoint = config.backend === "llama-cpp" ? "/health" : "/api/tags";
      await httpGet(`${backendUrl}${endpoint}`, 5_000);
      log(`  ${config.backend} is available`);
    } catch (err) {
      throw new Error(
        `${config.backend} not responding at ${backendUrl}. Start ${config.backend} first.`,
        { cause: err },
      );
    }
  } else {
    log("Mock mode: skipping backend health check");
  }

  // Filter tasks if requested
  const filteredTasks = config.filter
    ? tasks.filter(
        (t) =>
          t.id.includes(config.filter!) ||
          t.name.toLowerCase().includes(config.filter!.toLowerCase()),
      )
    : tasks;

  log(`\nRunning ${filteredTasks.length} agent tasks against ${config.model}...\n`);

  const results: AgentTaskResult[] = [];

  // Checkpoint support: load existing progress so the run can resume if the process dies.
  const checkpointDir = "/tmp/gc-benchmark-checkpoints";
  const safeModel = config.model.replace(/[/:]/g, "_").replace(/[^a-zA-Z0-9_-]/g, "");
  const checkpointPath = `${checkpointDir}/${safeModel}.checkpoint.json`;
  const checkpointedIds = new Set<string>();
  if (!config.mock) {
    try {
      if (fs.existsSync(checkpointPath)) {
        const cp = JSON.parse(fs.readFileSync(checkpointPath, "utf-8")) as {
          tasks: AgentTaskResult[];
        };
        for (const t of cp.tasks ?? []) {
          results.push(t);
          checkpointedIds.add(t.task.id);
        }
        if (results.length > 0) {
          log(
            `Resuming from checkpoint: ${results.length} tasks already done (${[...checkpointedIds].join(", ")})`,
          );
        }
      }
    } catch {
      log("  Warning: could not load checkpoint, starting fresh");
    }
  }

  for (let i = 0; i < filteredTasks.length; i++) {
    const task = filteredTasks[i];
    const taskNum = `[${i + 1}/${filteredTasks.length}]`;

    // Skip tasks already completed in a prior run (checkpoint resume).
    if (!config.mock && checkpointedIds.has(task.id)) {
      const prev = results.find((r) => r.task.id === task.id);
      log(
        `${taskNum} ${task.name} (${task.difficulty}) - RESUMED from checkpoint (${prev?.completionStatus ?? "?"})`,
      );
      continue;
    }

    log(`${taskNum} ${task.name} (${task.difficulty})`);

    const sessionId = `bench-${task.id}-${Date.now()}`;

    // Re-seed mock gog state before each task (clean slate)
    seedMockGog(config.seedScript);

    let conversation: ConversationTurn[];
    let elapsedMs: number;
    let completionStatus: "completed" | "timeout" | "error";
    let error: string | undefined;

    if (config.mock) {
      // Mock mode: simulate a successful agent run without dispatching
      conversation = [
        { role: "user", content: task.prompt },
        { role: "assistant", content: `[Mock] Processing task: ${task.name}` },
        { role: "tool_call", content: "{}", toolName: "gog", toolArgs: {} },
        { role: "tool_result", content: "[Mock] Tool result" },
        { role: "assistant", content: `[Mock] Task completed: ${task.name}` },
      ];
      elapsedMs = 50;
      completionStatus = "completed";
    } else {
      // Real mode: dispatch to gateway and collect conversation
      const result = await dispatchTask(task, config, sessionId, log);
      conversation = result.conversation;
      elapsedMs = result.elapsedMs;
      completionStatus = result.completionStatus;
      error = result.error;
    }

    // Extract tool call stats
    const toolCalls = conversation.filter((t) => t.role === "tool_call");
    const toolCallCount = toolCalls.length;
    const toolsUsed = [...new Set(toolCalls.map((t) => t.toolName).filter(Boolean))] as string[];

    log(
      `  ${completionStatus.toUpperCase()} | ${toolCallCount} tool calls | ${(elapsedMs / 1000).toFixed(1)}s${error ? ` | ${error}` : ""}`,
    );

    results.push({
      task,
      conversation,
      elapsedMs,
      toolCallCount,
      toolsUsed,
      completionStatus,
      error,
    });

    // Save checkpoint after each task so we can resume if the process dies.
    if (!config.mock) {
      try {
        fs.mkdirSync(checkpointDir, { recursive: true });
        fs.writeFileSync(
          checkpointPath,
          JSON.stringify(
            { model: config.model, savedAt: new Date().toISOString(), tasks: results },
            null,
            2,
          ),
        );
      } catch {}
    }
  }

  // All tasks done: remove the checkpoint (run succeeded, no resume needed).
  if (!config.mock) {
    try {
      fs.unlinkSync(checkpointPath);
    } catch {}
  }

  const totalTimeMs = Date.now() - startTime;
  metadata.finishedAt = new Date().toISOString();

  const totalTasks = results.length;
  const completedCount = results.filter((r) => r.completionStatus === "completed").length;
  const errorCount = results.filter((r) => r.completionStatus === "error").length;
  const timeoutCount = results.filter((r) => r.completionStatus === "timeout").length;
  const totalToolCalls = results.reduce((s, r) => s + r.toolCallCount, 0);

  return {
    metadata,
    config,
    tasks: results,
    summary: {
      totalTasks,
      completedCount,
      errorCount,
      timeoutCount,
      totalTimeMs,
      totalToolCalls,
      avgToolCallsPerTask: totalTasks > 0 ? Math.round((totalToolCalls / totalTasks) * 10) / 10 : 0,
    },
  };
}
// benchmark harness v2
