import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BackendType } from "../gemmaclaw/benchmark/runner.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type BenchmarkGemmaCommandOpts = {
  mock?: boolean;
  model?: string;
  backend?: string;
  ollamaUrl?: string;
  llamaCppUrl?: string;
  gguf?: string;
  filter?: string;
  outputDir?: string;
  contextLength?: number;
  gpuLayers?: number;
  batchSize?: number;
  pack?: string;
  runner?: string;
  listPack?: boolean;
  validatePack?: boolean;
  /** Skip Docker and run the benchmark directly on the host. */
  local?: boolean;
  /** Gemini API key for cloud-based evaluation (uses Gemini instead of local Ollama). */
  geminiApiKey?: string;
  /** Gemini model to use (e.g. gemini-2.5-flash). Only applies when geminiApiKey is set. */
  geminiModel?: string;
};

export type BenchmarkSandboxOpts = {
  file: string;
  model?: string;
  mock?: boolean;
  /** Keep container running after the benchmark finishes (for inspection). */
  keep?: boolean;
  /** Gemini API key for cloud-based evaluation (uses Gemini instead of local Ollama). */
  geminiApiKey?: string;
  /** Gemini model to use (e.g. gemini-2.5-pro). Only applies when geminiApiKey is set. */
  geminiModel?: string;
};

