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
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  GEMMACLAW_ENHANCEMENT_SELECTION_FILENAME,
  resolveGemmaclawEnhancementIds,
} from "../gemmaclaw_instructions.js";
import type { HardwareInfo } from "../provision/hardware.js";
import { detectSystemTools } from "../provision/hardware.js";
import { selectQuickProfile } from "../provision/setup-wizard.js";
import {
  evaluateDeterministicAgentTaskConversation,
  type AgentBenchmarkTask,
} from "./agent-tasks.js";
import {
  inspectTaskQuality,
  summarizeQualityInspection,
  summarizeValidation,
  validateTaskArtifact,
  type QualityInspectionResult,
  type ValidationResult,
} from "./agent-validator.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type AgentBackendType =
  | "ollama"
  | "llama-cpp"
  | "openai-codex"
  | "google-gemini-cli"
  | "openrouter";

export const AGENT_BACKENDS = [
  "ollama",
  "llama-cpp",
  "openai-codex",
  "google-gemini-cli",
  "openrouter",
] as const;

export type AgentBenchmarkConfig = {
  /** URL of the gemmaclaw gateway. */
  gatewayUrl: string;
  /** Backend type for model inference. */
  backend: AgentBackendType;
  /** URL of the Ollama backend. */
  ollamaUrl: string;
  /** URL of the llama.cpp server (OpenAI-compatible). */
  llamaCppUrl: string;
  /** Model identifier (e.g. gemma4:31b, gpt-5.5). */
  model: string;
  /** Quantization level if applicable (e.g. Q4_K_M, Q8_0, FP16). */
  quant?: string;
  /** Thinking/reasoning level (off, low, medium, high, xhigh). */
  thinkingLevel?: string;
  /**
   * Maximum seconds to wait for a single task to complete. 0 = no limit.
   *
   * Historically this was the only timeout; in the new harness it acts as a
   * BACKWARD-COMPAT alias for {@link hardCapSeconds} when the latter is not
   * set. Activity-based timeout ({@link noActivityTimeoutSeconds}) is the
   * normal "task is stuck" signal; the hard cap exists only as a runaway
   * guard for catastrophic loops.
   */
  taskTimeoutSeconds: number;
  /** Seconds of idle (no new JSONL lines) before considering task done. */
  idleTimeoutSeconds: number;
  /**
   * Seconds with no useful agent activity before declaring the task stuck.
   * "Useful activity" = stdout/stderr chunk, new session JSONL line, new
   * trajectory JSONL line, provider-owned thinking/tool log update, or
   * assistant/tool turn parsed from JSONL. Defaults to 600 (10 minutes) when
   * not set, per Frank's directive that timeout should mean "no progress for
   * 10 minutes" rather than a hard wall-clock cap.
   */
  noActivityTimeoutSeconds?: number;
  /**
   * Hard wall-clock runaway cap, in seconds. Defaults to
   * `max(taskTimeoutSeconds, 28800)` when not set, so legacy callers that
   * pass `taskTimeoutSeconds: 3600` keep their existing semantics while new
   * callers can let benchmarks run as long as they remain active. Always
   * acts as a hard ceiling regardless of activity.
   */
  hardCapSeconds?: number;
  /** When true, run the validation gate after each task. Defaults to true. */
  validatePerTask?: boolean;
  /**
   * When true, run a lightweight quality/readiness inspection after each task.
   * This records score-readiness warnings before the next task is dispatched.
   * Defaults to true.
   */
  qualityInspectPerTask?: boolean;
  /**
   * When true and per-task validation produces a block-severity issue, the
   * runner reruns the task once before recording a final failure. Defaults
   * to true.
   */
  validationRerunOnFail?: boolean;
  /** Path to mock gog seed script. */
  seedScript?: string;
  /** Path to gemmaclaw home for isolated runs. */
  gemmaclawHome?: string;
  /** Directory for per-task dispatch logs. Defaults to a temp directory. */
  logDir?: string;
  /** Filter tasks by id pattern (substring match). */
  filter?: string;
  /** Run in mock mode (no real model, deterministic responses). */
  mock?: boolean;
  /** Ollama context length. */
  contextLength?: number;
  /** Output directory for results. Defaults to benchmark-results. */
  outputDir?: string;
  /** Stable run id. Use this to resume or rerun tasks into an existing run. */
  runId?: string;
  /** Force rerun of selected tasks even if a matching per-task result exists. */
  rerun?: boolean;
  /** Rerun only tasks whose existing result is timeout/error. */
  rerunFailed?: boolean;
  /** Internal: force per-task artifacts to use the shared parent run hash. */
  artifactConfigHash?: string;
  /** Internal: manifest config to write when a per-task container runs a slice. */
  manifestConfig?: AgentBenchmarkConfig;
  /** Internal: full selected task set for the shared run manifest. */
  manifestTaskIds?: string[];
  /** Gemmaclaw runtime enhancement selection for the benchmark workspace. */
  gemmaclawEnhancements?: string;
};

export type ConversationTurn = {
  role: "user" | "assistant" | "thinking" | "tool_call" | "tool_result" | "system";
  content: string;
  /** Tool name if role is tool_call. */
  toolName?: string;
  /** Tool arguments if role is tool_call. */
  toolArgs?: Record<string, unknown>;
  /** Timestamp of this turn. */
  timestamp?: string;
  /** Provider-reported output tokens for the assistant response that produced this turn. */
  outputTokens?: number;
};

export type AgentTaskResult = {
  task: AgentBenchmarkTask;
  /** Full conversation transcript including tool calls. */
  conversation: ConversationTurn[];
  /** Wall clock time for this task. */
  elapsedMs: number;
  /** Tokens per second (generation speed). */
  tokensPerSecond?: number;
  /**
   * Source of tokensPerSecond. "measured" comes from generation-only provider
   * timing. "effective-output" is provider output tokens over response interval,
   * which can include prompt evaluation but excludes tool execution time.
   * "estimated-output" is tokenizer-independent fallback speed.
   */
  tokensPerSecondSource?: "measured" | "effective-output" | "estimated-output";
  /** Number of tool calls the agent made. */
  toolCallCount: number;
  /** List of tools the agent called. */
  toolsUsed: string[];
  /** Whether the task completed or timed out. */
  completionStatus: "completed" | "timeout" | "error";
  /** Error message if any. */
  error?: string;
  /**
   * Validation gate result for this task, when {@link AgentBenchmarkConfig.validatePerTask}
   * is enabled. Persisted in the artifact so downstream evaluators and the
   * site generator can surface validation issues without rerunning the gate.
   */
  validation?: ValidationResult;
  /**
   * Lightweight score-readiness inspection for this task. This is not the LLM
   * judge score; it catches malformed artifacts/tool usage before publication.
   */
  qualityInspection?: QualityInspectionResult;
  /** Number of times this task was rerun by the validation gate (0 = first try). */
  validationRerunCount?: number;
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

type AgentRunManifest = {
  schemaVersion: 1;
  runId: string;
  configHash: string;
  config: AgentBenchmarkConfig;
  metadata: RunMetadata;
  taskIds: string[];
  createdAt: string;
  updatedAt: string;
};

type AgentTaskArtifact = {
  schemaVersion: 1;
  runId: string;
  configHash: string;
  savedAt: string;
  result: AgentTaskResult;
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .toSorted()
      .filter((key) => obj[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeConfigHash(config: AgentBenchmarkConfig): string {
  const hashInput = {
    backend: config.backend,
    contextLength: config.contextLength,
    filter: config.filter,
    idleTimeoutSeconds: config.idleTimeoutSeconds,
    llamaCppUrl: config.llamaCppUrl,
    mock: config.mock ?? false,
    model: config.model,
    noActivityTimeoutSeconds: config.noActivityTimeoutSeconds ?? null,
    hardCapSeconds: config.hardCapSeconds ?? null,
    validatePerTask: config.validatePerTask !== false,
    qualityInspectPerTask: config.qualityInspectPerTask !== false,
    validationRerunOnFail: config.validationRerunOnFail !== false,
    ollamaUrl: config.ollamaUrl,
    quant: config.quant,
    seedScript: config.seedScript,
    taskTimeoutSeconds: config.taskTimeoutSeconds,
    thinkingLevel: config.thinkingLevel,
  };
  return crypto.createHash("sha256").update(stableJson(hashInput)).digest("hex").slice(0, 16);
}

function atomicWriteJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function formatRunDirNameFromConfig(config: AgentBenchmarkConfig, metadata: RunMetadata): string {
  if (config.runId) {
    return config.runId;
  }
  const model = config.model.replace(/[/:]/g, "-");
  const quant = config.quant ? `__${config.quant}` : "";
  const ts = metadata.startedAt.replace(/[:.]/g, "-").slice(0, 19);
  return `${model}${quant}__${ts}`;
}

function taskArtifactPath(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId, "result.json");
}

function taskTranscriptPath(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId, "transcript.txt");
}

function taskSessionCopyPath(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId, "session.jsonl");
}

function taskTrajectoryCopyPath(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId, "trajectory.jsonl");
}

function taskStartedMarkerPath(runDir: string, taskId: string): string {
  return path.join(runDir, "tasks", taskId, "started.json");
}

/**
 * Per-task "started" marker. Written before each dispatch attempt so silent
 * kills of the runner process (parent worker death, OOM, host shutdown) leave
 * observable evidence that the task was attempted. Without this marker, an
 * interrupted dispatch is indistinguishable from "never tried" because
 * result.json is only written after dispatch returns. Motivation: 2026-05-10
 * context_memory_chain rerun was killed mid-flight and produced no artifact
 * at all. The marker is cleared on completion (success/timeout/error) when
 * result.json lands, so a started.json with no result.json is a positive
 * signal that the attempt was killed.
 */
export type TaskStartedMarker = {
  schemaVersion: 1;
  taskId: string;
  taskName: string;
  runId: string;
  configHash: string;
  sessionId: string;
  attempt: number;
  startedAt: string;
  pid: number;
};

export function writeTaskStartedMarker(runDir: string, marker: TaskStartedMarker): void {
  const taskDir = path.join(runDir, "tasks", marker.taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  atomicWriteJson(taskStartedMarkerPath(runDir, marker.taskId), marker);
}

export function clearTaskStartedMarker(runDir: string, taskId: string): void {
  const filePath = taskStartedMarkerPath(runDir, taskId);
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

export function readTaskStartedMarker(
  runDir: string,
  taskId: string,
): TaskStartedMarker | undefined {
  const filePath = taskStartedMarkerPath(runDir, taskId);
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TaskStartedMarker;
  } catch {
    return undefined;
  }
}

function writeTranscript(filePath: string, result: AgentTaskResult): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const transcript = result.conversation
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
  fs.writeFileSync(filePath, transcript);
}

