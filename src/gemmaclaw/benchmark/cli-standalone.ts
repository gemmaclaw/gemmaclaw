#!/usr/bin/env node
/**
 * Standalone benchmark CLI runner.
 * Allows running benchmarks directly via `pnpm benchmark` without building the full project.
 *
 * Usage:
 *   pnpm benchmark                          # Docker (default prompt-response)
 *   pnpm benchmark --local                  # Direct host execution
 *   pnpm benchmark --mock                   # Deterministic mock mode
 *   pnpm benchmark --model gemma3:4b        # Specify model
 *   pnpm benchmark --filter coding          # Run only coding tasks
 *   pnpm benchmark --context-length 8192    # Set context window
 *   pnpm benchmark sandbox --file tasks.json   # Sandbox with custom file
 *
 * Agent mode (E2E agentic benchmarks):
 *   pnpm benchmark agent                    # Run all 24 agentic tasks
 *   pnpm benchmark agent --model gemma4:31b # Specific model
 *   pnpm benchmark agent --filter email     # Filter by task id/name
 *   pnpm benchmark agent --mock             # Mock mode (no real model)
 *   pnpm benchmark agent --thinking xhigh   # Set thinking level
 *   pnpm benchmark agent --gateway-url http://remote:3001  # Remote gateway
 *   pnpm benchmark agent --task email_triage  # Run single task by id
 *   pnpm benchmark agent --quant Q4_K_M     # Record quantization level
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { benchmarkGemmaCommand, benchmarkSandboxCommand } from "../../commands/benchmark-gemma.js";
import { defaultRuntime } from "../../runtime.js";
import { detectHardware } from "../provision/hardware.js";
import {
  AGENT_BENCHMARK_DOCKER_IMAGE,
  assertSingleAgentBenchmarkTaskInContainer,
  defaultAgentBenchmarkRunId,
  isInsideAgentBenchmarkContainer,
  findBenchmarkRepoRoot,
  preparePerTaskContainerArgs,
  selectAgentBenchmarkTaskIds,
} from "./agent-container-guard.js";
import { evaluateAgentBenchmarkRun, type AgentJudgeProvider } from "./agent-evaluator.js";
import {
  assembleAgentBenchmarkRun,
  autoSelectModel,
  computeConfigHash,
  isAgentBackendType,
  runAgentBenchmark,
  type AgentBenchmarkConfig,
} from "./agent-runner.js";
import { AGENT_BENCHMARK_TASKS } from "./agent-tasks.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const opts: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--mock") {
      opts.mock = true;
    } else if (arg === "--local") {
      opts.local = true;
    } else if (arg === "--keep") {
      opts.keep = true;
    } else if (arg === "--model" && args[i + 1]) {
      opts.model = args[++i]!;
    } else if (arg === "--ollama-url" && args[i + 1]) {
      opts.ollamaUrl = args[++i]!;
    } else if (arg === "--gateway-url" && args[i + 1]) {
      opts.gatewayUrl = args[++i]!;
    } else if (arg === "--filter" && args[i + 1]) {
      opts.filter = args[++i]!;
    } else if (arg === "--task" && args[i + 1]) {
      opts.task = args[++i]!;
    } else if (arg === "--output-dir" && args[i + 1]) {
      opts.outputDir = args[++i]!;
    } else if (arg === "--gemmaclaw-home" && args[i + 1]) {
      opts.gemmaclawHome = args[++i]!;
    } else if (arg === "--run-id" && args[i + 1]) {
      opts.runId = args[++i]!;
    } else if (arg === "--rerun") {
      opts.rerun = true;
    } else if (arg === "--rerun-failed") {
      opts.rerunFailed = true;
    } else if (arg === "--assemble") {
      opts.assemble = true;
    } else if (arg === "--evaluate") {
      opts.evaluate = true;
    } else if (arg === "--force-evaluate") {
      opts.forceEvaluate = true;
    } else if (arg === "--include-raw-judge-response") {
      opts.includeRawJudgeResponse = true;
    } else if (arg === "--judge-provider" && args[i + 1]) {
      opts.judgeProvider = args[++i]!;
    } else if (arg === "--context-length" && args[i + 1]) {
      opts.contextLength = args[++i]!;
    } else if (arg === "--gpu-layers" && args[i + 1]) {
      opts.gpuLayers = args[++i]!;
    } else if (arg === "--batch-size" && args[i + 1]) {
      opts.batchSize = args[++i]!;
    } else if (arg === "--thinking" && args[i + 1]) {
      opts.thinking = args[++i]!;
    } else if (arg === "--quant" && args[i + 1]) {
      opts.quant = args[++i]!;
    } else if (arg === "--task-timeout" && args[i + 1]) {
      opts.taskTimeout = args[++i]!;
    } else if (arg === "--idle-timeout" && args[i + 1]) {
      opts.idleTimeout = args[++i]!;
    } else if (arg === "--no-activity-timeout" && args[i + 1]) {
      opts.noActivityTimeout = args[++i]!;
    } else if (arg === "--hard-cap" && args[i + 1]) {
      opts.hardCap = args[++i]!;
    } else if (arg === "--validate-per-task") {
      opts.validatePerTask = true;
    } else if (arg === "--no-validate-per-task") {
      opts.validatePerTask = false;
    } else if (arg === "--validation-rerun-on-fail") {
      opts.validationRerunOnFail = true;
    } else if (arg === "--no-validation-rerun-on-fail") {
      opts.validationRerunOnFail = false;
    } else if (arg === "--backend" && args[i + 1]) {
      opts.backend = args[++i]!;
    } else if (arg === "--llama-cpp-url" && args[i + 1]) {
      opts.llamaCppUrl = args[++i]!;
    } else if (arg === "--judge-model" && args[i + 1]) {
      opts.judgeModel = args[++i]!;
    } else if (arg === "--file" && args[i + 1]) {
      opts.file = args[++i]!;
    } else if (arg === "--gemini-api-key" && args[i + 1]) {
      opts.geminiApiKey = args[++i]!;
    } else if (arg === "--gemini-model" && args[i + 1]) {
      opts.geminiModel = args[++i]!;
    } else if (arg === "sandbox") {
      opts.sandbox = true;
    } else if (arg === "agent") {
      opts.agent = true;
    } else if (arg === "list") {
      opts.list = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function buildAgentBenchmarkConfig(
  opts: Record<string, string | boolean>,
  outputDir: string,
): AgentBenchmarkConfig {
  const hardware = detectHardware();
  const autoSelected = autoSelectModel(hardware);
  const backendInput = (opts.backend as string | undefined) ?? autoSelected.backend;
  if (!isAgentBackendType(backendInput)) {
    throw new Error(`Unsupported agent benchmark backend: ${backendInput}`);
  }
  const backend = backendInput;
  const model = (opts.model as string) ?? autoSelected.model;

  return {
    gatewayUrl: (opts.gatewayUrl as string) ?? "http://localhost:3001",
    backend,
    ollamaUrl: (opts.ollamaUrl as string) ?? "http://127.0.0.1:11434",
    llamaCppUrl: (opts.llamaCppUrl as string) ?? "http://127.0.0.1:8080",
    model,
    quant: opts.quant as string | undefined,
    thinkingLevel: opts.thinking as string | undefined,
    taskTimeoutSeconds: opts.taskTimeout ? Number.parseInt(String(opts.taskTimeout), 10) : 600,
    idleTimeoutSeconds: opts.idleTimeout ? Number.parseInt(String(opts.idleTimeout), 10) : 30,
    noActivityTimeoutSeconds: opts.noActivityTimeout
      ? Number.parseInt(String(opts.noActivityTimeout), 10)
      : undefined,
    hardCapSeconds: opts.hardCap ? Number.parseInt(String(opts.hardCap), 10) : undefined,
    validatePerTask: opts.validatePerTask !== false,
    validationRerunOnFail: opts.validationRerunOnFail !== false,
    filter: (opts.task as string) ?? (opts.filter as string) ?? undefined,
    mock: Boolean(opts.mock),
    contextLength: opts.contextLength ? Number.parseInt(String(opts.contextLength), 10) : undefined,
    gemmaclawHome: opts.gemmaclawHome as string | undefined,
    outputDir,
    runId: opts.runId as string | undefined,
    rerun: Boolean(opts.rerun),
    rerunFailed: Boolean(opts.rerunFailed),
  };
}

function parseJsonEnv(name: string): unknown {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${name}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function existingRunArtifactConfigHash(outputDir: string, runId: string): string | undefined {
  const tasksDir = path.join(outputDir, "runs", runId, "tasks");
  if (!fs.existsSync(tasksDir)) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const taskId of fs.readdirSync(tasksDir)) {
    const artifactPath = path.join(tasksDir, taskId, "result.json");
    if (!fs.existsSync(artifactPath)) {
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(artifactPath, "utf-8")) as { configHash?: string };
      if (data.configHash) {
        counts.set(data.configHash, (counts.get(data.configHash) ?? 0) + 1);
      }
    } catch {
      /* Ignore malformed partial artifacts. */
    }
  }
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0];
}

