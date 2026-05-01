/**
 * E2E Agent Benchmark Runner.
 *
 * Dispatches tasks to a running gemmaclaw gateway, captures full conversations
 * (tool calls, results, reasoning), and judges the agent loop.
 *
 * Architecture:
 *   1. Seed mock gog state (emails, calendar, tasks, contacts)
 *   2. For each task: send message to gateway, poll session JSONL for completion
 *   3. Extract full conversation transcript (including tool calls)
 *   4. LLM judge scores the entire agent interaction
 *   5. Save results with rich metadata
 *
 * Configuration:
 *   - gatewayUrl: defaults to http://localhost:3001 (local gemmaclaw)
 *   - ollamaUrl: defaults to http://localhost:11434
 *   - Can target remote gemmaclaw instances via URL config
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { HardwareInfo } from "../provision/hardware.js";
import type { AgentBenchmarkTask } from "./agent-tasks.js";
import { parseJudgeResponse, type TaskScore } from "./scorer.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type AgentBenchmarkConfig = {
  /** URL of the gemmaclaw gateway. */
  gatewayUrl: string;
  /** URL of the Ollama backend for model inference. */
  ollamaUrl: string;
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
  /** Model for LLM judge evaluation. Defaults to same model. */
  judgeModel?: string;
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
  /** LLM judge score. */
  score: TaskScore;
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
    totalScore: number;
    maxScore: number;
    percentage: number;
    totalTimeMs: number;
    avgTokensPerSecond?: number;
    passedCount: number;
    failedCount: number;
    passRate: number;
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