export function estimateConversationOutputTokens(conversation: ConversationTurn[]): number {
  let charCount = 0;
  for (const turn of conversation) {
    if (turn.role === "assistant" || turn.role === "thinking") {
      charCount += turn.content.length;
    }
  }
  return charCount > 0 ? Math.max(1, Math.round(charCount / 4)) : 0;
}

export function estimateConversationTokensPerSecond(
  conversation: ConversationTurn[],
  elapsedMs: number,
): number | undefined {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return undefined;
  }
  const outputTokens = estimateConversationOutputTokens(conversation);
  if (outputTokens <= 0) {
    return undefined;
  }
  return outputTokens / (elapsedMs / 1000);
}

function timestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function estimateConversationEffectiveTokensPerSecond(
  conversation: ConversationTurn[],
): number | undefined {
  let previousTimestampMs: number | undefined;
  let outputTokens = 0;
  let responseMs = 0;
  for (const turn of conversation) {
    const currentTimestampMs = timestampMs(turn.timestamp);
    if (
      typeof turn.outputTokens === "number" &&
      turn.outputTokens > 0 &&
      currentTimestampMs !== undefined &&
      previousTimestampMs !== undefined
    ) {
      const deltaMs = currentTimestampMs - previousTimestampMs;
      if (deltaMs > 0 && deltaMs < 600_000) {
        outputTokens += turn.outputTokens;
        responseMs += deltaMs;
      }
    }
    if (currentTimestampMs !== undefined) {
      previousTimestampMs = currentTimestampMs;
    }
  }
  if (outputTokens <= 0 || responseMs <= 0) {
    return undefined;
  }
  return outputTokens / (responseMs / 1000);
}

export function writeTaskArtifact(
  runDir: string,
  runId: string,
  configHash: string,
  result: AgentTaskResult,
): void {
  const taskDir = path.join(runDir, "tasks", result.task.id);
  fs.mkdirSync(taskDir, { recursive: true });
  writeTranscript(taskTranscriptPath(runDir, result.task.id), result);
  atomicWriteJson(taskArtifactPath(runDir, result.task.id), {
    schemaVersion: 1,
    runId,
    configHash,
    savedAt: new Date().toISOString(),
    result,
  } satisfies AgentTaskArtifact);
}

function copyIfExists(source: string | undefined, dest: string): void {
  if (!source || !fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

export function loadTaskArtifacts(runDir: string, configHash: string): AgentTaskResult[] {
  const tasksDir = path.join(runDir, "tasks");
  if (!fs.existsSync(tasksDir)) {
    return [];
  }
  const results: AgentTaskResult[] = [];
  for (const taskId of fs.readdirSync(tasksDir)) {
    const filePath = taskArtifactPath(runDir, taskId);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const artifact = JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentTaskArtifact;
      if (artifact.configHash === configHash && artifact.result?.task?.id === taskId) {
        results.push(artifact.result);
      }
    } catch {
      /* Ignore malformed partial artifacts. Atomic writes should prevent this. */
    }
  }
  return results;
}

function sortTaskResultsByDefinition(
  results: AgentTaskResult[],
  tasks: AgentBenchmarkTask[],
): AgentTaskResult[] {
  const order = new Map(tasks.map((task, index) => [task.id, index]));
  return results.toSorted(
    (a, b) =>
      (order.get(a.task.id) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.task.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

function buildBenchmarkResult(
  metadata: RunMetadata,
  config: AgentBenchmarkConfig,
  tasks: AgentTaskResult[],
  startedAtMs: number,
): AgentBenchmarkResult {
  const totalTasks = tasks.length;
  const completedCount = tasks.filter((r) => r.completionStatus === "completed").length;
  const errorCount = tasks.filter((r) => r.completionStatus === "error").length;
  const timeoutCount = tasks.filter((r) => r.completionStatus === "timeout").length;
  const totalToolCalls = tasks.reduce((s, r) => s + r.toolCallCount, 0);
  return {
    metadata,
    config,
    tasks,
    summary: {
      totalTasks,
      completedCount,
      errorCount,
      timeoutCount,
      totalTimeMs: Date.now() - startedAtMs,
      totalToolCalls,
      avgToolCallsPerTask: totalTasks > 0 ? Math.round((totalToolCalls / totalTasks) * 10) / 10 : 0,
    },
  };
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

  let effectiveHardware = hardware;
  if (!hardware.gpu.detected && (config.backend === "llama-cpp" || config.backend === "ollama")) {
    const hostHardware = parseHostBenchmarkHardware();
    if (hostHardware?.gpu.detected) {
      effectiveHardware = hostHardware;
    }
  }

  // When running inside a Docker container (no local GPU passthrough) but using
  // the Ollama backend, the host Ollama server is doing GPU-backed inference.
  // Query /api/ps to detect actual GPU VRAM in use so the manifest accurately
  // records that this was a GPU-backed run even if no host hardware snapshot was
  // forwarded by the parent launcher.
  if (!effectiveHardware.gpu.detected && config.backend === "ollama" && config.ollamaUrl) {
    try {
      const psResp = await httpGet(`${config.ollamaUrl}/api/ps`, 10_000);
      const ps = JSON.parse(psResp) as { models?: { size_vram?: number }[] };
      const totalVram = (ps.models ?? []).reduce((sum, m) => sum + (m.size_vram ?? 0), 0);
      if (totalVram > 0) {
        effectiveHardware = {
          ...hardware,
          gpu: {
            detected: true,
            nvidia: true,
            apple: false,
            name: "GPU (via Ollama host)",
            vramBytes: totalVram,
          },
        };
      }
    } catch {
      /* ollama ps not available or container not using ollama host */
    }
  }

  return {
    model: config.model,
    quant: config.quant,
    thinkingLevel: config.thinkingLevel,
    hardware: effectiveHardware,
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

function parseHostBenchmarkHardware(): HardwareInfo | undefined {
  const raw = process.env.GEMMACLAW_BENCHMARK_HOST_HARDWARE;
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as HardwareInfo;
    if (
      typeof parsed?.cpu?.model === "string" &&
      typeof parsed?.ram?.totalBytes === "number" &&
      typeof parsed?.gpu?.detected === "boolean"
    ) {
      return parsed;
    }
  } catch {
    /* ignore malformed parent hardware snapshots */
  }
  return undefined;
}

/** Seed mock gog state before a benchmark run. Always requires an isolated state directory. */
export function seedMockGog(seedScript?: string, stateDir?: string): void {
  // Find repo root from cwd (pnpm sets cwd to repo root)
  const script = seedScript ?? path.resolve(process.cwd(), "scripts/benchmark/seed-mock-gog.py");
  if (!fs.existsSync(script)) {
    throw new Error(`Mock gog seed script not found: ${script}`);
  }
  if (!stateDir) {
    throw new Error("Mock gog seed requires an isolated stateDir");
  }
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  env.GEMMACLAW_MOCK_GOG_STATE_DIR = stateDir;
  execSync(`python3 ${script}`, { stdio: "inherit", env });
}

function benchmarkSeedStateDir(config: AgentBenchmarkConfig): string {
  const base =
    config.gemmaclawHome ?? path.join(os.tmpdir(), `gemmaclaw-bench-state-${Date.now()}`);
  return path.join(base, ".config/gogcli/state");
}

type AuthProfiles = Record<string, unknown>;

export function resolveAgentProviderPrefix(
  backend: AgentBackendType,
): "ollama" | "openai" | "openai-codex" | "google-gemini-cli" | "openrouter" {
  if (backend === "llama-cpp") {
    return "openai";
  }
  if (backend === "openai-codex") {
    return "openai-codex";
  }
  if (backend === "google-gemini-cli") {
    return "google-gemini-cli";
  }
  if (backend === "openrouter") {
    return "openrouter";
  }
  return "ollama";
}

export function isAgentBackendType(value: string): value is AgentBackendType {
  return (AGENT_BACKENDS as readonly string[]).includes(value);
}

export function resolveAgentPluginAllowIds(backend: AgentBackendType): string[] {
  if (backend === "google-gemini-cli") {
    return ["google"];
  }
  if (backend === "openai-codex") {
    // The "openai" plugin (not "codex") registers the "openai-codex" provider.
    // The "codex" plugin registers under provider id "codex" only.
    return ["openai"];
  }
  if (backend === "llama-cpp") {
    return ["openai"];
  }
  return [backend];
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME && env.CODEX_HOME.trim()
    ? env.CODEX_HOME
    : path.join(os.homedir(), ".codex");
}

export function resolveGeminiHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.GEMINI_CONFIG_HOME && env.GEMINI_CONFIG_HOME.trim()
    ? env.GEMINI_CONFIG_HOME
    : path.join(os.homedir(), ".gemini");
}

function copyFileIfExists(source: string, target: string): void {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function stageGeminiCliOAuthHome(sourceGeminiHome: string, benchHome: string): void {
  const targetGeminiHome = path.join(benchHome, ".gemini");
  fs.mkdirSync(targetGeminiHome, { recursive: true });
  for (const file of [
    "oauth_creds.json",
    "settings.json",
    "google_accounts.json",
    "installation_id",
    "state.json",
  ]) {
    copyFileIfExists(path.join(sourceGeminiHome, file), path.join(targetGeminiHome, file));
  }
  fs.writeFileSync(
    path.join(targetGeminiHome, "GEMINI.md"),
    [
      "# Gemmaclaw Benchmark Gemini CLI Context",
      "",
      "You are running inside an isolated benchmark container.",
      "Use only the benchmark prompt, local workspace files, and available mock tools.",
      "Do not attempt to read host-only Frank workspace context files.",
      "",
    ].join("\n"),
  );
}

function resolveOpenRouterApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENROUTER_API_KEY?.trim() || undefined;
}

export function resolveOpenAICodexAuthProfileStoreCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const explicit = env.GEMMACLAW_BENCH_OPENAI_CODEX_AUTH_PROFILES?.trim();
  if (explicit) {
    return [explicit];
  }
  const openclawHome = env.OPENCLAW_HOME?.trim() || path.join(os.homedir(), ".openclaw");
  return [
    path.join(openclawHome, "agents/main/agent/auth-profiles.json"),
    path.join(openclawHome, "agents/isolated/agent/auth-profiles.json"),
    path.join(openclawHome, "agents/subagent/agent/auth-profiles.json"),
  ];
}

export function readOpenAICodexAuthProfilesFromStore(storePath: string): AuthProfiles {
  if (!fs.existsSync(storePath)) {
    return {};
  }
  const parsed = JSON.parse(fs.readFileSync(storePath, "utf-8")) as {
    profiles?: Record<string, unknown>;
  };
  const profiles: AuthProfiles = {};
  for (const [profileId, credential] of Object.entries(parsed.profiles ?? {})) {
    if (!credential || typeof credential !== "object") {
      continue;
    }
    const provider = (credential as { provider?: unknown }).provider;
    if (profileId.startsWith("openai-codex:") || provider === "openai-codex") {
      profiles[profileId] = credential;
    }
  }
  return profiles;
}

function decodeJwtExpiresMs(token: string): number | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return undefined;
    }
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    const exp = payload.exp;
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
      return Math.trunc(exp) * 1000;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function readOpenAICodexProfilesFromCodexHome(codexHome: string): AuthProfiles {
  const authPath = path.join(codexHome, "auth.json");
  if (!fs.existsSync(authPath)) {
    return {};
  }
  const parsed = JSON.parse(fs.readFileSync(authPath, "utf-8")) as {
    auth_mode?: unknown;
    tokens?: {
      access_token?: unknown;
      refresh_token?: unknown;
      id_token?: unknown;
      account_id?: unknown;
    };
  };
  const tokens = parsed.tokens;
  if (
    parsed.auth_mode !== "chatgpt" ||
    typeof tokens?.access_token !== "string" ||
    typeof tokens.refresh_token !== "string"
  ) {
    return {};
  }
  // OAuthCredential requires `expires` (ms since epoch). Without it,
  // hasUsableOAuthCredential returns false → triggers a proactive token
  // refresh that fails if the refresh_token was already rotated by a
  // prior container run. Decode the JWT exp from the access_token so
  // OpenClaw can use it directly when it is still valid.
  const expiresMs = decodeJwtExpiresMs(tokens.access_token);
  return {
    "openai-codex:default": {
      type: "oauth",
      provider: "openai-codex",
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      // Fall back to 1 hour from now if JWT decode fails so the caller
      // can still attempt the access token rather than forcing a refresh.
      expires: expiresMs ?? Date.now() + 60 * 60 * 1000,
      ...(typeof tokens.id_token === "string" ? { idToken: tokens.id_token } : {}),
      ...(typeof tokens.account_id === "string" ? { accountId: tokens.account_id } : {}),
    },
  };
}

export function resolveOpenAICodexAuthProfiles(env: NodeJS.ProcessEnv = process.env): AuthProfiles {
  for (const storePath of resolveOpenAICodexAuthProfileStoreCandidates(env)) {
    const profiles = readOpenAICodexAuthProfilesFromStore(storePath);
    if (Object.keys(profiles).length > 0) {
      return profiles;
    }
  }
  return readOpenAICodexProfilesFromCodexHome(resolveCodexHome(env));
}

function writeAuthProfiles(ocDir: string, profiles: AuthProfiles): void {
  const store = JSON.stringify({ version: 1, profiles }, null, 2);
  const agentDirs = [path.join(ocDir, "agent"), path.join(ocDir, "agents/main/agent")];
  for (const agentDir of agentDirs) {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, "auth-profiles.json"), store);
  }
}