function restoreHostOutputOwnership(hostOutputDir: string): void {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return;
  }
  const gid = process.getgid?.() ?? uid;
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${hostOutputDir}:/results`,
      "--entrypoint",
      "chown",
      AGENT_BENCHMARK_DOCKER_IMAGE,
      "-R",
      `${uid}:${gid}`,
      "/results",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.warn(
      `Warning: failed to restore host ownership for ${hostOutputDir}; host-side assembly may need manual chown.`,
    );
  }
}

async function runAgentModeInDocker(opts: Record<string, string | boolean>): Promise<void> {
  const repoRoot = findBenchmarkRepoRoot();
  const hostOutputDir = path.resolve((opts.outputDir as string | undefined) ?? "benchmark-results");
  const containerOutputDir = "/results";
  const selectedTaskIds = selectAgentBenchmarkTaskIds(AGENT_BENCHMARK_TASKS, opts);
  const runId = defaultAgentBenchmarkRunId(opts);
  const manifestConfig = { ...buildAgentBenchmarkConfig(opts, hostOutputDir), runId };
  const artifactConfigHash =
    existingRunArtifactConfigHash(hostOutputDir, runId) ?? computeConfigHash(manifestConfig);

  console.log("========================================");
  console.log("  Gemmaclaw Agent Benchmark Containers");
  console.log("========================================\n");
  console.log(
    "Agent benchmarks are container-only. Building benchmark image once, then running one fresh container per task.",
  );
  console.log(`Image:  ${AGENT_BENCHMARK_DOCKER_IMAGE}`);
  console.log(`Output: ${hostOutputDir}`);
  console.log(`Run id: ${runId}`);
  console.log(`Artifact config hash: ${artifactConfigHash}`);
  console.log(`Tasks:  ${selectedTaskIds.length}`);
  console.log("");

  execSync(`docker build -f Dockerfile.benchmark -t ${AGENT_BENCHMARK_DOCKER_IMAGE} .`, {
    cwd: repoRoot,
    stdio: "inherit",
    timeout: 900_000,
  });

  for (let index = 0; index < selectedTaskIds.length; index++) {
    const taskId = selectedTaskIds[index];
    const forwardedArgs = preparePerTaskContainerArgs(process.argv.slice(2), {
      taskId,
      runId,
      outputDir: containerOutputDir,
    });
    const dockerArgs = [
      "run",
      "--rm",
      "--add-host=host.docker.internal:host-gateway",
      "-e",
      "GEMMACLAW_BENCHMARK_CONTAINER=1",
      "-e",
      `GEMMACLAW_BENCHMARK_ARTIFACT_CONFIG_HASH=${artifactConfigHash}`,
      "-e",
      `GEMMACLAW_BENCHMARK_MANIFEST_TASK_IDS=${JSON.stringify(selectedTaskIds)}`,
      "-e",
      `GEMMACLAW_BENCHMARK_MANIFEST_CONFIG=${JSON.stringify(manifestConfig)}`,
      "-e",
      `GEMMACLAW_BENCHMARK_HOST_UID=${process.getuid?.() ?? 0}`,
      "-e",
      `GEMMACLAW_BENCHMARK_HOST_GID=${process.getgid?.() ?? 0}`,
      "-v",
      `${hostOutputDir}:${containerOutputDir}`,
      AGENT_BENCHMARK_DOCKER_IMAGE,
      ...forwardedArgs,
    ];

    console.log(`\n[container ${index + 1}/${selectedTaskIds.length}] ${taskId}`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", dockerArgs, { cwd: repoRoot, stdio: "inherit" });
      child.on("error", reject);
      child.on("close", (code) => {
        restoreHostOutputOwnership(hostOutputDir);
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `containerized agent benchmark task ${taskId} failed with exit code ${code ?? 1}`,
            ),
          );
        }
      });
    });
  }

  console.log("\nAssembling aggregate results on host-mounted artifacts...");
  assembleAgentBenchmarkRun(
    AGENT_BENCHMARK_TASKS,
    {
      gatewayUrl: "containerized-per-task",
      backend: "ollama",
      ollamaUrl: "host-mounted-results",
      llamaCppUrl: "host-mounted-results",
      model: String(opts.model ?? "auto"),
      quant: opts.quant as string | undefined,
      thinkingLevel: opts.thinking as string | undefined,
      taskTimeoutSeconds: opts.taskTimeout ? Number.parseInt(String(opts.taskTimeout), 10) : 600,
      idleTimeoutSeconds: opts.idleTimeout ? Number.parseInt(String(opts.idleTimeout), 10) : 30,
      noActivityTimeoutSeconds: opts.noActivityTimeout
        ? Number.parseInt(String(opts.noActivityTimeout), 10)
        : undefined,
      hardCapSeconds: opts.hardCap ? Number.parseInt(String(opts.hardCap), 10) : undefined,
      validatePerTask: opts.validatePerTask !== false,
      validationRerunOnFail: opts.validationRerunOnFail !== false,
      filter: opts.task ? String(opts.task) : (opts.filter as string | undefined),
      mock: false,
      contextLength: opts.contextLength
        ? Number.parseInt(String(opts.contextLength), 10)
        : undefined,
      outputDir: hostOutputDir,
      runId,
      rerun: Boolean(opts.rerun),
      rerunFailed: Boolean(opts.rerunFailed),
    },
    hostOutputDir,
  );
}

function printHelp(): void {
  console.log(`Usage: pnpm benchmark [command] [options]