const DOCKER_IMAGE = "gemmaclaw-benchmark";

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function findRepoRoot(): string {
  let dir = path.dirname(new URL(import.meta.url).pathname);
  while (dir !== "/") {
    if (fs.existsSync(path.join(dir, "Dockerfile.benchmark"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function dockerBuild(repoRoot: string, runtime: RuntimeEnv): boolean {
  runtime.log("Building Docker image (this may take a while on first run)...");
  try {
    execSync(`docker build -f Dockerfile.benchmark -t ${DOCKER_IMAGE} .`, {
      cwd: repoRoot,
      stdio: "inherit",
      timeout: 600_000,
    });
    return true;
  } catch {
    return false;
  }
}

function runInDocker(opts: BenchmarkGemmaCommandOpts, runtime: RuntimeEnv): Promise<number> {
  const repoRoot = findRepoRoot();

  if (!dockerBuild(repoRoot, runtime)) {
    runtime.error("Docker build failed. Run with --local to skip Docker.");
    return Promise.resolve(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const model = opts.model ?? "gemma3:1b";
  const hostResultsDir =
    opts.outputDir ??
    path.join(process.cwd(), "results", `${model.replace(/[/:]/g, "-")}__${timestamp}`);

  fs.mkdirSync(hostResultsDir, { recursive: true });

  const args: string[] = ["run", "--rm"];

  args.push("-v", `${hostResultsDir}:/results`);

  if (opts.model) {
    args.push("-e", `BENCHMARK_MODEL=${opts.model}`);
  }

  args.push(DOCKER_IMAGE);

  if (opts.mock) {
    args.push("--mock");
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.filter) {
    args.push("--filter", opts.filter);
  }
  if (opts.contextLength != null) {
    args.push("--context-length", String(opts.contextLength));
  }
  if (opts.gpuLayers != null) {
    args.push("--gpu-layers", String(opts.gpuLayers));
  }
  if (opts.batchSize != null) {
    args.push("--batch-size", String(opts.batchSize));
  }

  return new Promise<number>((resolve) => {
    runtime.log("");
    runtime.log("========================================");
    runtime.log("  Running benchmark in Docker");
    runtime.log("========================================");
    runtime.log(`  Results will be written to: ${hostResultsDir}`);
    runtime.log("");

    const child = spawn("docker", args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (err) => {
      runtime.error(`Docker process error: ${err.message}`);
      resolve(1);
    });
  });
}

// ---------------------------------------------------------------------------
// Local (direct) benchmark run
// ---------------------------------------------------------------------------

async function runLocally(opts: BenchmarkGemmaCommandOpts, runtime: RuntimeEnv): Promise<void> {
  const packHandled = await handlePackCommands(opts, runtime);
  if (packHandled) {
    return;
  }

  const { detectHardware, formatHardwareInfo } = await import("../gemmaclaw/provision/hardware.js");
  const { BENCHMARK_TASKS, runBenchmark, writeResults, getMaxPossibleScore } =
    await import("../gemmaclaw/benchmark/index.js");
  const { findPreset } = await import("../gemmaclaw/provision/model-registry.js");

  const geminiApiKey = opts.geminiApiKey ?? process.env.GEMINI_API_KEY;
  const geminiModel = opts.geminiModel ?? process.env.GEMINI_MODEL;

  const backend: BackendType = geminiApiKey
    ? "gemini"
    : ((opts.backend === "llama-cpp" ? "llama-cpp" : "ollama") as BackendType);

  const model = opts.model ?? resolveConfiguredModel() ?? "gemma3:4b";
  const ollamaUrl = opts.ollamaUrl ?? "http://127.0.0.1:11434";
  const llamaCppUrl = opts.llamaCppUrl ?? "http://127.0.0.1:8080";
  const isMock = Boolean(opts.mock);

  const preset = findPreset(model);
  const contextLength = opts.contextLength ?? preset?.defaultContextLength;

  runtime.log("");
  runtime.log("========================================");
  runtime.log(`  Gemmaclaw Benchmark${isMock ? " (deterministic)" : ""}`);
  runtime.log("========================================");
  runtime.log("");

  runtime.log("Detecting hardware...");
  const hw = detectHardware();
  for (const line of formatHardwareInfo(hw)) {
    runtime.log(line);
  }
  runtime.log("");

  let tasks = [...BENCHMARK_TASKS];
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    tasks = tasks.filter(
      (t) =>
        t.id.toLowerCase().includes(f) ||
        t.category.toLowerCase().includes(f) ||
        t.difficulty.toLowerCase().includes(f) ||
        t.name.toLowerCase().includes(f),
    );
  }

  if (tasks.length === 0) {
    runtime.error(`No tasks match filter "${opts.filter}"`);
    runtime.exit(1);
    return;
  }

  runtime.log(`Backend: ${backend}`);
  if (backend === "gemini") {
    runtime.log(`Gemini model: ${geminiModel ?? "gemini-2.5-pro"}`);
  }
  runtime.log(`Model: ${model}`);
  if (preset) {
    runtime.log(`Preset: ${preset.displayName} (${preset.architecture}, ${preset.parameterCount})`);
  }
  if (backend === "ollama") {
    runtime.log(`Ollama: ${ollamaUrl}`);
  } else {
    runtime.log(`llama-server: ${llamaCppUrl}`);
    if (opts.gguf) {
      runtime.log(`GGUF: ${opts.gguf}`);
    }
  }
  runtime.log(`Tasks: ${tasks.length} (max ${getMaxPossibleScore()} points)`);
  runtime.log(`Mode: ${isMock ? "deterministic (mock)" : "full (LLM judge)"}`);
  if (contextLength) {
    runtime.log(`Context length: ${contextLength}`);
  }
  if (opts.gpuLayers != null) {
    runtime.log(`GPU layers: ${opts.gpuLayers}`);
  }
  if (opts.batchSize) {
    runtime.log(`Batch size: ${opts.batchSize}`);
  }
  runtime.log("");

  if (!isMock && backend !== "gemini") {
    if (backend === "ollama") {
      try {
        await ollamaPing(ollamaUrl, model);
        runtime.log("Ollama connection verified.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        runtime.error(`Cannot reach Ollama at ${ollamaUrl}: ${msg}`);
        runtime.error("Make sure Ollama is running with the model loaded.");
        runtime.error("  ollama serve");
        runtime.error(`  ollama pull ${model}`);
        runtime.exit(1);
        return;
      }
    } else {
      try {
        await llamaCppPing(llamaCppUrl);
        runtime.log("llama-server connection verified.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        runtime.error(`Cannot reach llama-server at ${llamaCppUrl}: ${msg}`);
        runtime.error("Make sure llama-server is running:");
        runtime.error(`  llama-server --model <gguf-path> --port 8080 --host 127.0.0.1 -ngl 99`);
        runtime.exit(1);
        return;
      }
    }
  }

  const result = await runBenchmark(
    tasks,
    {
      backend,
      ollamaUrl,
      llamaCppUrl,
      model,
      ggufPath: opts.gguf,
      mock: isMock,
      filter: opts.filter,
      contextLength,
      gpuLayers: opts.gpuLayers,
      batchSize: opts.batchSize,
      geminiApiKey,
      geminiModel,
    },
    hw,
    (msg) => runtime.log(msg),
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backendSuffix = backend === "llama-cpp" ? "__llamacpp" : "__ollama";
  const defaultDir = path.join(
    process.cwd(),
    "benchmark-results",
    `${safePathSegment(model)}${backendSuffix}__${timestamp}`,
  );
  const outputDir = opts.outputDir ?? defaultDir;
  const files = writeResults(result, outputDir);

  const s = result.summary;
  runtime.log("");
  runtime.log("========================================");
  runtime.log("  RESULTS");
  runtime.log("========================================");
  runtime.log(`  Backend: ${backend}`);
  runtime.log(`  Score: ${s.totalScore} / ${s.maxScore} (${s.percentage}%)`);
  runtime.log(`  Pass rate: ${s.passRate}% (${s.passedCount}/${s.passedCount + s.failedCount})`);
  runtime.log(`  Time: ${(s.totalTimeMs / 1000).toFixed(1)}s`);
  if (s.avgTokensPerSecond != null) {
    runtime.log(`  Avg tok/s: ${s.avgTokensPerSecond}`);
  }
  if (s.medianTokensPerSecond != null) {
    runtime.log(`  Median tok/s: ${s.medianTokensPerSecond}`);
  }
  if (s.p50LatencyMs != null) {
    runtime.log(`  p50 latency: ${(s.p50LatencyMs / 1000).toFixed(1)}s`);
  }
  if (s.p95LatencyMs != null) {
    runtime.log(`  p95 latency: ${(s.p95LatencyMs / 1000).toFixed(1)}s`);
  }
  if (s.totalPromptTokens > 0) {
    runtime.log(`  Prompt tokens: ${s.totalPromptTokens}`);
  }
  if (s.totalCompletionTokens > 0) {
    runtime.log(`  Completion tokens: ${s.totalCompletionTokens}`);
  }
  const errorModes = Object.entries(s.failureModes).filter(([k]) => k !== "none");
  if (errorModes.length > 0) {
    runtime.log(`  Failures: ${errorModes.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  runtime.log("");
  runtime.log(`  JSON: ${files.json}`);
  runtime.log(`  Markdown: ${files.markdown}`);
  runtime.log(`  Dashboard: ${files.html}`);
  runtime.log("========================================");
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function benchmarkGemmaCommand(
  opts: BenchmarkGemmaCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const hasPack = opts.pack || opts.runner || opts.listPack || opts.validatePack;
  if (opts.local || hasPack) {
    await runLocally(opts, runtime);
    return;
  }

  if (!isDockerAvailable()) {
    runtime.log("Docker is not available. Falling back to local execution.");
    runtime.log("Install Docker or use --local to suppress this message.");
    runtime.log("");
    await runLocally(opts, runtime);
    return;
  }

  const exitCode = await runInDocker(opts, runtime);
  if (exitCode !== 0) {
    runtime.exit(exitCode);
  }
}

// ---------------------------------------------------------------------------
// Sandbox: include a file, get back a container ID
// ---------------------------------------------------------------------------

export async function benchmarkSandboxCommand(
  opts: BenchmarkSandboxOpts,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const filePath = path.resolve(opts.file);

  if (!fs.existsSync(filePath)) {
    runtime.error(`File not found: ${filePath}`);
    runtime.exit(1);
    return;
  }

  if (!isDockerAvailable()) {
    runtime.error("Docker is required for benchmark sandbox. Install Docker and try again.");
    runtime.exit(1);
    return;
  }

  const repoRoot = findRepoRoot();

  if (!dockerBuild(repoRoot, runtime)) {
    runtime.error("Docker build failed.");
    runtime.exit(1);
    return;
  }

  const model = opts.model ?? "gemma3:1b";
  const fileName = path.basename(filePath);
  const containerFile = `/workspace/${fileName}`;

  const createArgs: string[] = [
    "create",
    "-e",
    `BENCHMARK_MODEL=${model}`,
    "-e",
    `BENCHMARK_FILE=${containerFile}`,
    "-e",
    "BENCHMARK_SANDBOX=1",
  ];

  if (opts.mock) {
    createArgs.push("-e", "BENCHMARK_MOCK=1");
  }

  if (opts.keep) {
    createArgs.push("-e", "BENCHMARK_KEEP=1");
  }

  if (opts.geminiApiKey) {
    createArgs.push("-e", `GEMINI_API_KEY=${opts.geminiApiKey}`);
  }

  if (opts.geminiModel) {
    createArgs.push("-e", `GEMINI_MODEL=${opts.geminiModel}`);
  }

  createArgs.push(DOCKER_IMAGE);

  runtime.log("");
  runtime.log("========================================");
  runtime.log("  Benchmark Sandbox");
  runtime.log("========================================");
  runtime.log(`  File: ${filePath}`);
  runtime.log(`  Model: ${model}`);
  if (opts.geminiApiKey) {
    runtime.log(`  Gemini: ${opts.geminiModel ?? "gemini-2.5-pro"} (API key provided)`);
  }
  runtime.log("");

  let containerId: string;
  try {
    containerId = execSync(`docker ${createArgs.join(" ")}`, {
      cwd: repoRoot,
      timeout: 30_000,
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    runtime.error(
      `Failed to create container: ${err instanceof Error ? err.message : String(err)}`,
    );
    runtime.exit(1);
    return;
  }

  const shortId = containerId.slice(0, 12);

  try {
    execSync(`docker cp "${filePath}" ${containerId}:${containerFile}`, {
      timeout: 30_000,
    });
  } catch (err) {
    runtime.error(
      `Failed to copy file into container: ${err instanceof Error ? err.message : String(err)}`,
    );
    execSync(`docker rm ${containerId}`, { stdio: "pipe" }).toString();
    runtime.exit(1);
    return;
  }

  runtime.log(`  Container: ${shortId}`);
  runtime.log(`  File mounted at: ${containerFile}`);
  runtime.log("");
  runtime.log("Starting container...");

  const child = spawn("docker", ["start", "-a", containerId], { stdio: "inherit" });

  await new Promise<void>((resolve) => {
    child.on("close", (code) => {
      runtime.log("");
      runtime.log("========================================");
      runtime.log("  Sandbox Complete");
      runtime.log("========================================");
      runtime.log(`  Container ID: ${shortId}`);
      runtime.log("");
      runtime.log("  Modify and rerun:");
      runtime.log(`    docker cp <new-file> ${shortId}:${containerFile}`);
      runtime.log(`    docker start -a ${shortId}`);
      runtime.log("");
      runtime.log("  Inspect the container:");
      runtime.log(`    docker exec -it ${shortId} bash`);
      runtime.log("");
      runtime.log("  Read results:");
      runtime.log(`    docker cp ${shortId}:/results ./results`);
      runtime.log("");
      runtime.log("  Clean up:");
      runtime.log(`    docker rm ${shortId}`);
      runtime.log("========================================");

      if (code !== 0 && code !== null) {
        runtime.exit(code);
      }
      resolve();
    });
    child.on("error", (err) => {
      runtime.error(`Container error: ${err.message}`);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfiguredModel(): string | undefined {
  const configPaths = [
    path.join(process.env.HOME ?? "", ".openclaw", "openclaw.json"),
    path.join(process.cwd(), "openclaw.json"),
  ];

  for (const cp of configPaths) {
    try {
      const raw = fs.readFileSync(cp, "utf8");
      const config = JSON.parse(raw);
      const model = config.model ?? config.llm?.model ?? config.agents?.defaults?.model;
      if (typeof model === "string" && model.length > 0) {
        return model;
      }
    } catch {
      // Config not found or invalid, continue.
    }
  }
  return undefined;
}

async function ollamaPing(url: string, model: string): Promise<{ content: string }> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      keep_alive: "6h",
      options: { num_predict: 1 },
    });

    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 11434,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve({ content: data.message?.content ?? "" });
          } catch (e: unknown) {
            reject(new Error(`Invalid Ollama response: ${String(e)}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Ollama ping timed out"));
    });
    req.write(body);
    req.end();
  });
}

async function handlePackCommands(
  opts: BenchmarkGemmaCommandOpts,
  runtime: RuntimeEnv,
): Promise<boolean> {
  const requestedRunner = opts.runner;
  const requestedPack = opts.pack;
  const wantsList = Boolean(opts.listPack);
  const wantsValidate = Boolean(opts.validatePack);

  if (!requestedPack && !wantsList && !wantsValidate && !requestedRunner) {
    return false;
  }

  const { BUILTIN_PACKS, builtinPackPath, loadBenchmarkPack } =
    await import("../gemmaclaw/benchmark-kit/index.js");

  const packArg = requestedPack ?? "core";
  let packPath: string;
  const isBuiltin = (BUILTIN_PACKS as readonly string[]).includes(packArg);
  if (isBuiltin) {
    packPath = builtinPackPath(packArg as (typeof BUILTIN_PACKS)[number]);
  } else {
    packPath = path.resolve(packArg);
    if (!fs.existsSync(packPath)) {
      runtime.error(
        `Pack not found: '${packArg}'. Built-in packs: ${BUILTIN_PACKS.join(", ")}, ` +
          `or pass a path to a pack JSON.`,
      );
      runtime.exit(1);
      return true;
    }
  }

  let pack: Awaited<ReturnType<typeof loadBenchmarkPack>>;
  try {
    pack = loadBenchmarkPack(packPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runtime.error(`Pack '${packArg}' failed to validate: ${msg}`);
    runtime.exit(1);
    return true;
  }

  if (wantsValidate) {
    runtime.log(
      `OK: pack '${pack.pack}' v${pack.version} (family=${pack.family}) ` +
        `validates against task-pack-v1. tasks=${pack.tasks.length}`,
    );
    return true;
  }

  if (wantsList) {
    runtime.log(`Pack: ${pack.pack} v${pack.version} (family=${pack.family})`);
    if (pack.description) {
      runtime.log(`Description: ${pack.description}`);
    }
    runtime.log(`Tasks: ${pack.tasks.length}`);
    for (const task of pack.tasks) {
      const max = "max_score" in task.grading ? task.grading.max_score : task.grading.maxScore;
      const difficulty = task.difficulty ?? "?";
      const name = task.name ?? task.id;
      runtime.log(`  - ${task.id} [${difficulty}] (${max} pts) — ${name}`);
    }
    return true;
  }

  if (pack.family === "agent") {
    const normalizedRequestedRunner = normalizeRunnerKind(requestedRunner);
    if (requestedRunner && !normalizedRequestedRunner) {
      runtime.error(
        `Unknown runner '${requestedRunner}'. Valid runners: core-model, agent, mock-agent.`,
      );
      runtime.exit(2);
      return true;
    }
    const desiredRunner = normalizedRequestedRunner ?? "mock-agent";
    if (desiredRunner === "core-model") {
      runtime.error(
        `Agent pack '${pack.pack}' cannot be executed by runner '${desiredRunner}'. ` +
          `Use --runner mock-agent for the built-in deterministic smoke path, ` +
          `or --runner agent from a custom binary that registers a live agent runner.`,
      );
      runtime.exit(2);
      return true;
    }
    const { buildRunner, AgentRunnerNotConfiguredError, writeAgentBenchmarkResults } =
      await import("../gemmaclaw/benchmark-kit/index.js");
    const runner = (() => {
      try {
        return buildRunner(desiredRunner);
      } catch (e) {
        if (e instanceof AgentRunnerNotConfiguredError) {
          runtime.error(
            `Agent pack '${pack.pack}' loaded successfully (${pack.tasks.length} tasks), ` +
              "but no live agent runner is registered in this binary. " +
              "Use the built-in deterministic smoke path with --runner mock-agent, " +
              "or run via a custom binary that calls registerAgentRunner(factory).",
          );
          runtime.exit(2);
          return null;
        }
        throw e;
      }
    })();
    if (!runner) {
      return true;
    }

    const modelSpec =
      opts.model ??
      (desiredRunner === "mock-agent" ? "mock-agent:agent-fixtures" : "agent:default");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputDir =
      opts.outputDir ??
      path.join(
        process.cwd(),
        "benchmark-results",
        `${safePathSegment(pack.pack)}__${safePathSegment(runner.name)}__${safePathSegment(modelSpec)}__${timestamp}`,
      );

    runtime.log("");
    runtime.log("========================================");
    runtime.log("  Gemmaclaw Agent Benchmark");
    runtime.log("========================================");
    runtime.log(`Pack: ${pack.pack} v${pack.version}`);
    runtime.log(`Runner: ${runner.name}`);
    runtime.log(`Model spec: ${modelSpec}`);
    runtime.log(`Tasks: ${pack.tasks.length}`);
    runtime.log(`Output: ${outputDir}`);
    if (desiredRunner === "mock-agent") {
      runtime.log("Mode: deterministic agent smoke (no network, no private runtime)");
    }
    runtime.log("");

    const runResult = await runner.run(pack, {
      modelSpec,
      outDir: outputDir,
      onProgress: (line) => runtime.log(line),
    });
    const files = writeAgentBenchmarkResults(pack, runResult, outputDir);
    const s = files.artifact.summary;

    runtime.log("");
    runtime.log("========================================");
    runtime.log("  AGENT RESULTS");
    runtime.log("========================================");
    runtime.log(`  Pack: ${files.artifact.pack.id}`);
    runtime.log(`  Runner: ${files.artifact.runner.name}`);
    runtime.log(`  Score: ${s.totalScore} / ${s.maxScore} (${s.percentage}%)`);
    runtime.log(`  Pass rate: ${s.passRate}% (${s.passedCount}/${s.passedCount + s.failedCount})`);
    runtime.log(`  JSON: ${files.json}`);
    runtime.log(`  Markdown: ${files.markdown}`);
    runtime.log(`  Dashboard: ${files.html}`);
    runtime.log("========================================");
    return true;
  }

  const normalizedRunner = normalizeRunnerKind(requestedRunner);
  if (requestedRunner && !normalizedRunner) {
    runtime.error(
      `Unknown runner '${requestedRunner}'. Valid runners: core-model, agent, mock-agent.`,
    );
    runtime.exit(2);
    return true;
  }

  if (requestedPack && requestedPack !== "core") {
    runtime.error(
      `Tool-free pack '${pack.pack}' is supported by the loader and v1 schema, ` +
        `but the gemmaclaw benchmark runner currently only executes the built-in ` +
        `'core' pack. Use --list-pack or --validate-pack for now, or run the pack ` +
        `via a custom runner that supports arbitrary tool-free packs.`,
    );
    runtime.exit(2);
    return true;
  }

  if (normalizedRunner && normalizedRunner !== "core-model") {
    runtime.error(
      `Runner '${requestedRunner}' is incompatible with tool-free pack '${pack.pack}'. ` +
        `Use --runner core-model or omit --runner.`,
    );
    runtime.exit(2);
    return true;
  }

  return false;
}

function normalizeRunnerKind(
  raw: string | undefined,
): "core-model" | "agent" | "mock-agent" | null {
  if (!raw) {
    return null;
  }
  if (raw === "core-model" || raw === "agent" || raw === "mock-agent") {
    return raw;
  }
  return null;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

async function llamaCppPing(url: string): Promise<void> {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 8080,
        path: "/health",
        method: "GET",
        timeout: 10_000,
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`llama-server health check returned ${res.statusCode}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("llama-server ping timed out"));
    });
    req.end();
  });
}