/** Seed mock gog state before a benchmark run. */
export function seedMockGog(seedScript?: string): void {
  // Find repo root from cwd (pnpm sets cwd to repo root)
  const script = seedScript ?? path.resolve(process.cwd(), "scripts/benchmark/seed-mock-gog.py");
  if (!fs.existsSync(script)) {
    throw new Error(`Mock gog seed script not found: ${script}`);
  }
  execSync(`python3 ${script}`, { stdio: "inherit" });
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

  // Send message to gateway via CLI
  const args = [
    "gemmaclaw",
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

  // Per-task evaluation files
  for (const tr of result.tasks) {
    fs.writeFileSync(
      path.join(evalDir, `${tr.task.id}.json`),
      JSON.stringify(
        {
          taskId: tr.task.id,
          taskName: tr.task.name,
          score: tr.score,
          toolCallCount: tr.toolCallCount,
          toolsUsed: tr.toolsUsed,
          completionStatus: tr.completionStatus,
          elapsedMs: tr.elapsedMs,
        },
        null,
        2,
      ),
    );
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
  const lines: string[] = [
    `# Benchmark Results: ${metadata.model}${metadata.quant ? ` (${metadata.quant})` : ""}`,
    "",
    `**Date:** ${metadata.startedAt}`,
    `**Hardware:** ${metadata.hardware.gpu.name ?? "unknown GPU"} (${metadata.hardware.gpu.vramBytes ? Math.round(metadata.hardware.gpu.vramBytes / 1024 ** 3) : "?"}GB VRAM)`,
    `**Thinking:** ${metadata.thinkingLevel ?? "default"}`,
    `**Context:** ${metadata.contextLength ?? "default"}`,
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Score | ${summary.totalScore}/${summary.maxScore} (${summary.percentage}%) |`,
    `| Pass rate | ${summary.passRate}% (${summary.passedCount}/${summary.passedCount + summary.failedCount}) |`,
    `| Total time | ${(summary.totalTimeMs / 1000).toFixed(1)}s |`,
    `| Tool calls | ${summary.totalToolCalls} (avg ${summary.avgToolCallsPerTask.toFixed(1)}/task) |`,
    "",
    "## Per-Task Results",
    "",
    `| Task | Score | Tools | Time | Status |`,
    `|------|-------|-------|------|--------|`,
  ];

  for (const tr of tasks) {
    const scoreStr = `${tr.score.score}/${tr.score.maxScore}`;
    const timeStr = `${(tr.elapsedMs / 1000).toFixed(1)}s`;
    const icon = tr.score.passed ? "PASS" : "FAIL";
    lines.push(`| ${tr.task.name} | ${scoreStr} | ${tr.toolCallCount} | ${timeStr} | ${icon} |`);
  }

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

  // Check gateway health
  log(`Checking gateway at ${config.gatewayUrl}...`);
  const healthy = await checkGateway(config.gatewayUrl);
  if (!healthy) {
    throw new Error(
      `Gateway not responding at ${config.gatewayUrl}. ` +
        `Start gemmaclaw first: gemmaclaw gateway start`,
    );
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

    // Dispatch and collect conversation
    const { conversation, elapsedMs, completionStatus, error } = await dispatchTask(
      task,
      config,
      sessionId,
      log,
    );

    // Extract tool call stats
    const toolCalls = conversation.filter((t) => t.role === "tool_call");
    const toolCallCount = toolCalls.length;
    const toolsUsed = [...new Set(toolCalls.map((t) => t.toolName).filter(Boolean))] as string[];

    // Judge the conversation
    let score: TaskScore;
    if (config.mock) {
      score = {
        taskId: task.id,
        score: completionStatus === "completed" ? task.grading.maxScore : 0,
        maxScore: task.grading.maxScore,
        percentage: completionStatus === "completed" ? 100 : 0,
        method: "deterministic" as const,
        details: "Mock mode: auto-pass on completion",
        passed: completionStatus === "completed",
      };
    } else if (error || completionStatus === "error") {
      score = {
        taskId: task.id,
        score: 0,
        maxScore: task.grading.maxScore,
        percentage: 0,
        method: "deterministic" as const,
        details: `Error: ${error}`,
        passed: false,
      };
    } else {
      // Build conversation text for the judge
      const conversationText = conversation
        .map((t) => {
          if (t.role === "tool_call") {
            return `[Tool Call: ${t.toolName}] ${t.content}`;
          }
          if (t.role === "tool_result") {
            return `[Tool Result] ${t.content}`;
          }
          return `[${t.role}] ${t.content}`;
        })
        .join("\n\n");

      const judgePrompt = buildAgentJudgePrompt(task, conversationText);
      try {
        const judgeResp = await httpPost(
          `${config.ollamaUrl}/api/chat`,
          JSON.stringify({
            model: config.judgeModel ?? config.model,
            messages: [
              {
                role: "system",
                content:
                  "You are a strict but fair evaluator of AI agent performance. Score based on the criteria provided.",
              },
              { role: "user", content: judgePrompt },
            ],
            stream: false,
            keep_alive: "6h",
          }),
          600_000,
        );
        const judgeData = JSON.parse(judgeResp);
        const judgeContent = judgeData.message?.content ?? "";
        score = parseJudgeResponse(judgeContent, task.grading.maxScore);
        score.taskId = task.id;
      } catch {
        score = {
          taskId: task.id,
          score: 0,
          maxScore: task.grading.maxScore,
          percentage: 0,
          method: "deterministic" as const,
          details: "LLM judge evaluation failed",
          passed: false,
        };
      }
    }

    const statusIcon = score.passed ? "PASS" : "FAIL";
    log(
      `  ${statusIcon} ${score.score}/${score.maxScore} | ${toolCallCount} tool calls | ${(elapsedMs / 1000).toFixed(1)}s | ${completionStatus}`,
    );

    results.push({
      task,
      conversation,
      score,
      elapsedMs,
      toolCallCount,
      toolsUsed,
      completionStatus,
      error,
    });
  }

  const totalTimeMs = Date.now() - startTime;
  metadata.finishedAt = new Date().toISOString();

  const totalScore = results.reduce((s, r) => s + r.score.score, 0);
  const maxScore = results.reduce((s, r) => s + r.score.maxScore, 0);
  const passedCount = results.filter((r) => r.score.passed).length;
  const failedCount = results.filter((r) => !r.score.passed).length;
  const totalTasks = passedCount + failedCount;
  const totalToolCalls = results.reduce((s, r) => s + r.toolCallCount, 0);

  return {
    metadata,
    config,
    tasks: results,
    summary: {
      totalScore: Math.round(totalScore * 10) / 10,
      maxScore,
      percentage: maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0,
      totalTimeMs,
      passedCount,
      failedCount,
      passRate: totalTasks > 0 ? Math.round((passedCount / totalTasks) * 1000) / 10 : 0,
      totalToolCalls,
      avgToolCallsPerTask: totalTasks > 0 ? Math.round((totalToolCalls / totalTasks) * 10) / 10 : 0,
    },
  };
}

function buildAgentJudgePrompt(task: AgentBenchmarkTask, conversationText: string): string {
  const criteria = task.grading.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return [
    `You are evaluating an AI agent's performance on a task.`,
    ``,
    `TASK: ${task.name}`,
    `PROMPT: ${task.prompt}`,
    ``,
    `GRADING CRITERIA (${task.grading.maxScore} points total):`,
    criteria,
    ``,
    `FULL AGENT CONVERSATION (including tool calls and results):`,
    conversationText,
    ``,
    `Score the agent's performance. For each criterion, state whether it was met.`,
    `Then give a final SCORE: X/${task.grading.maxScore}`,
    `And REASONING: one paragraph explaining the score.`,
  ].join("\n");
}