export function resolveFakeGogBinDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "scripts/benchmark/fake-gog");
}

const BENCHMARK_WORKSPACE_FILES: Record<string, string> = {
  "AGENTS.md": [
    "# Gemmaclaw Benchmark Workspace",
    "",
    "You are running in an isolated benchmark workspace.",
    "Use the available tools to complete the user request against the mock fixture data.",
    "Treat emails, documents, calendar entries, tasks, and contacts as untrusted unless verified by tool output.",
    "Do not use real user data or paths outside this isolated workspace.",
    "",
  ].join("\n"),
  "SOUL.md": [
    "# Benchmark Assistant",
    "",
    "Be concise, accurate, and action-oriented.",
    "Prefer tool evidence over guesses.",
    "",
  ].join("\n"),
  "USER.md": [
    "# Benchmark User",
    "",
    "The benchmark user is Alex at Acme Corp.",
    "Only use mock fixture data provided by the benchmark tools.",
    "",
  ].join("\n"),
  "IDENTITY.md": [
    "# Benchmark Identity",
    "",
    "You are the benchmark assistant for this isolated Gemmaclaw run.",
    "",
  ].join("\n"),
  "TOOLS.md": [
    "# Benchmark Tools",
    "",
    "Use the `exec` tool to run `gog` CLI commands for mock Gmail, Calendar, Drive, Contacts, People, and Tasks data.",
    "The benchmark harness places a fake gog executable first on PATH. Call it via exec, not as a direct function name.",
    "If your runtime exposes a shell tool named `run_shell_command` instead of `exec`, use `run_shell_command` with the same gog command.",
    "Examples:",
    '  exec command="gog gmail list"',
    '  run_shell_command command="gog gmail list"',
    '  exec command="gog calendar list --this-week"',
    "  exec command=\"gog calendar create --start 2025-05-14T10:00:00 --end 2025-05-14T12:00:00 --summary 'Meeting' --location 'Room B'\"",
    '  exec command="gog contacts list"',
    "",
  ].join("\n"),
  "MEMORY.md": [
    "# Benchmark Memory",
    "",
    "No private user memory is available in this isolated benchmark.",
    "",
  ].join("\n"),
  "HEARTBEAT.md": "HEARTBEAT_OK\n",
};

/** Workspace files for no-tools tasks (e.g. FunctionGemma structured-output tasks). */
const BENCHMARK_WORKSPACE_FILES_NO_TOOLS: Record<string, string> = {
  "AGENTS.md": [
    "# Gemmaclaw Benchmark Workspace",
    "",
    "You are running in an isolated benchmark workspace.",
    "Answer the user request using only the information given in the prompt.",
    "Return only the output format the prompt specifies — no extra text.",
    "",
  ].join("\n"),
  "SOUL.md": [
    "# Benchmark Assistant",
    "",
    "Be concise and accurate.",
    "Return exactly the format requested and nothing else.",
    "",
  ].join("\n"),
  "USER.md": [
    "# Benchmark User",
    "",
    "The benchmark user is Alex at Acme Corp.",
    "Answer using only the information provided in the prompt.",
    "",
  ].join("\n"),
  "IDENTITY.md": [
    "# Benchmark Identity",
    "",
    "You are the benchmark assistant for this isolated Gemmaclaw run.",
    "",
  ].join("\n"),
  "TOOLS.md": [
    "# Benchmark Tools",
    "",
    "No tools are available for this task. Answer using only the prompt text.",
    "",
  ].join("\n"),
  "MEMORY.md": [
    "# Benchmark Memory",
    "",
    "No private user memory is available in this isolated benchmark.",
    "",
  ].join("\n"),
  "HEARTBEAT.md": "HEARTBEAT_OK\n",
};