Commands:
  (default)            Run prompt-response benchmarks (original mode)
  agent                Run E2E agentic benchmarks, one fresh Docker container per real task
  agent list           List all available agent benchmark tasks
  sandbox              Run benchmark in a persistent Docker container

Agent Mode Options:
  --model <name>         Model to test (default: gemma3:4b)
  --quant <level>        Quantization level to record (e.g. Q4_K_M, Q8_0, FP16)
  --backend <type>       Backend to test (ollama, llama-cpp, openai-codex)
  --thinking <level>     Thinking/reasoning level (off, low, medium, high, xhigh)
  --gateway-url <url>    Gemmaclaw gateway URL (default: http://localhost:3001)
  --ollama-url <url>     Ollama API URL (default: http://127.0.0.1:11434)
  --filter <text>        Run only tasks matching text (id, name, category, difficulty)
  --task <id>            Run a single task by exact id
  --output-dir <dir>     Host-mounted output directory for results/evals (default: benchmark-results)
  --gemmaclaw-home <dir> Isolated OpenClaw/gog state base for agent runs
  --run-id <id>          Stable run id for resume/rerun (default: model + timestamp)
  --rerun                Force rerun of selected tasks into the same run id
  --rerun-failed         Rerun only selected tasks whose saved result failed or timed out
  --assemble             Rebuild aggregate results from saved per-task artifacts
  --evaluate             Run LLM judge scoring for a saved run id
  --force-evaluate       Replace existing LLM judge scores for that run
  --judge-provider <id>  Judge provider (openai)
  --task-timeout <sec>   Legacy alias for --hard-cap (default: 600). Activity-based timeout is the normal "stuck" signal.
  --idle-timeout <sec>   Seconds of idle before task considered done (default: 30)
  --no-activity-timeout <sec>  Kill the task if no useful agent activity (stdout/stderr/JSONL/trajectory) for N seconds (default: 600)
  --hard-cap <sec>       Hard wall-clock ceiling per task as a runaway guard (default: 28800 = 8h)
  --validate-per-task    Run the per-task validation gate after each task (default: on). Use --no-validate-per-task to opt out.
  --validation-rerun-on-fail  Rerun a task once if validation produces a block-severity issue (default: on)
  --judge-model <name>   Model for LLM judge (default: same as test model)
  --mock                 Mock mode: no real model, deterministic pass/fail
  --context-length <n>   Ollama context window size

Prompt-Response Mode Options:
  --mock                 Run deterministic scoring only (fast, no LLM judge)
  --local                Run directly on the host instead of inside Docker
  --model <name>         Ollama model name (default: from config or gemma3:4b)
  --ollama-url <url>     Ollama API URL (default: http://127.0.0.1:11434)
  --filter <text>        Run only tasks matching text (id, category, difficulty)
  --output-dir <dir>     Output directory for results
  --context-length <n>   Context window size
  --gpu-layers <n>       Number of GPU layers
  --batch-size <n>       Batch size

Sandbox Options:
  --file <path>          Path to the file to include in the container (required)
  --keep                 Keep container running after benchmark finishes

Examples:
  pnpm benchmark agent                              # Run all agentic tasks, one Docker container per task
  pnpm benchmark agent --model gemma4:31b --quant Q4_K_M --thinking high
  pnpm benchmark agent --backend openai-codex --model gpt-5.5 --thinking xhigh
  pnpm benchmark agent --run-id q6k-v1               # Resume an interrupted run
  pnpm benchmark agent --run-id q6k-v1 --task email_triage --rerun
  pnpm benchmark agent --run-id q6k-v1 --rerun-failed
  pnpm benchmark agent --run-id q6k-v1 --assemble    # Rebuild RESULTS.md/results.json
  pnpm benchmark agent --run-id q6k-v1 --evaluate --judge-model gpt-5.5
  pnpm benchmark agent --filter security             # Run only security tasks
  pnpm benchmark agent --gateway-url http://192.168.1.50:3001  # Remote gateway
  pnpm benchmark agent list                          # List all tasks
  pnpm benchmark agent --mock                        # Smoke test without a model

  -h, --help             Show this help
`);
}

function listAgentTasks(): void {
  console.log("\nAvailable Agent Benchmark Tasks:\n");
  console.log(
    `${"ID".padEnd(30)} ${"Difficulty".padEnd(12)} ${"Pts".padStart(4)} ${"Category".padEnd(18)} Name`,
  );
  console.log("-".repeat(100));

  let totalPoints = 0;
  for (const task of AGENT_BENCHMARK_TASKS) {
    console.log(
      `${task.id.padEnd(30)} ${task.difficulty.padEnd(12)} ${String(task.grading.maxScore).padStart(4)} ${task.category.padEnd(18)} ${task.name}`,
    );
    totalPoints += task.grading.maxScore;
  }

  console.log("-".repeat(100));
  console.log(`${AGENT_BENCHMARK_TASKS.length} tasks, ${totalPoints} max points\n`);
}

async function runAgentMode(opts: Record<string, string | boolean>): Promise<void> {
  if (opts.list) {
    listAgentTasks();
    return;
  }

  if (opts.evaluate) {
    const runId = opts.runId as string | undefined;
    if (!runId) {
      throw new Error("--run-id is required with --evaluate");
    }
    const judgeProviderInput = (opts.judgeProvider as string | undefined) ?? "openai";
    if (judgeProviderInput !== "openai") {
      throw new Error(`Unsupported judge provider: ${judgeProviderInput}`);
    }
    const provider: AgentJudgeProvider = judgeProviderInput;
    const model = (opts.judgeModel as string | undefined) ?? "gpt-5.5";
    const outputDir = (opts.outputDir as string) ?? "benchmark-results";
    await evaluateAgentBenchmarkRun({
      outputDir,
      runId,
      provider,
      model,
      force: Boolean(opts.forceEvaluate),
      includeRaw: Boolean(opts.includeRawJudgeResponse),
    });
    return;
  }

  if (!opts.mock && !opts.assemble && !isInsideAgentBenchmarkContainer()) {
    await runAgentModeInDocker(opts);
    return;
  }

  if (!opts.mock && !opts.assemble && isInsideAgentBenchmarkContainer()) {
    assertSingleAgentBenchmarkTaskInContainer({
      taskIds: selectAgentBenchmarkTaskIds(AGENT_BENCHMARK_TASKS, opts),
    });
  }

  const hardware = detectHardware();
  const config = buildAgentBenchmarkConfig(opts, (opts.outputDir as string) ?? "benchmark-results");
  config.artifactConfigHash = process.env.GEMMACLAW_BENCHMARK_ARTIFACT_CONFIG_HASH;
  config.manifestTaskIds = parseJsonEnv("GEMMACLAW_BENCHMARK_MANIFEST_TASK_IDS") as
    | string[]
    | undefined;
  config.manifestConfig = parseJsonEnv("GEMMACLAW_BENCHMARK_MANIFEST_CONFIG") as
    | AgentBenchmarkConfig
    | undefined;

  const outputDir = config.outputDir ?? "benchmark-results";
  config.logDir = path.join(outputDir, ".logs");

  console.log("========================================");
  console.log("  Gemmaclaw Agent Benchmark");
  console.log("========================================\n");
  console.log(`Model:    ${config.model}${config.quant ? ` (${config.quant})` : ""}`);
  console.log(`Backend:  ${config.backend}`);
  console.log(`Thinking: ${config.thinkingLevel ?? "default"}`);
  console.log(`Gateway:  ${config.gatewayUrl}`);
  if (config.backend === "openai-codex") {
    console.log(`Codex:    OAuth app-server`);
  } else if (config.backend === "llama-cpp") {
    console.log(`llama.cpp: ${config.llamaCppUrl}`);
  } else {
    console.log(`Ollama:   ${config.ollamaUrl}`);
  }
  console.log(`GPU:      ${hardware.gpu.name ?? "not detected"}`);
  console.log(`Output:   ${outputDir}`);
  if (config.mock) {
    console.log(`Mode:     MOCK (no real model)`);
  }
  if (config.filter) {
    console.log(`Filter:   ${config.filter}`);
  }
  if (config.runId) {
    console.log(`Run id:   ${config.runId}`);
  }
  if (config.rerun) {
    console.log(`Resume:   rerun selected tasks`);
  } else if (config.rerunFailed) {
    console.log(`Resume:   rerun failed or timed-out tasks`);
  } else {
    console.log(`Resume:   reuse matching per-task artifacts`);
  }
  console.log("");

  const result = opts.assemble
    ? assembleAgentBenchmarkRun(AGENT_BENCHMARK_TASKS, config, outputDir)
    : await runAgentBenchmark(AGENT_BENCHMARK_TASKS, config, hardware);

  // Print summary
  console.log("\n========================================");
  console.log("  Run Summary");
  console.log("========================================\n");
  console.log(`Tasks:      ${result.summary.totalTasks}`);
  console.log(`Completed:  ${result.summary.completedCount}`);
  console.log(`Errors:     ${result.summary.errorCount}`);
  console.log(`Timeouts:   ${result.summary.timeoutCount}`);
  console.log(
    `Tool calls: ${result.summary.totalToolCalls} total (${result.summary.avgToolCallsPerTask} avg/task)`,
  );
  console.log(`Total time: ${(result.summary.totalTimeMs / 1000).toFixed(1)}s`);
  console.log("");
  console.log("Results are ready for PR. LLM evaluation is a separate step.");
  console.log("");
}

// ── Main dispatch ───────────────────────────────────────────────────────────

const opts = parseArgs(process.argv);

if (opts.agent) {
  runAgentMode(opts).catch((err) => {
    console.error("Agent benchmark failed:", err);
    process.exit(1);
  });
} else if (opts.sandbox) {
  if (!opts.file) {
    console.error("Error: --file is required for sandbox mode");
    process.exit(1);
  }
  benchmarkSandboxCommand(
    {
      file: opts.file as string,
      model: opts.model as string | undefined,
      mock: Boolean(opts.mock),
      keep: Boolean(opts.keep),
      geminiApiKey: opts.geminiApiKey as string | undefined,
      geminiModel: opts.geminiModel as string | undefined,
    },
    defaultRuntime,
  ).catch((err) => {
    console.error("Benchmark sandbox failed:", err);
    process.exit(1);
  });
} else {
  benchmarkGemmaCommand(
    {
      mock: Boolean(opts.mock),
      local: Boolean(opts.local),
      model: opts.model as string | undefined,
      ollamaUrl: opts.ollamaUrl as string | undefined,
      filter: opts.filter as string | undefined,
      outputDir: opts.outputDir as string | undefined,
      contextLength: opts.contextLength
        ? Number.parseInt(String(opts.contextLength), 10)
        : undefined,
      gpuLayers: opts.gpuLayers ? Number.parseInt(String(opts.gpuLayers), 10) : undefined,
      batchSize: opts.batchSize ? Number.parseInt(String(opts.batchSize), 10) : undefined,
      geminiApiKey: opts.geminiApiKey as string | undefined,
      geminiModel: opts.geminiModel as string | undefined,
    },
    defaultRuntime,
  ).catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
  });
}
