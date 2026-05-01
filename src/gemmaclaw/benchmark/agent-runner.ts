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

/** Check if gateway is healthy. */
export async function checkGateway(gatewayUrl: string): Promise<boolean> {
  try {
    const resp = await httpGet(`${gatewayUrl}/healthz`, 5_000);
    return resp.includes("ok");
  } catch {
    return false;
  }
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

  // Send message to gateway via CLI.
  // Resolve gemmaclaw binary: prefer GEMMACLAW_BIN env, then check common locations.
  const gemmaclawBin =
    process.env.GEMMACLAW_BIN ??
    (fs.existsSync("/app/gemmaclaw.mjs") ? "node /app/gemmaclaw.mjs" : "gemmaclaw");
  const binParts = gemmaclawBin.split(" ");

  const args = [
    ...binParts,
    "agent",
    "--local",
    "--session-id",
    sessionId,
    "--message",
    task.prompt,
  ];
  if (config.thinkingLevel) {
    args.push("--thinking", config.thinkingLevel);
  }

  try {
    const child = spawn(args[0], args.slice(1), {
      env: {
        ...process.env,
        ...(config.gemmaclawHome ? { OPENCLAW_HOME: config.gemmaclawHome } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait for the CLI to finish sending the message
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`gemmaclaw agent exited with code ${code}`));
        }
      });
      child.on("error", reject);
    });
  } catch (e) {
    return {
      conversation: [],
      elapsedMs: Date.now() - startMs,
      completionStatus: "error",
      error: e instanceof Error ? e.message : String(e),
    };
  }

  // Poll session JSONL for completion
  const sessionsDir = config.gemmaclawHome
    ? path.join(config.gemmaclawHome, "agents/main/sessions")
    : path.join(process.env.HOME ?? "/root", ".openclaw/agents/main/sessions");

  const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);

  let lastLineCount = 0;
  let lastChangeMs = Date.now();
  const conversation: ConversationTurn[] = [];

  while (true) {
    const elapsed = Date.now() - startMs;
    if (elapsed > timeoutMs) {
      return { conversation, elapsedMs: elapsed, completionStatus: "timeout" };
    }

    // Read JSONL and check for new lines
    if (fs.existsSync(jsonlPath)) {
      try {
        const lines = fs.readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean);
        if (lines.length > lastLineCount) {
          lastLineCount = lines.length;
          lastChangeMs = Date.now();

          // Parse conversation from JSONL
          conversation.length = 0;
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const msg = entry.message ?? entry;
              const role = msg.role;
              const content = msg.content;

              if (role === "user" && typeof content === "string") {
                conversation.push({ role: "user", content, timestamp: entry.timestamp });
              } else if (role === "assistant") {
                if (typeof content === "string") {
                  conversation.push({ role: "assistant", content, timestamp: entry.timestamp });
                } else if (Array.isArray(content)) {
                  for (const block of content) {
                    if (block.type === "text" && block.text) {
                      conversation.push({
                        role: "assistant",
                        content: block.text,
                        timestamp: entry.timestamp,
                      });
                    } else if (block.type === "tool_use") {
                      conversation.push({
                        role: "tool_call",
                        content: JSON.stringify(block.input ?? {}),
                        toolName: block.name,
                        toolArgs: block.input,
                        timestamp: entry.timestamp,
                      });
                    } else if (block.type === "tool_result") {
                      const text =
                        typeof block.content === "string"
                          ? block.content
                          : Array.isArray(block.content)
                            ? block.content.map((c: { text?: string }) => c.text ?? "").join("\n")
                            : JSON.stringify(block.content);
                      conversation.push({
                        role: "tool_result",
                        content: text,
                        timestamp: entry.timestamp,
                      });
                    }
                  }
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }
        }

        // Check for idle completion: no new lines for idleTimeoutSeconds
        const idleDuration = Date.now() - lastChangeMs;
        if (lastLineCount > 0 && idleDuration > idleMs) {
          // Check if we have at least one assistant response
          const hasAssistant = conversation.some((t) => t.role === "assistant");
          if (hasAssistant) {
            log(`  Task completed (idle ${Math.round(idleDuration / 1000)}s)`);
            return { conversation, elapsedMs: Date.now() - startMs, completionStatus: "completed" };
          }
        }
      } catch {
        // File might be mid-write
      }
    }

    // Poll every 2 seconds
    await new Promise((r) => setTimeout(r, 2000));
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

  // Seed mock gog state
  log("Seeding mock gog state...");
  seedMockGog(config.seedScript);

  // In mock mode, skip gateway check (no real agent needed)
  if (!config.mock) {
    log(`Checking gateway at ${config.gatewayUrl}...`);
    const healthy = await checkGateway(config.gatewayUrl);
    if (!healthy) {
      throw new Error(
        `Gateway not responding at ${config.gatewayUrl}. ` +
          `Start gemmaclaw first: gemmaclaw gateway start`,
      );
    }
  } else {
    log("Mock mode: skipping gateway health check");
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

  for (let i = 0; i < filteredTasks.length; i++) {
    const task = filteredTasks[i];
    const taskNum = `[${i + 1}/${filteredTasks.length}]`;
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