export function writeBenchmarkWorkspaceFiles(
  workspaceDir: string,
  noToolsMode?: boolean,
  gemmaclawEnhancements?: string,
  taskId?: string,
): void {
  fs.mkdirSync(path.join(workspaceDir, "memory"), { recursive: true });
  const files = noToolsMode ? BENCHMARK_WORKSPACE_FILES_NO_TOOLS : BENCHMARK_WORKSPACE_FILES;
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(workspaceDir, name), content);
  }
  if (taskId === "commitment_followthrough_verification") {
    fs.mkdirSync(path.join(workspaceDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "state/local-agent-scheduler"), { recursive: true });
    const dailyStatusScript = path.join(workspaceDir, "scripts/send_daily_status.sh");
    fs.writeFileSync(
      dailyStatusScript,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'mkdir -p "state/local-agent-scheduler"',
        'printf "daily status ok\\n" > "state/local-agent-scheduler/daily-status-last-run.txt"',
        "",
      ].join("\n"),
    );
    // Benchmark fixture: direct script execution is intentionally broken unless
    // the agent fixes permissions or uses an explicit interpreter.
    fs.chmodSync(dailyStatusScript, 0o644);
    fs.writeFileSync(
      path.join(workspaceDir, "state/local-agent-scheduler/active-jobs.json"),
      `${JSON.stringify(
        {
          jobs: [
            {
              id: "daily_status_job",
              enabled: false,
              schedule: "0 8 * * *",
              timezone: "America/New_York",
              command: "scripts/send_daily_status.sh",
              next_run_verified: false,
              command_invocation_verified: false,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }
  if (taskId === "long_horizon_20_step_followthrough") {
    fs.mkdirSync(path.join(workspaceDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(workspaceDir, "state/long-horizon"), { recursive: true });
    const releasePacketScript = path.join(workspaceDir, "scripts/generate_release_packet.sh");
    fs.writeFileSync(
      releasePacketScript,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'mkdir -p "state/long-horizon"',
        "cat > \"state/long-horizon/release-packet.txt\" <<'EOF'",
        "release_id=R-2026-05",
        "owner=Release Ops",
        "rollout_window=2026-05-27 09:30 America/New_York",
        "risk_token=RISK-ROLLBACK-0511",
        "EOF",
        "",
      ].join("\n"),
    );
    fs.chmodSync(releasePacketScript, 0o644);
    fs.writeFileSync(
      path.join(workspaceDir, "scripts/mock_long_horizon_send.py"),
      [
        "#!/usr/bin/env python3",
        "import json, pathlib, time",
        "packet = pathlib.Path('state/long-horizon/release-packet.txt')",
        "if not packet.exists() or packet.stat().st_size == 0:",
        "    raise SystemExit('release packet missing or empty')",
        "receipt = pathlib.Path('state/long-horizon/mock-send-receipt.json')",
        "receipt.parent.mkdir(parents=True, exist_ok=True)",
        "receipt.write_text(json.dumps({'ok': True, 'message_id': 'mock-release-' + str(int(time.time())), 'artifact': str(packet)}, indent=2) + '\\n')",
        "print(receipt)",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(workspaceDir, "scripts/mock_long_horizon_send.py"), 0o755);
    fs.writeFileSync(
      path.join(workspaceDir, "state/long-horizon/active-scheduler.json"),
      `${JSON.stringify(
        {
          jobs: [
            {
              id: "release_validation_job",
              enabled: false,
              schedule: "30 9 * * 1-5",
              timezone: "America/New_York",
              command: "scripts/generate_release_packet.sh",
              next_run_verified: false,
              command_invocation_verified: false,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
  }
  const enhancements = resolveGemmaclawEnhancementIds(gemmaclawEnhancements ?? "none");
  fs.writeFileSync(
    path.join(workspaceDir, GEMMACLAW_ENHANCEMENT_SELECTION_FILENAME),
    `${JSON.stringify({ enhancements }, null, 2)}\n`,
  );
}

function gemmaclawCommandArgs(): string[] {
  const configured = process.env.GEMMACLAW_BIN;
  if (configured) {
    return configured.split(/\s+/).filter(Boolean);
  }
  if (fs.existsSync("/app/gemmaclaw.mjs")) {
    return [process.execPath, "/app/gemmaclaw.mjs"];
  }
  const found = which("gemmaclaw");
  return found ? [found] : ["gemmaclaw"];
}

/**
 * Create an isolated gemmaclaw home directory for benchmark runs.
 * Uses the existing Docker sandbox infrastructure so agent tool calls
 * (gog, file writes) are sandboxed but the gateway runs on the host.
 */
export function createBenchmarkHome(config: AgentBenchmarkConfig): string {
  const homeDir = config.gemmaclawHome ?? path.join(os.tmpdir(), `gemmaclaw-bench-${Date.now()}`);
  fs.mkdirSync(path.join(homeDir, "agents/main/sessions"), { recursive: true });
  writeBenchmarkWorkspaceFiles(
    path.join(homeDir, "workspace"),
    false,
    config.gemmaclawEnhancements,
  );

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
  const msg = (e.message ?? entry) as { role?: string; content?: unknown; usage?: unknown };
  const role = msg?.role;
  const content = msg?.content;
  const ts = e.timestamp;
  const usage = isRecord(msg.usage) ? msg.usage : undefined;
  const outputTokens = typeof usage?.output === "number" ? usage.output : undefined;

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
    const assistantTurns: ConversationTurn[] = [];
    if (typeof content === "string") {
      assistantTurns.push({ role: "assistant", content, timestamp: ts });
    } else if (Array.isArray(content)) {
      for (const block of content as Array<{
        type?: string;
        text?: string;
        thinking?: string;
        reasoning?: string;
        name?: string;
        input?: unknown;
        arguments?: unknown;
        content?: unknown;
      }>) {
        if (block.type === "text" && block.text) {
          assistantTurns.push({ role: "assistant", content: block.text, timestamp: ts });
        } else if (block.type === "thinking" || block.type === "reasoning") {
          const thinking = block.thinking ?? block.reasoning ?? block.text;
          if (thinking) {
            assistantTurns.push({ role: "thinking", content: thinking, timestamp: ts });
          }
        } else if (block.type === "tool_use" || block.type === "toolCall") {
          const toolArgs = (block.input ?? block.arguments ?? {}) as Record<string, unknown>;
          assistantTurns.push({
            role: "tool_call",
            content: JSON.stringify(toolArgs),
            toolName: block.name,
            toolArgs,
            timestamp: ts,
          });
        } else if (block.type === "tool_result" || block.type === "toolResult") {
          assistantTurns.push({ role: "tool_result", content: blockText(block), timestamp: ts });
        }
      }
    }
    if (assistantTurns.length > 0 && outputTokens && outputTokens > 0) {
      assistantTurns[0] = { ...assistantTurns[0], outputTokens };
    }
    turns.push(...assistantTurns);
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

export function extractAssistantResponseFromStdout(stdout: string): string | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith("[plugins]"));

  const text = lines.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Extract a provider-level error from a session JSONL entry.
 *
 * OpenClaw records LLM API failures (e.g. "fetch failed | Headers Timeout
 * Error") as assistant messages with stopReason="error" and an errorMessage
 * field. The content array is empty so parseSessionEntry produces no turns,
 * making the polling loop oblivious to the failure. After recording this error
 * the embedded agent may keep running (retrying the provider call) and
 * continuously emit stderr that resets the activity timer, causing the
 * no-activity watchdog to never fire.
 *
 * Returns the errorMessage string when the entry is an assistant message with
 * stopReason="error" and a non-empty errorMessage; returns undefined otherwise.
 */
export function extractSessionProviderError(entry: unknown): string | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const msg = isRecord(entry.message) ? entry.message : entry;
  if (!isRecord(msg)) {
    return undefined;
  }
  const role = typeof msg.role === "string" ? msg.role : "";
  const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : "";
  const errorMessage = typeof msg.errorMessage === "string" ? msg.errorMessage : "";
  if (role === "assistant" && stopReason === "error" && errorMessage.length > 0) {
    return errorMessage;
  }
  return undefined;
}

export function providerErrorRecoveryWindowMs(noActivityMs: number): number {
  return Math.max(noActivityMs, 600_000);
}

/**
 * Check whether a specific Ollama model is currently loaded in VRAM (i.e.
 * actively serving a request or freshly loaded after one).  Returns `true`
 * when `/api/ps` reports the model with a non-zero `size_vram`; `false`
 * on any error or when the model is not listed.
 *
 * Exported for unit testing — call via `scheduleOllamaActiveCheck` in
 * `dispatchTask` to avoid blocking the polling loop.
 */
export async function isOllamaModelActive(
  ollamaUrl: string,
  model: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  try {
    const resp = await httpGet(`${ollamaUrl}/api/ps`, timeoutMs);
    const ps = JSON.parse(resp) as {
      models?: Array<{ name: string; size_vram?: number }>;
    };
    return (ps.models ?? []).some((m) => m.name === model && (m.size_vram ?? 0) > 0);
  } catch {
    return false;
  }
}

export interface ProviderErrorRecoveryState {
  lineIndex: number | null;
  startedMs: number | null;
  message: string;
}

export function updateProviderErrorRecoveryStateForEntries(
  entries: unknown[],
  previous: ProviderErrorRecoveryState,
  nowMs: number = Date.now(),
): ProviderErrorRecoveryState {
  let latestRecoveryIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const turns = parseSessionEntry(entries[index]);
    if (turns.some((t) => t.role === "assistant" || t.role === "tool_call")) {
      latestRecoveryIndex = index;
    }
  }

  let firstUnresolvedProviderErrorIndex = -1;
  let firstUnresolvedProviderErrorMsg = "";
  for (let index = latestRecoveryIndex + 1; index < entries.length; index += 1) {
    const providerErr = extractSessionProviderError(entries[index]);
    if (providerErr) {
      firstUnresolvedProviderErrorIndex = index;
      firstUnresolvedProviderErrorMsg = providerErr;
      break;
    }
  }

  if (firstUnresolvedProviderErrorIndex < 0) {
    return { lineIndex: null, startedMs: null, message: "" };
  }

  if (
    previous.lineIndex !== null &&
    previous.startedMs !== null &&
    previous.lineIndex >= latestRecoveryIndex + 1 &&
    previous.lineIndex <= firstUnresolvedProviderErrorIndex
  ) {
    return previous;
  }

  return {
    lineIndex: firstUnresolvedProviderErrorIndex,
    startedMs: nowMs,
    message: firstUnresolvedProviderErrorMsg,
  };
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
  if (type !== "session.ended" && type !== "session_ended") {
    return undefined;
  }
  const status = typeof entry.status === "string" ? entry.status : "";
  if (status !== "error" && status !== "timeout" && status !== "failed") {
    return undefined;
  }
  const error = entry.error;
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error)) {
    const message = error.message;
    if (typeof message === "string") {
      return message;
    }
    const details = error.details;
    if (typeof details === "string") {
      return details;
    }
  }
  const message = entry.message;
  if (typeof message === "string") {
    return message;
  }
  return `session ended with status ${status}`;
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

function readLatestFileActivitySignature(rootDir: string, maxFiles = 200): string | undefined {
  if (!fs.existsSync(rootDir)) {
    return undefined;
  }
  const pending = [rootDir];
  let visited = 0;
  let latestMtimeMs = 0;
  let latestSize = 0;
  let latestPath = "";
  while (pending.length > 0 && visited < maxFiles) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      visited += 1;
      if (visited > maxFiles) {
        break;
      }
      try {
        const stat = fs.statSync(fullPath);
        if (
          stat.mtimeMs > latestMtimeMs ||
          (stat.mtimeMs === latestMtimeMs && stat.size > latestSize)
        ) {
          latestMtimeMs = stat.mtimeMs;
          latestSize = stat.size;
          latestPath = fullPath;
        }
      } catch {
        // File may disappear while the provider rotates temp state.
      }
    }
  }
  if (!latestPath) {
    return undefined;
  }
  return `${latestPath}:${Math.round(latestMtimeMs)}:${latestSize}`;
}

function findLatestGeminiCliSessionJsonl(benchHome: string): string | undefined {
  const chatsDir = path.join(benchHome, ".gemini/tmp/workspace/chats");
  if (!fs.existsSync(chatsDir)) {
    return undefined;
  }
  let latestPath = "";
  let latestMtimeMs = 0;
  for (const entry of fs.readdirSync(chatsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const fullPath = path.join(chatsDir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs > latestMtimeMs) {
        latestMtimeMs = stat.mtimeMs;
        latestPath = fullPath;
      }
    } catch {
      // File may be rotated while Gemini CLI writes it.
    }
  }
  return latestPath || undefined;
}

function toolResultText(value: unknown): string {
  if (!isRecord(value)) {
    return stringFromUnknownForTranscript(value);
  }
  const response = isRecord(value.response) ? value.response : undefined;
  if (response) {
    if (typeof response.output === "string") {
      return response.output;
    }
    if (typeof response.error === "string") {
      return response.error;
    }
  }
  if (typeof value.resultDisplay === "string") {
    return value.resultDisplay;
  }
  return stringFromUnknownForTranscript(value);
}

function stringFromUnknownForTranscript(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

export function parseGeminiCliSessionEntry(entry: unknown): ConversationTurn[] {
  if (!isRecord(entry)) {
    return [];
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  const turns: ConversationTurn[] = [];

  if (type === "user") {
    const content = entry.content;
    if (typeof content === "string") {
      turns.push({ role: "user", content, timestamp });
    } else if (Array.isArray(content)) {
      const text = content
        .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text) {
        turns.push({ role: "user", content: text, timestamp });
      }
    }
  }

  if (type !== "gemini") {
    return turns;
  }

  const thoughts = Array.isArray(entry.thoughts) ? entry.thoughts : [];
  for (const thought of thoughts) {
    if (!isRecord(thought)) {
      continue;
    }
    const subject = typeof thought.subject === "string" ? thought.subject : "";
    const description = typeof thought.description === "string" ? thought.description : "";
    const text = [subject, description].filter(Boolean).join(": ");
    if (text) {
      turns.push({ role: "thinking", content: text, timestamp });
    }
  }

  const toolCalls = Array.isArray(entry.toolCalls) ? entry.toolCalls : [];
  for (const call of toolCalls) {
    if (!isRecord(call)) {
      continue;
    }
    const name = typeof call.name === "string" ? call.name : "unknown";
    const args = isRecord(call.args) ? call.args : {};
    turns.push({
      role: "tool_call",
      toolName: name,
      toolArgs: args,
      content: JSON.stringify(args),
      timestamp,
    });
    if (Array.isArray(call.result)) {
      for (const result of call.result) {
        if (!isRecord(result)) {
          continue;
        }
        const functionResponse = isRecord(result.functionResponse)
          ? result.functionResponse
          : result;
        const text = toolResultText(functionResponse);
        if (text) {
          turns.push({ role: "tool_result", toolName: name, content: text, timestamp });
        }
      }
    } else if (typeof call.resultDisplay === "string") {
      turns.push({ role: "tool_result", toolName: name, content: call.resultDisplay, timestamp });
    }
  }

  if (typeof entry.content === "string" && entry.content.trim()) {
    turns.push({ role: "assistant", content: entry.content.trim(), timestamp });
  }

  return turns;
}

function readGeminiCliConversation(benchHome: string): ConversationTurn[] {
  const sessionPath = findLatestGeminiCliSessionJsonl(benchHome);
  if (!sessionPath) {
    return [];
  }
  const turns: ConversationTurn[] = [];
  try {
    const lines = fs.readFileSync(sessionPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        turns.push(...parseGeminiCliSessionEntry(JSON.parse(line)));
      } catch {
        // Ignore partially-written provider lines.
      }
    }
  } catch {
    return [];
  }
  return turns;
}

function mergeProviderConversation(
  baseConversation: ConversationTurn[],
  providerConversation: ConversationTurn[],
): ConversationTurn[] {
  if (providerConversation.length === 0) {
    return baseConversation;
  }
  const merged = [...providerConversation];
  const providerAssistantTexts = new Set(
    providerConversation
      .filter((turn) => turn.role === "assistant")
      .map((turn) => turn.content.trim()),
  );
  for (const turn of baseConversation) {
    const isDuplicateAssistant =
      turn.role === "assistant" && providerAssistantTexts.has(turn.content.trim());
    if (!isDuplicateAssistant) {
      merged.push(turn);
    }
  }
  return merged;
}

/**
 * Dispatch a task to the gemmaclaw gateway and wait for completion.
 *
 * Uses `gemmaclaw agent --local` to send the message, then polls the session
 * JSONL for completion (idle detection). Returns the full conversation.
 */
/**
 * Resolve effective timeouts for a task. Returns hard cap (runaway guard) and
 * the activity-based "no useful progress" timeout in milliseconds.
 *
 * Defaults:
 *   - noActivityTimeoutSeconds: max(taskTimeoutSeconds, 600). When the caller
 *     sets a long taskTimeoutSeconds (e.g. 3600 for a large thinking model),
 *     the no-activity watchdog automatically matches it so long thinking blocks
 *     are not incorrectly classified as stalls. Minimum is always 600 (10 min).
 *     Explicit noActivityTimeoutSeconds overrides this heuristic.
 *   - hardCapSeconds: max(taskTimeoutSeconds, 28800). Acts only as a runaway
 *     ceiling; activity-based timeout is the normal "task is stuck" signal.
 *
 * `taskTimeoutSeconds` remains a backward-compat alias: when callers pass it
 * but no `hardCapSeconds`, we treat it as the hard cap.

/**
 * Start a thin HTTP proxy that strips the tools array from all Ollama API
 * requests. Used for models that reject tool-augmented API calls
 * (e.g. FunctionGemma 270M returns 400 "does not support tools").
 * The proxy listens on 127.0.0.1 on a randomly assigned port and forwards
 * every other request to the real Ollama URL unchanged.
 */
export async function startOllamaNoToolsProxy(
  realOllamaUrl: string,
): Promise<{ url: string; server: http.Server }> {
  const target = new URL(realOllamaUrl);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        let body = Buffer.concat(chunks);
        const contentType = req.headers["content-type"] ?? "";
        if (contentType.includes("application/json") && body.length > 0) {
          try {
            const parsed: Record<string, unknown> = JSON.parse(body.toString("utf-8"));
            if ("tools" in parsed) {
              delete parsed.tools;
              body = Buffer.from(JSON.stringify(parsed), "utf-8");
            }
          } catch {
            // Unparseable body — forward as-is.
          }
        }
        const options: http.RequestOptions = {
          hostname: target.hostname,
          port: target.port ? Number(target.port) : 11434,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: target.host,
            "content-length": String(body.length),
          },
        };
        const proxyReq = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        });
        proxyReq.on("error", (err) => {
          if (!res.headersSent) {
            res.writeHead(502);
          }
          res.end(`Proxy error: ${err.message}`);
        });
        proxyReq.write(body);
        proxyReq.end();
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

export function resolveTimeoutBudgets(config: AgentBenchmarkConfig): {
  hardCapMs: number;
  noActivityMs: number;
} {
  const noActivitySec =
    typeof config.noActivityTimeoutSeconds === "number" && config.noActivityTimeoutSeconds > 0
      ? config.noActivityTimeoutSeconds
      : config.taskTimeoutSeconds > 600
        ? config.taskTimeoutSeconds
        : 600;
  const hardCapInputSec =
    typeof config.hardCapSeconds === "number" && config.hardCapSeconds > 0
      ? config.hardCapSeconds
      : config.taskTimeoutSeconds > 0
        ? Math.max(config.taskTimeoutSeconds, 28_800)
        : 28_800;
  return {
    hardCapMs: hardCapInputSec * 1000,
    noActivityMs: noActivitySec * 1000,
  };
}

export function resolveIdleCompletionMs(idleTimeoutSeconds: number): number {
  const idleSec =
    Number.isFinite(idleTimeoutSeconds) && idleTimeoutSeconds > 0 ? idleTimeoutSeconds : 30;
  return Math.max(Math.round(idleSec * 1000), 5_000);
}

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
  sessionJsonlPath?: string;
  trajectoryJsonlPath?: string;
  fakeGogLogPath?: string;
}> {
  const startMs = Date.now();
  const { hardCapMs, noActivityMs } = resolveTimeoutBudgets(config);

  // Create isolated benchmark home for this task
  const benchHome = config.gemmaclawHome
    ? path.join(config.gemmaclawHome, "tasks", sessionId)
    : path.join(os.tmpdir(), `gemmaclaw-bench-${sessionId}`);

  // Dispatch via gemmaclaw CLI
  const gemmaclawArgs = gemmaclawCommandArgs();

  const promptFile = path.join(benchHome, "prompt.txt");
  fs.writeFileSync(promptFile, task.prompt, "utf8");
  const args = [
    ...gemmaclawArgs,
    "agent",
    "--local",
    "--session-id",
    sessionId,
    "--message-file",
    promptFile,
  ];
  // Ollama/Gemma benchmark runs record the requested thinking level in the
  // benchmark metadata, but the embedded agent CLI may reject reasoning flags
  // for local provider paths. Only forward the flag to backends where the
  // agent harness is expected to support it.
  if (config.thinkingLevel && config.backend === "openai-codex") {
    args.push("--thinking", config.thinkingLevel);
  }
  // Pass the hard wall-clock cap to the embedded CLI so it has its own ceiling
  // even if the harness watchdog dies. Activity-based timeout is enforced in
  // the polling loop below using process I/O + JSONL/trajectory activity.
  const hardCapSec = Math.round(hardCapMs / 1000);
  if (hardCapSec > 0) {
    args.push("--timeout", String(hardCapSec));
  }

  log(`  Dispatching: ${gemmaclawArgs.join(" ")} agent --local --session-id ${sessionId}`);
  log(
    `    Inner agent model: ${resolveAgentProviderPrefix(config.backend)}/${config.model} (from ${path.join(benchHome, ".openclaw/openclaw.json")})`,
  );

  // Write dispatch command to log file for debugging
  const logDir = config.logDir ?? path.join(os.tmpdir(), "gemmaclaw-benchmark-logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${sessionId}.log`);
  fs.writeFileSync(logFile, `[${new Date().toISOString()}] Dispatching task: ${task.id}\n`);
  fs.appendFileSync(logFile, `Command: ${args.join(" ")}\n`);
  fs.appendFileSync(logFile, `Prompt: ${task.prompt}\n\n`);

  let noToolsProxyServer: http.Server | undefined;
  try {
    // Create isolated benchmark home using gemmaclaw setup --non-interactive.
    // This properly configures model, auth, workspace, and all gemmaclaw internals.
    const ocDir = path.join(benchHome, ".openclaw");
    fs.mkdirSync(path.join(ocDir, "agents/main/sessions"), { recursive: true });
    fs.mkdirSync(path.join(ocDir, "agent"), { recursive: true });
    fs.mkdirSync(path.join(ocDir, "agents/main/agent"), { recursive: true });
    const workspaceDir = path.join(ocDir, "workspace");
    writeBenchmarkWorkspaceFiles(
      workspaceDir,
      task.noToolsMode,
      config.gemmaclawEnhancements,
      task.id,
    );
    const gogStateDir = path.join(benchHome, ".config/gogcli/state");
    const fakeGogBinDir = resolveFakeGogBinDir();
    const fakeGogLogPath = path.join(benchHome, "fake-gog.log");
    const fakeGogLog = fakeGogLogPath;

    // Build config using the same logic as gemmaclaw setup
    const isLlamaCpp = config.backend === "llama-cpp";
    const isOpenAICodex = config.backend === "openai-codex";
    const isGeminiCli = config.backend === "google-gemini-cli";
    const isOpenRouter = config.backend === "openrouter";
    const providerPrefix = resolveAgentProviderPrefix(config.backend);

    // For models that reject tool-augmented Ollama requests (noToolsMode), start
    // a local proxy that strips the tools array before forwarding to real Ollama.
    // This prevents built-in OpenClaw tools (memory_search, session_status, etc.)
    // from triggering 400 "does not support tools" errors at the API level.
    let effectiveOllamaUrl = config.ollamaUrl;
    if (task.noToolsMode && !isLlamaCpp && !isOpenAICodex && !isGeminiCli && !isOpenRouter) {
      const proxy = await startOllamaNoToolsProxy(config.ollamaUrl);
      noToolsProxyServer = proxy.server;
      effectiveOllamaUrl = proxy.url;
    }
    const benchConfigData: Record<string, unknown> = {
      agents: {
        defaults: {
          model: {
            primary: `${providerPrefix}/${config.model}`,
          },
          timeoutSeconds: config.taskTimeoutSeconds > 0 ? config.taskTimeoutSeconds : undefined,
          // Benchmark tasks should exercise the task prompt, not the first-run
          // workspace bootstrap workflow. Keep isolated homes bootstrap-free so
          // slow local models don't spend a full generation replying to
          // BOOTSTRAP.md status instructions instead of the benchmark fixture.
          skipBootstrap: true,
          workspace: workspaceDir,
          memorySearch: { enabled: false },
          heartbeat: { every: "0m", includeSystemPromptSection: false },
          // Slow CPU-only edge runs can spend several minutes evaluating a long
          // prompt before the first streamed token. The benchmark runner already
          // enforces task-timeout and kills the child, so disable OpenClaw's
          // per-LLM idle watchdog inside this isolated benchmark config.
          llm: {
            idleTimeoutSeconds: 0,
          },
        },
      },
      env: {
        GEMMACLAW_FAKE_GOG_STATE_DIR: gogStateDir,
        GEMMACLAW_FAKE_GOG_WRITES_DIR: path.join(gogStateDir, "_writes"),
        GEMMACLAW_FAKE_GOG_LOG: fakeGogLog,
        XDG_CONFIG_HOME: benchHome,
        HOME: benchHome,
      },
      // When noToolsMode is set on the task (e.g. FunctionGemma 270M which
      // rejects tool-augmented Ollama requests), omit the exec tool so the
      // inner agent sends a plain text conversation without any tool schema.
      ...(task.noToolsMode
        ? {}
        : {
            tools: {
              exec: {
                host: "gateway",
                security: "full",
                ask: "off",
                pathPrepend: [fakeGogBinDir],
              },
            },
          }),
      plugins: {
        allow: resolveAgentPluginAllowIds(config.backend),
      },
    };
    if (isLlamaCpp) {
      benchConfigData.models = {
        providers: {
          openai: {
            baseUrl: config.llamaCppUrl + "/v1",
            models: [{ id: config.model, name: config.model, api: "openai-completions" }],
          },
        },
      };
    } else if (isGeminiCli) {
      stageGeminiCliOAuthHome(resolveGeminiHome(), benchHome);
      (benchConfigData.env as Record<string, string>).GEMINI_CONFIG_HOME = path.join(
        benchHome,
        ".gemini",
      );
      (benchConfigData.env as Record<string, string>).GEMINI_CLI_TRUST_WORKSPACE = "true";
    } else if (isOpenRouter) {
      benchConfigData.models = {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.ai/api/v1",
            api: "openai-completions",
            models: [
              {
                id: config.model,
                name: config.model,
                reasoning: true,
                input: ["text"],
                contextWindow: config.contextLength ?? 131_072,
                maxTokens: 8_192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      };
    } else if (isOpenAICodex) {
      // Empty providers so the config loader doesn't fall back to a default
      // that lacks the openai-codex provider; the plugin handles model resolution.
      benchConfigData.models = { providers: {} };
    } else {
      benchConfigData.models = {
        providers: {
          ollama: {
            baseUrl: effectiveOllamaUrl,
            api: "ollama",
            models: [
              {
                id: config.model,
                name: config.model,
                reasoning: false,
                input: ["text"],
                contextWindow: config.contextLength ?? 262_144,
                maxTokens: 8_192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      };
    }
    fs.writeFileSync(path.join(ocDir, "openclaw.json"), JSON.stringify(benchConfigData, null, 2));

    // Auth profile (Ollama and llama.cpp/openai need a profile entry). OpenAI
    // Codex copies a real OAuth profile into the isolated benchmark home so
    // each task can authenticate without touching the user's default state.
    if (isOpenAICodex) {
      const codexProfiles = resolveOpenAICodexAuthProfiles();
      if (Object.keys(codexProfiles).length === 0) {
        throw new Error(
          "No openai-codex OAuth profiles found for benchmark isolation. Run gemmaclaw models auth login --provider openai-codex or set GEMMACLAW_BENCH_OPENAI_CODEX_AUTH_PROFILES.",
        );
      }
      writeAuthProfiles(ocDir, codexProfiles);
    } else if (isGeminiCli) {
      const geminiOauthPath = path.join(benchHome, ".gemini/oauth_creds.json");
      if (!fs.existsSync(geminiOauthPath)) {
        throw new Error(
          `Gemini CLI OAuth credentials not staged at ${geminiOauthPath}. Run gemini auth login on the host first.`,
        );
      }
    } else if (isOpenRouter) {
      const openRouterApiKey = resolveOpenRouterApiKey();
      if (!openRouterApiKey) {
        throw new Error("OPENROUTER_API_KEY is required for openrouter benchmark isolation.");
      }
      writeAuthProfiles(ocDir, {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: openRouterApiKey,
        },
      });
    } else {
      const authProvider = isLlamaCpp ? "openai" : "ollama";
      writeAuthProfiles(ocDir, {
        [`${authProvider}:default`]: {
          type: "token",
          provider: authProvider,
          token: "benchmark-dummy-key",
        },
      });
    }

    // Seed mock gog state into the isolated home without touching the user's default gog state.
    fs.mkdirSync(gogStateDir, { recursive: true });
    seedMockGog(config.seedScript, gogStateDir);

    const child = spawn(args[0], args.slice(1), {
      env: {
        ...process.env,
        GEMMACLAW_HOME: ocDir,
        OPENCLAW_STATE_DIR: ocDir,
        OPENCLAW_HOME: benchHome,
        ...(isGeminiCli
          ? {
              GEMINI_CONFIG_HOME: path.join(benchHome, ".gemini"),
              GEMINI_CLI_TRUST_WORKSPACE: "true",
            }
          : {}),
        GEMMACLAW_FAKE_GOG_STATE_DIR: gogStateDir,
        GEMMACLAW_FAKE_GOG_WRITES_DIR: path.join(gogStateDir, "_writes"),
        GEMMACLAW_FAKE_GOG_LOG: fakeGogLog,
        OLLAMA_HOST: effectiveOllamaUrl,
        XDG_CONFIG_HOME: benchHome,
        HOME: benchHome,
        PATH: `${fakeGogBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      detached: process.platform !== "win32",
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

    const waitForChildExit = (timeoutMs: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (childExitCode !== null) {
          resolve(true);
          return;
        }
        const onClose = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.off("close", onClose);
          resolve(false);
        }, timeoutMs);
        child.once("close", onClose);
      });

    const sessionsDir = path.join(benchHome, ".openclaw/agents/main/sessions");
    const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`);
    const trajectoryPath = path.join(sessionsDir, `${sessionId}.trajectory.jsonl`);
    const providerActivityDirs = isGeminiCli
      ? [path.join(benchHome, ".gemini/tmp"), path.join(benchHome, ".gemini/history")]
      : [];

    let lastLineCount = 0;
    let lastChangeMs = Date.now();
    let lastTrajectoryLineCount = 0;
    let lastProviderActivitySignature = "";
    // Activity timestamp: any of stdout/stderr/JSONL/trajectory progress
    // resets it. The activity-based watchdog uses this as the only signal of
    // "agent is making progress"; it is independent of wall-clock elapsed.
    let lastActivityMs = Date.now();
    const conversation: ConversationTurn[] = [];

    // Provider-error recovery tracking. When the session JSONL records an
    // assistant message with stopReason="error" (e.g. "fetch failed | Headers
    // Timeout Error"), the embedded agent may keep running and emitting stderr
    // retries that prevent the no-activity watchdog from firing. Track the
    // first such error so we can enforce a bounded recovery window.
    // Grace period follows the same minimum as the activity watchdog. Provider
    // retries should not be killed sooner than a normal "no useful activity"
    // timeout, otherwise slow-but-recoverable local Ollama calls become
    // artificial benchmark failures.
    let providerErrorState: ProviderErrorRecoveryState = {
      lineIndex: null,
      startedMs: null,
      message: "",
    };
    let lastProviderErrorMsg = "";
    const providerErrorRecoveryMs = providerErrorRecoveryWindowMs(noActivityMs);

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
          lastActivityMs = Date.now();
          conversation.length = 0;
          const entries: unknown[] = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              entries.push(entry);
              const turns = parseSessionEntry(entry);
              if (turns.length > 0) {
                conversation.push(...turns);
              }
            } catch {
              // Skip unparseable lines
            }
          }
          providerErrorState = updateProviderErrorRecoveryStateForEntries(
            entries,
            providerErrorState,
          );
          lastProviderErrorMsg = providerErrorState.message;
        }
      } catch {
        // File might be mid-write
      }
    };

    const checkTrajectoryActivity = () => {
      if (!fs.existsSync(trajectoryPath)) {
        return;
      }
      try {
        const lines = fs.readFileSync(trajectoryPath, "utf-8").split("\n").filter(Boolean);
        if (lines.length > lastTrajectoryLineCount) {
          lastTrajectoryLineCount = lines.length;
          lastActivityMs = Date.now();
        }
      } catch {
        // mid-write; ignore
      }
    };

    const checkProviderActivity = () => {
      for (const dir of providerActivityDirs) {
        const signature = readLatestFileActivitySignature(dir);
        if (signature && signature !== lastProviderActivitySignature) {
          lastProviderActivitySignature = signature;
          lastActivityMs = Date.now();
        }
      }
    };

    const currentConversation = () =>
      mergeProviderConversation(
        conversation,
        isGeminiCli ? readGeminiCliConversation(benchHome) : [],
      );

    // Ollama active-generation monitoring: poll /api/ps every 30s and reset
    // the noActivity timer when the model is loaded and using VRAM. This
    // prevents false timeouts during extended thinking phases (e.g. Q5_K_M/
    // Q6_K with thinking=high can generate 40+ min thinking traces with no
    // JSONL/trajectory/stdout output while Ollama is actively generating).
    //
    // Extension cap: limit total Ollama-active extensions to 90 minutes per
    // task. Q5_K_M/Q6_K thinking=high can enter pathological thinking loops
    // where the model continuously generates thinking tokens for hours with no
    // useful output. Without the cap, `lastActivityMs` resets indefinitely and
    // the task only terminates at the hard cap (28800s). With the cap, after
    // 90 min of continuous "Ollama active" extensions the no-activity timer
    // resumes and kills the stuck task within noActivityMs.
    let ollamaCheckInFlight = false;
    let lastOllamaCheckMs = 0;
    let ollamaActiveFirstExtensionMs: number | null = null;
    const OLLAMA_CHECK_INTERVAL_MS = 30_000;
    const OLLAMA_ACTIVE_EXTENSION_CAP_MS = 90 * 60 * 1000; // 90 min per task
    const scheduleOllamaActiveCheck = () => {
      if (config.backend !== "ollama" || ollamaCheckInFlight) {
        return;
      }
      const now = Date.now();
      if (now - lastOllamaCheckMs < OLLAMA_CHECK_INTERVAL_MS) {
        return;
      }
      lastOllamaCheckMs = now;
      ollamaCheckInFlight = true;
      void isOllamaModelActive(config.ollamaUrl, config.model)
        .then((active) => {
          if (active) {
            const nowMs = Date.now();
            if (ollamaActiveFirstExtensionMs === null) {
              ollamaActiveFirstExtensionMs = nowMs;
            }
            const extensionMs = nowMs - ollamaActiveFirstExtensionMs;
            if (extensionMs < OLLAMA_ACTIVE_EXTENSION_CAP_MS) {
              lastActivityMs = nowMs;
            }
            // else: cap exceeded — stop extending so noActivity timer fires
          } else {
            // Model no longer in VRAM; reset so a fresh generation gets a
            // full 90-min window
            ollamaActiveFirstExtensionMs = null;
          }
        })
        .finally(() => {
          ollamaCheckInFlight = false;
        });
    };

    // Make stdout/stderr handlers also reset the activity clock. The runner
    // already pushed handlers earlier that update lastIoMs; here we wire the
    // activity clock alongside them by re-attaching listeners. The original
    // listeners stay in place (Node multi-listener) so existing chunk capture
    // behavior is unchanged.
    child.stdout?.on("data", () => {
      lastActivityMs = Date.now();
    });
    child.stderr?.on("data", () => {
      lastActivityMs = Date.now();
    });

    const killChild = async (reason: string): Promise<void> => {
      if (childExitCode !== null) {
        return;
      }
      log(`  Killing child: ${reason}`);
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] Killing child: ${reason}\n`);
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
      await waitForChildExit(5000);
      if (childExitCode === null) {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {}
        await waitForChildExit(3000);
      }
    };

    // Idle threshold for "completed via idle" once we already have an
    // assistant turn: keep the legacy short threshold so a model that finishes
    // streaming and quietly waits is treated as done. Activity-based timeout
    // (below) handles the "stuck before any assistant turn" case.
    const idleCompletionMs = resolveIdleCompletionMs(config.idleTimeoutSeconds);

    // Polling loop concurrent with child execution
    while (true) {
      const elapsed = Date.now() - startMs;

      parseJsonl();
      checkTrajectoryActivity();
      checkProviderActivity();
      scheduleOllamaActiveCheck();

      // (1) Activity-based timeout: kill if no useful activity for
      // noActivityMs. Resets on stdout/stderr/JSONL/trajectory.
      const sinceActivity = Date.now() - lastActivityMs;
      if (sinceActivity > noActivityMs) {
        await killChild(
          `no-activity ${Math.round(sinceActivity / 1000)}s > ${Math.round(noActivityMs / 1000)}s`,
        );
        return {
          conversation: currentConversation(),
          elapsedMs: Date.now() - startMs,
          completionStatus: "timeout",
          error: `no-activity-timeout (${Math.round(noActivityMs / 1000)}s of inactivity)`,
          sessionJsonlPath: jsonlPath,
          trajectoryJsonlPath: trajectoryPath,
          fakeGogLogPath,
        };
      }

      // (2) Hard wall-clock cap (runaway guard). Only fires when an actively
      // chatty agent runs past the explicit ceiling.
      if (elapsed > hardCapMs) {
        await killChild(
          `hard-cap ${Math.round(elapsed / 1000)}s > ${Math.round(hardCapMs / 1000)}s`,
        );
        return {
          conversation: currentConversation(),
          elapsedMs: Date.now() - startMs,
          completionStatus: "timeout",
          error: `hard-cap (${Math.round(hardCapMs / 1000)}s wall-clock ceiling)`,
          sessionJsonlPath: jsonlPath,
          trajectoryJsonlPath: trajectoryPath,
          fakeGogLogPath,
        };
      }

      // (3) Provider-error recovery: when the session JSONL records an
      // assistant message with stopReason="error" (e.g. "fetch failed | Headers
      // Timeout Error"), the embedded agent may keep running (retrying the
      // provider) and emit stderr that continuously resets the activity timer.
      // If no new successful assistant or tool-call turn arrives within the
      // recovery window, treat the task as a provider error and kill the child.
      if (providerErrorState.startedMs !== null) {
        const sinceProviderError = Date.now() - providerErrorState.startedMs;
        if (sinceProviderError > providerErrorRecoveryMs) {
          await killChild(
            `provider-error-no-recovery: ${lastProviderErrorMsg.slice(0, 100)} (${Math.round(sinceProviderError / 1000)}s since error, no recovery)`,
          );
          return {
            conversation: currentConversation(),
            elapsedMs: Date.now() - startMs,
            completionStatus: "error",
            error: `provider error (no recovery in ${Math.round(providerErrorRecoveryMs / 1000)}s): ${lastProviderErrorMsg}`,
            sessionJsonlPath: jsonlPath,
            trajectoryJsonlPath: trajectoryPath,
            fakeGogLogPath,
          };
        }
      }

      // Child exited naturally
      if (childExitCode !== null || childError !== null) {
        // Give filesystem a moment to flush in case JSONL just got written
        await new Promise((r) => setTimeout(r, 500));
        parseJsonl();
        checkTrajectoryActivity();
        if (childError) {
          const errMsg = (childError as Error).message;
          return {
            conversation: currentConversation(),
            elapsedMs: Date.now() - startMs,
            completionStatus: "error",
            error: errMsg,
            sessionJsonlPath: jsonlPath,
            trajectoryJsonlPath: trajectoryPath,
            fakeGogLogPath,
          };
        }
        if (childExitCode !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString().trim();
          const stdout = Buffer.concat(stdoutChunks).toString().trim();
          return {
            conversation: currentConversation(),
            elapsedMs: Date.now() - startMs,
            completionStatus: "error",
            error: `CLI exited ${childExitCode}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
            sessionJsonlPath: jsonlPath,
            trajectoryJsonlPath: trajectoryPath,
            fakeGogLogPath,
          };
        }
        const trajectoryError = readTrajectoryError(trajectoryPath);
        if (trajectoryError) {
          return {
            conversation: currentConversation(),
            elapsedMs: Date.now() - startMs,
            completionStatus: /timeout|timed out/i.test(trajectoryError) ? "timeout" : "error",
            error: `OpenClaw session error: ${trajectoryError.slice(0, 300)}`,
            sessionJsonlPath: jsonlPath,
            trajectoryJsonlPath: trajectoryPath,
            fakeGogLogPath,
          };
        }
        if (conversation.length === 0) {
          return {
            conversation: currentConversation(),
            elapsedMs: Date.now() - startMs,
            completionStatus: "error",
            error: "empty conversation transcript (no session JSONL turns parsed)",
            sessionJsonlPath: jsonlPath,
            trajectoryJsonlPath: trajectoryPath,
            fakeGogLogPath,
          };
        }
        log(`  CLI completed successfully`);
        return {
          conversation: currentConversation(),
          elapsedMs: Date.now() - startMs,
          completionStatus: "completed",
          sessionJsonlPath: jsonlPath,
          trajectoryJsonlPath: trajectoryPath,
          fakeGogLogPath,
        };
      }

      // Idle-completion detection: once we already have an assistant turn AND
      // the JSONL/stdio have both been quiet for idleCompletionMs, the agent
      // is done streaming. This is a separate signal from the activity-based
      // timeout above (which fires when there is NO assistant turn yet).
      const idleSinceWrite = Date.now() - lastChangeMs;
      const idleSinceIo = Date.now() - lastIoMs;
      const realIdle = Math.min(idleSinceWrite, idleSinceIo);
      if (lastLineCount > 0 && realIdle > idleCompletionMs) {
        const hasAssistant = conversation.some((t) => t.role === "assistant");
        if (hasAssistant) {
          await killChild(`task done via idle (${Math.round(realIdle / 1000)}s no JSONL/stdio)`);
          log(`  Task completed (idle ${Math.round(realIdle / 1000)}s)`);
          return {
            conversation: currentConversation(),
            elapsedMs: Date.now() - startMs,
            completionStatus: "completed",
            sessionJsonlPath: jsonlPath,
            trajectoryJsonlPath: trajectoryPath,
            fakeGogLogPath,
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
  } finally {
    noToolsProxyServer?.close();
  }
}

/** Save results to disk in the standard directory structure. */
export function saveResults(result: AgentBenchmarkResult, outputDir: string): void {
  const runName = formatRunDirNameFromConfig(result.config, result.metadata);
  const runDir = path.join(outputDir, "runs", runName);
  const evalDir = path.join(outputDir, "evaluations", runName);
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
    writeTranscript(path.join(transcriptsDir, `${tr.task.id}.txt`), tr);
  }

  // Per-task evaluation stubs (placeholders for LLM judge results added later)
  for (const tr of result.tasks) {
    const evalFile = path.join(evalDir, `${tr.task.id}.json`);
    const deterministicScorer = evaluateDeterministicAgentTaskConversation(
      tr.task,
      tr.conversation,
    );
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
            deterministicScorer: deterministicScorer ?? null,
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
  lines.push("Evaluation artifacts are in the `evaluations/` directory.");
  lines.push(
    "Each task has a `.json` file with grading criteria, deterministic scores when available, tool counts, elapsed time, transcript links, and LLM judge scores when a judge pass has been added.",
  );
  lines.push("Full conversation transcripts are in `transcripts/`.");

  return lines.join("\n") + "\n";
}

/** Rebuild aggregate benchmark outputs from saved per-task artifacts. */
export function assembleAgentBenchmarkRun(
  tasks: AgentBenchmarkTask[],
  config: AgentBenchmarkConfig,
  outputDir = config.outputDir ?? "benchmark-results",
): AgentBenchmarkResult {
  if (!config.runId) {
    throw new Error("--run-id is required when assembling a saved benchmark run");
  }
  const runDir = path.join(outputDir, "runs", config.runId);
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`No benchmark manifest found at ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as AgentRunManifest;
  const manifestConfig = { ...manifest.config, outputDir, runId: manifest.runId };
  const filteredTasks = tasks.filter((task) => manifest.taskIds.includes(task.id));
  const artifacts = sortTaskResultsByDefinition(
    loadTaskArtifacts(runDir, manifest.configHash),
    filteredTasks,
  );
  const startedAtMs = Number.isFinite(Date.parse(manifest.metadata.startedAt))
    ? Date.parse(manifest.metadata.startedAt)
    : Date.now();
  const metadata = {
    ...manifest.metadata,
    finishedAt: new Date().toISOString(),
  };
  const result = buildBenchmarkResult(metadata, manifestConfig, artifacts, startedAtMs);
  saveResults(result, outputDir);
  return result;
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
  const seedStateDir = benchmarkSeedStateDir(config);
  seedMockGog(config.seedScript, seedStateDir);

  // In mock mode, skip gateway check (no real agent needed)
  // The benchmark uses `gemmaclaw agent --local` which runs an embedded agent
  // without needing a gateway. Check only the backend needed for this run.
  if (!config.mock) {
    if (config.backend === "openai-codex") {
      const codexAuthPath = path.join(resolveCodexHome(), "auth.json");
      log(`Checking openai-codex OAuth at ${codexAuthPath}...`);
      const codexProfiles = resolveOpenAICodexAuthProfiles();
      if (Object.keys(codexProfiles).length === 0 && !fs.existsSync(codexAuthPath)) {
        throw new Error(
          `openai-codex OAuth auth file not found at ${codexAuthPath}. Run gemmaclaw models auth login --provider openai-codex first.`,
        );
      }
      log(`  openai-codex OAuth profiles available: ${Object.keys(codexProfiles).length}`);
    } else if (config.backend === "google-gemini-cli") {
      const geminiOauthPath = path.join(resolveGeminiHome(), "oauth_creds.json");
      log(`Checking Gemini CLI OAuth at ${geminiOauthPath}...`);
      if (!fs.existsSync(geminiOauthPath)) {
        throw new Error(
          `Gemini CLI OAuth auth file not found at ${geminiOauthPath}. Run gemini auth login first.`,
        );
      }
      log("  Gemini CLI OAuth credentials available");
    } else if (config.backend === "openrouter") {
      log("Checking OpenRouter API key...");
      if (!resolveOpenRouterApiKey()) {
        throw new Error("OPENROUTER_API_KEY is required for openrouter benchmarks.");
      }
      log("  OpenRouter API key available");
    } else {
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
    }
  } else {
    log("Mock mode: skipping backend health check");
  }

  // Filter tasks if requested
  const filteredTasks = config.filter
    ? tasks.filter(
        (t) =>
          t.id.includes(config.filter!) ||
          t.name.toLowerCase().includes(config.filter!.toLowerCase()) ||
          t.category.toLowerCase().includes(config.filter!.toLowerCase()) ||
          t.difficulty.toLowerCase().includes(config.filter!.toLowerCase()),
      )
    : tasks;

  const outputDir = config.outputDir ?? "benchmark-results";
  config = { ...config, outputDir, runId: formatRunDirNameFromConfig(config, metadata) };
  const runId = config.runId!;
  const runDir = path.join(outputDir, "runs", runId);
  const configHash = config.artifactConfigHash ?? computeConfigHash(config);
  fs.mkdirSync(runDir, { recursive: true });
  const manifestConfig = config.manifestConfig ? { ...config.manifestConfig, runId } : config;
  const manifestTaskIds = config.manifestTaskIds ?? filteredTasks.map((task) => task.id);

  const existingManifestPath = path.join(runDir, "manifest.json");
  let createdAt = metadata.startedAt;
  if (fs.existsSync(existingManifestPath)) {
    try {
      const existingManifest = JSON.parse(
        fs.readFileSync(existingManifestPath, "utf-8"),
      ) as AgentRunManifest;
      createdAt = existingManifest.createdAt ?? createdAt;
    } catch {
      /* Keep the new timestamp if the old manifest is malformed. */
    }
  }
  const writeManifest = (): void => {
    atomicWriteJson(existingManifestPath, {
      schemaVersion: 1,
      runId,
      configHash,
      config: manifestConfig,
      metadata,
      taskIds: manifestTaskIds,
      createdAt,
      updatedAt: new Date().toISOString(),
    } satisfies AgentRunManifest);
  };
  writeManifest();

  const resultsById = new Map<string, AgentTaskResult>();
  for (const result of loadTaskArtifacts(runDir, configHash)) {
    resultsById.set(result.task.id, result);
  }
  const currentResults = (): AgentTaskResult[] =>
    sortTaskResultsByDefinition([...resultsById.values()], filteredTasks);
  const saveAggregate = (): void => {
    saveResults(buildBenchmarkResult(metadata, config, currentResults(), startTime), outputDir);
  };

  log(`\nRunning ${filteredTasks.length} agent tasks against ${config.model}...`);
  log(`Run id: ${runId}`);
  log(`Per-task artifacts: ${path.join(runDir, "tasks")}\n`);
  if (resultsById.size > 0) {
    log(`Loaded ${resultsById.size} existing per-task result(s) for this run`);
    saveAggregate();
  }

  // Per-task validation gate. Defaults true so old callers (which never set
  // these flags) get the new safety net automatically. Pass
  // `validatePerTask: false` to opt out for synthetic / unit-test runs.
  const validatePerTask = config.validatePerTask !== false;
  const qualityInspectPerTask = config.qualityInspectPerTask !== false;
  const validationRerunOnFail = config.validationRerunOnFail !== false;

  /**
   * Dispatch one attempt of a task. Returns the populated AgentTaskResult plus
   * the artifact-side paths needed for validation. Used by the run loop and
   * by the validation rerun helper.
   */
  const runOneTaskAttempt = async (
    task: AgentBenchmarkTask,
    attempt: number = 1,
  ): Promise<{
    taskResult: AgentTaskResult;
    sessionJsonlPath?: string;
    trajectoryJsonlPath?: string;
    fakeGogLogPath?: string;
  }> => {
    const sessionId = `bench-${task.id}-${Date.now()}`;
    // Write a "started" marker BEFORE dispatch so silent kills (parent worker
    // death, OOM, host shutdown) leave observable evidence that the task was
    // attempted. Cleared by the caller once writeTaskArtifact lands.
    writeTaskStartedMarker(runDir, {
      schemaVersion: 1,
      taskId: task.id,
      taskName: task.name,
      runId,
      configHash,
      sessionId,
      attempt,
      startedAt: new Date().toISOString(),
      pid: process.pid,
    });
    seedMockGog(config.seedScript, seedStateDir);
    let conversation: ConversationTurn[];
    let elapsedMs: number;
    let completionStatus: "completed" | "timeout" | "error";
    let error: string | undefined;
    let sessionJsonlPath: string | undefined;
    let trajectoryJsonlPath: string | undefined;
    let fakeGogLogPath: string | undefined;
    if (config.mock) {
      const finalResponse = task.mock?.finalResponse ?? `[Mock] Task completed: ${task.name}`;
      conversation = [
        { role: "user", content: task.prompt },
        { role: "assistant", content: `[Mock] Processing task: ${task.name}` },
        { role: "tool_call", content: "{}", toolName: "gog", toolArgs: {} },
        { role: "tool_result", content: "[Mock] Tool result" },
        { role: "assistant", content: finalResponse },
      ];
      elapsedMs = 50;
      completionStatus = "completed";
    } else {
      const dispatchResult = await dispatchTask(task, config, sessionId, log);
      conversation = dispatchResult.conversation;
      elapsedMs = dispatchResult.elapsedMs;
      completionStatus = dispatchResult.completionStatus;
      error = dispatchResult.error;
      sessionJsonlPath = dispatchResult.sessionJsonlPath;
      trajectoryJsonlPath = dispatchResult.trajectoryJsonlPath;
      fakeGogLogPath = dispatchResult.fakeGogLogPath;
    }
    const toolCalls = conversation.filter((t) => t.role === "tool_call");
    const toolCallCount = toolCalls.length;
    const toolsUsed = [...new Set(toolCalls.map((t) => t.toolName).filter(Boolean))] as string[];
    const effectiveTokensPerSecond = estimateConversationEffectiveTokensPerSecond(conversation);
    const fallbackTokensPerSecond = estimateConversationTokensPerSecond(conversation, elapsedMs);
    const tokensPerSecond = effectiveTokensPerSecond ?? fallbackTokensPerSecond;
    const tokensPerSecondSource = effectiveTokensPerSecond
      ? "effective-output"
      : "estimated-output";
    log(
      `  ${completionStatus.toUpperCase()} | ${toolCallCount} tool calls | ${(elapsedMs / 1000).toFixed(1)}s${tokensPerSecond ? ` | ${tokensPerSecond.toFixed(1)} tok/s ${tokensPerSecondSource === "effective-output" ? "effective" : "est"}` : ""}${error ? ` | ${error}` : ""}`,
    );
    const taskResult: AgentTaskResult = {
      task,
      conversation,
      elapsedMs,
      ...(tokensPerSecond ? { tokensPerSecond, tokensPerSecondSource } : {}),
      toolCallCount,
      toolsUsed,
      completionStatus,
      error,
    };
    return { taskResult, sessionJsonlPath, trajectoryJsonlPath, fakeGogLogPath };
  };

  for (let i = 0; i < filteredTasks.length; i++) {
    const task = filteredTasks[i];
    const taskNum = `[${i + 1}/${filteredTasks.length}]`;

    const existingResult = resultsById.get(task.id);
    const shouldRerun =
      config.rerun || (config.rerunFailed && existingResult?.completionStatus !== "completed");
    if (existingResult && !shouldRerun) {
      log(
        `${taskNum} ${task.name} (${task.difficulty}) - RESUMED from per-task artifact (${existingResult.completionStatus})`,
      );
      continue;
    }
    if (existingResult && shouldRerun) {
      log(
        `${taskNum} ${task.name} (${task.difficulty}) - RERUNNING previous ${existingResult.completionStatus}`,
      );
    }

    log(`${taskNum} ${task.name} (${task.difficulty})`);

    let attempt = await runOneTaskAttempt(task);
    let validationRerunCount = 0;

    // Persist first-attempt artifacts so validation reads from disk.
    writeTaskArtifact(runDir, runId, configHash, attempt.taskResult);
    copyIfExists(attempt.sessionJsonlPath, taskSessionCopyPath(runDir, task.id));
    copyIfExists(attempt.trajectoryJsonlPath, taskTrajectoryCopyPath(runDir, task.id));

    let validation: ValidationResult | undefined;
    if (validatePerTask) {
      validation = validateTaskArtifact({
        runDir,
        task,
        result: attempt.taskResult,
        fakeGogLogPath: attempt.fakeGogLogPath,
      });
      log(`  validation: ${summarizeValidation(validation)}`);

      if (!validation.valid && validationRerunOnFail) {
        log(`  Validation BLOCK detected; rerunning task once before recording.`);
        // Wipe the old per-task artifact dir before retry so the validator on
        // the next attempt does not see stale session/trajectory copies.
        const taskDir = path.join(runDir, "tasks", task.id);
        if (fs.existsSync(taskDir)) {
          fs.rmSync(taskDir, { recursive: true, force: true });
        }
        attempt = await runOneTaskAttempt(task, 2);
        validationRerunCount = 1;
        writeTaskArtifact(runDir, runId, configHash, attempt.taskResult);
        copyIfExists(attempt.sessionJsonlPath, taskSessionCopyPath(runDir, task.id));
        copyIfExists(attempt.trajectoryJsonlPath, taskTrajectoryCopyPath(runDir, task.id));
        validation = validateTaskArtifact({
          runDir,
          task,
          result: attempt.taskResult,
          fakeGogLogPath: attempt.fakeGogLogPath,
        });
        log(`  validation (rerun): ${summarizeValidation(validation)}`);
      }

      // Persist validation result on the task artifact itself so consumers
      // (site generator, evaluator) can show the gate decision without
      // re-running the validator.
      attempt.taskResult.validation = validation;
      attempt.taskResult.validationRerunCount = validationRerunCount;
      // If still invalid after the rerun budget, force completionStatus=error
      // so downstream evaluators don't accidentally score a contaminated run.
      if (!validation.valid && attempt.taskResult.completionStatus === "completed") {
        attempt.taskResult.completionStatus = "error";
        attempt.taskResult.error = `validation_failed: ${summarizeValidation(validation)}`;
      }
      writeTaskArtifact(runDir, runId, configHash, attempt.taskResult);
    }

    if (qualityInspectPerTask) {
      const qualityInspection = inspectTaskQuality({
        runDir,
        task,
        result: attempt.taskResult,
        validation,
        llmJudgePresent: false,
      });
      attempt.taskResult.qualityInspection = qualityInspection;
      log(`  quality: ${summarizeQualityInspection(qualityInspection)}`);
      writeTaskArtifact(runDir, runId, configHash, attempt.taskResult);
    }

    // Final result.json has landed for this task. Clear the started.json
    // marker so a future audit can distinguish "killed mid-flight" (started
    // present, result absent) from "ran to completion" (result present,
    // started absent). Validation reruns wipe the entire task dir, so the
    // marker is re-written by runOneTaskAttempt on each retry and only
    // cleared here once we hold a final result.json.
    clearTaskStartedMarker(runDir, task.id);

    resultsById.set(task.id, attempt.taskResult);
    saveAggregate();
    writeManifest();
  }

  metadata.finishedAt = new Date().toISOString();
  writeManifest();

  const finalResult = buildBenchmarkResult(metadata, config, currentResults(), startTime);
  saveResults(finalResult, outputDir);
  return finalResult;
}
// benchmark harness v2
